// A real pre-owner install, upgraded to the current lifecycle
// seed. The install is produced by that commit's own db-seed, not by rewinding a
// current fixture's manifest, so the upgrade runs against the schema and rows a
// production database actually holds. The checks prove the upgrade preserves a
// human-edited fixture request and a live handoff recorded on an existing
// request, adds the lifecycle examples on new request IDs, and never inserts a
// handoff or resolution that collides on the (request_id, request_generation)
// unique keys of a human-worked request.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { createDatabase } from "../src/db/client.ts";
import { buildSeedData } from "../src/seed/build.ts";
import { upgradeFixtureState } from "../src/seed/fixture-upgrade.ts";
import { contentHash, stableUuid } from "../src/seed/stable.ts";
import { createVisitor } from "../src/workflow/index.ts";
import { dashboardView } from "../src/server/dashboard.ts";
import { baselineFixture } from "./fixture-baseline.ts";

const run = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
// The last commit before delivery owners and lifecycle examples; its seed hash
// is the upgrade's PRE_OWNER_SEED_HASH.
const BASELINE_DIR = baselineFixture("26c0cd748c5a");
const LIFECYCLE_KEYS = [
  "lifecycle-received",
  "lifecycle-waiting",
  "lifecycle-delivery",
  "lifecycle-resolved",
] as const;
const ALL_PHASES = [
  "received",
  "review",
  "waiting",
  "approved",
  "delivery",
  "resolved",
] as const;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("An isolated DATABASE_URL is required");
if (!new URL(url).pathname.startsWith("/one_door_upgrade_lifecycle"))
  throw new Error(
    "Lifecycle-upgrade checks install and upgrade a fixture; point DATABASE_URL at a fresh one_door_upgrade_lifecycle_* database.",
  );
process.env.DATABASE_URL = url;
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function baselineScript(name: string): Promise<void> {
  await run(
    process.execPath,
    ["--experimental-strip-types", "scripts/" + name],
    {
      cwd: BASELINE_DIR,
      env: { ...process.env, DATABASE_URL: url },
    },
  );
}

async function currentScript(name: string, args: string[] = []): Promise<void> {
  await run(
    process.execPath,
    ["--experimental-strip-types", "scripts/" + name, ...args],
    { cwd: workspaceRoot, env: { ...process.env, DATABASE_URL: url } },
  );
}

async function phaseOf(requestId: string): Promise<string | undefined> {
  const view = await dashboardView();
  return view.requests.find((row) => row.requestId === requestId)?.phase;
}

function assertAllPhases(counts: Map<string, number>, label: string): void {
  for (const phase of ALL_PHASES)
    assert.ok(
      (counts.get(phase) ?? 0) > 0,
      label + ": phase " + phase + " missing",
    );
}

async function phaseCounts(): Promise<Map<string, number>> {
  const view = await dashboardView();
  const counts = new Map<string, number>();
  for (const row of view.requests)
    counts.set(row.phase, (counts.get(row.phase) ?? 0) + 1);
  return counts;
}

try {
  await baselineScript("db-migrate.ts");
  await baselineScript("db-seed.ts");
  // Current code needs the current schema; migration 0021 adds the fixture-key
  // columns the lifecycle rows use. The install rows are untouched.
  await currentScript("db-migrate.ts");

  const baselineBuild = await import(
    pathToFileURL(BASELINE_DIR + "/src/seed/build.ts").href
  );
  const baselineStable = await import(
    pathToFileURL(BASELINE_DIR + "/src/seed/stable.ts").href
  );
  const oldHash = baselineStable.contentHash(baselineBuild.buildSeedData());
  const [manifest] = await sql<{ content_hash: string }[]>`
    SELECT content_hash FROM _one_door_fixture_seed WHERE name = 'reference'`;
  assert.equal(
    manifest.content_hash,
    oldHash,
    "the pre-owner install wrote its own manifest",
  );

  const [persona] = await sql<{ id: string }[]>`
    SELECT id FROM actors WHERE kind = 'persona' LIMIT 1`;
  assert.ok(persona);
  const visitor = await createVisitor({ displayName: "Upgrade Human" });

  // A human confirms a live delivery handoff on an existing completed review,
  // recorded at the install's generation with no fixture key. The upgrade must
  // leave it untouched and skip its own seed handoff for that request, or the
  // (request_id, request_generation) unique index would reject the upgrade.
  const [handoffReq] = await sql<{ id: string }[]>`
    SELECT id FROM requests
    WHERE stage = 'first_review_completed' AND fixture_key IS NOT NULL
      AND fixture_key NOT LIKE 'request:lifecycle-%'
    ORDER BY display_id LIMIT 1`;
  assert.ok(handoffReq, "the install has a non-lifecycle completed review");
  assert.equal(await phaseOf(handoffReq.id), "approved", "it starts approved");
  const liveHandoffId = randomUUID();
  await sql`
    INSERT INTO delivery_handoffs
      (id, fixture_key, request_id, target_system, next_owner, work_plan,
       retry_key, status, confirmed_at, request_generation, row_version)
    VALUES (${liveHandoffId}, NULL, ${handoffReq.id}, 'servicenow',
      'Live Owner', ${sql.json([])}, ${"live-handoff:" + randomUUID()},
      'confirmed', now(), 1, 1)`;
  assert.equal(
    await phaseOf(handoffReq.id),
    "delivery",
    "the live handoff moves it to delivery",
  );
  const [liveHandoffBefore] = await sql<{ row: string }[]>`
    SELECT to_jsonb(h)::text AS row FROM delivery_handoffs h
    WHERE id = ${liveHandoffId}`;

  // A human revises an existing scored review; its current state is now unscored
  // and the upgrade must not restore a template score onto it.
  const [revisedReq] = await sql<{ id: string }[]>`
    SELECT id FROM requests
    WHERE fixture_key IS NOT NULL AND stage = 'under_review'
      AND current_rice_score_id IS NOT NULL LIMIT 1`;
  assert.ok(revisedReq, "the install has a scored under-review request");
  const revisionId = randomUUID();
  await sql`
    INSERT INTO request_content_revisions
      (id, request_id, revision_number, content, source,
       authored_by_actor_id, visitor_id)
    SELECT ${revisionId}, id, 1,
      jsonb_build_object('title', title, 'problem', problem,
        'affectedPeople', affected_people, 'acceptanceCriteria',
        acceptance_criteria, 'requirements', requirements, 'constraints',
        constraints, 'unknowns', unknowns),
      'clarification_answer', ${persona.id}, ${visitor.visitorId}
    FROM requests WHERE id = ${revisedReq.id}`;
  await sql`
    UPDATE requests SET current_revision_id = ${revisionId},
      current_rice_score_id = NULL WHERE id = ${revisedReq.id}`;

  // ── Upgrade ──────────────────────────────────────────────────────────────
  const { db, sql: client } = createDatabase();
  const outcome = await upgradeFixtureState(db);
  assert.equal(outcome.status, "upgraded", "the pre-owner install upgrades");
  assert.ok(outcome.insertedRows > 0, "the upgrade appended rows");

  const [liveHandoffAfter] = await sql<{ row: string }[]>`
    SELECT to_jsonb(h)::text AS row FROM delivery_handoffs h
    WHERE id = ${liveHandoffId}`;
  assert.equal(
    liveHandoffAfter.row,
    liveHandoffBefore.row,
    "the human live handoff is unchanged across the upgrade",
  );
  const [handoffRows] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM delivery_handoffs
    WHERE request_id = ${handoffReq.id}`;
  assert.equal(
    handoffRows.count,
    "1",
    "the upgrade added no seed handoff onto the human-worked request",
  );
  assert.equal(
    await phaseOf(handoffReq.id),
    "delivery",
    "the human-worked request keeps its delivery state",
  );

  const [revisedAfter] = await sql<{ rice: string | null }[]>`
    SELECT current_rice_score_id AS rice FROM requests WHERE id = ${revisedReq.id}`;
  assert.equal(
    revisedAfter.rice,
    null,
    "a human-revised request stays unscored after the upgrade",
  );

  // Only the resolved lifecycle example carries a resolution; the upgrade must
  // not declare any existing request fulfilled.
  const lifecycleIds = LIFECYCLE_KEYS.map((key) => stableUuid("request", key));
  const foreignResolutions = await sql<{ request_id: string }[]>`
    SELECT request_id FROM request_resolutions
    WHERE request_id <> ALL(${sql.array(lifecycleIds)}::uuid[])`;
  assert.equal(
    foreignResolutions.length,
    0,
    "no resolution lands on a request outside the lifecycle examples",
  );

  assertAllPhases(await phaseCounts(), "after the upgrade");
  for (const key of LIFECYCLE_KEYS) {
    const id = stableUuid("request", key);
    const phase = await phaseOf(id);
    assert.ok(phase, key + " is present after the upgrade");
  }
  const [owned] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM requests
    WHERE delivery_owner_actor_id IS NOT NULL`;
  assert.ok(Number(owned.count) >= 4, "delivery owners are backfilled");
  const [newManifest] = await sql<{ content_hash: string }[]>`
    SELECT content_hash FROM _one_door_fixture_seed WHERE name = 'reference'`;
  assert.equal(
    newManifest.content_hash,
    contentHash(buildSeedData()),
    "the manifest advanced to the current seed",
  );

  // ── Reset stays repeatable; the live handoff stays as history ────────────
  await currentScript("db-reset-fixtures.ts", ["--confirm-fixture-reset"]);
  await currentScript("db-reset-fixtures.ts", ["--confirm-fixture-reset"]);
  assertAllPhases(await phaseCounts(), "after reset");
  const [liveKept] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM delivery_handoffs
    WHERE id = ${liveHandoffId} AND fixture_key IS NULL AND request_generation = 1`;
  assert.equal(
    liveKept.count,
    "1",
    "the live handoff stays as history after reset",
  );
  assert.equal(
    await phaseOf(handoffReq.id),
    "approved",
    "reset restores the reference state of the human-worked request",
  );
  await client.end();

  console.log(
    "upgrade-lifecycle checks passed: a real pre-owner install gains the " +
      "lifecycle examples by append only, a human live handoff and a human " +
      "revision survive untouched, no resolution lands on an existing request, " +
      "and reset stays repeatable.",
  );
} finally {
  await sql.end();
}
