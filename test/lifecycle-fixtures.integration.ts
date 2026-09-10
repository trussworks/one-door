// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { stableUuid } from "../src/seed/stable.ts";
import {
  createVisitor,
  answerClarification,
  executeHandoff,
  resolveRequest,
  saveDraft,
  submitRequest,
  type ActorContext,
} from "../src/workflow/index.ts";
import { dashboardView } from "../src/server/dashboard.ts";
import {
  enrichedRequests,
  type EnrichedRequestRow,
} from "../src/server/read-model.ts";

const ALL_PHASES = [
  "received",
  "review",
  "waiting",
  "approved",
  "delivery",
  "resolved",
] as const;

const runFile = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "DATABASE_URL is not set. Point it at an isolated database this check may write to.",
  );
if (!new URL(url).pathname.startsWith("/one_door_lifecycle"))
  throw new Error(
    "Lifecycle-fixture checks reset and resolve fixtures; point DATABASE_URL at a fresh one_door_lifecycle_* database.",
  );
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function runScript(name: string, args: string[] = []): Promise<void> {
  const script = fileURLToPath(new URL(`scripts/${name}`, repoRoot));
  await runFile(
    process.execPath,
    ["--experimental-strip-types", script, ...args],
    {
      cwd: fileURLToPath(repoRoot),
      env: { ...process.env, DATABASE_URL: url },
    },
  );
}

async function phaseCounts(): Promise<Record<string, number>> {
  const view = await dashboardView();
  const counts: Record<string, number> = {};
  for (const row of view.requests)
    counts[row.phase] = (counts[row.phase] ?? 0) + 1;
  return counts;
}

function assertAllPhases(counts: Record<string, number>, label: string): void {
  for (const phase of ALL_PHASES)
    assert.ok(
      (counts[phase] ?? 0) > 0,
      `${label}: phase ${phase} missing (${JSON.stringify(counts)})`,
    );
}

async function reset(): Promise<void> {
  await runScript("db-reset-fixtures.ts", ["--confirm-fixture-reset"]);
}

// Reset is repeatable: the seeded waiting, delivery, and resolved examples are
// fixture-owned, so the generation-advance step leaves them in place.
async function checkResetRepeatable(): Promise<void> {
  const seeded = await phaseCounts();
  await reset();
  await reset();
  assert.deepEqual(
    await phaseCounts(),
    seeded,
    "phase counts are identical after two resets",
  );
}

async function checkLiveSurvivesReset(): Promise<void> {
  const [org] = await sql<
    { id: string }[]
  >`SELECT id FROM organizations LIMIT 1`;
  const requester = await createVisitor({ displayName: "Live Requester" });
  const draft = await saveDraft(requester, {
    organizationId: org.id,
    rawNeed: "A live office need.",
    content: {
      title: "Live request " + randomUUID().slice(0, 8),
      problem: "A live office need.",
      affectedPeople: "Office staff",
      acceptanceCriteria: ["The need is met"],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready",
  });
  const live = await submitRequest(requester, {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  await reset();
  const [survivor] = await sql<
    { id: string }[]
  >`SELECT id FROM requests WHERE id = ${live.requestId}`;
  assert.ok(survivor, "a live request survives a reset");
}

function contributor(visitor: { actorId: string }): ActorContext {
  return { actorId: visitor.actorId, actingView: "contributor" };
}

async function rowFor(id: string): Promise<EnrichedRequestRow | null> {
  const [row] = await enrichedRequests(undefined, [id]);
  return row ?? null;
}

// An approved example advertises Send the handoff and executeHandoff succeeds,
// because completing a first review seeded an intended handoff.
async function checkApprovedActionable(): Promise<void> {
  const view = await dashboardView();
  const approved = view.requests.find(
    (row) => row.phase === "approved" && row.actionNeeded === "execute_handoff",
  );
  assert.ok(approved, "an approved example advertises Send the handoff");
  const actor = contributor(await createVisitor({ displayName: "Reviewer" }));
  await executeHandoff(actor, { requestId: approved.requestId });
  const after = await rowFor(approved.requestId);
  assert.equal(after?.phase, "delivery", "executeHandoff confirms the handoff");
  const [recorded] = await sql`
    SELECT row_to_json(h) AS payload FROM delivery_handoffs h
    WHERE request_id = ${approved.requestId} AND request_generation = ${approved.fixtureGeneration}`;
  for (let pass = 0; pass < 2; pass++) {
    await reset();
    assert.equal(
      (await rowFor(approved.requestId))?.phase,
      "approved",
      "reset restores an intended handoff after live execution",
    );
  }
  const [retained] = await sql`
    SELECT row_to_json(h) AS payload FROM delivery_handoffs h
    WHERE request_id = ${approved.requestId} AND request_generation = ${approved.fixtureGeneration}`;
  assert.deepEqual(
    retained.payload,
    recorded.payload,
    "the human-confirmed handoff remains unchanged as history",
  );
}

// A live resolution advances the delivery example's generation; a reset restores
// its confirmed handoff at the new generation while the live resolution stays as
// history, repeatably.
async function checkResetAfterLiveResolution(): Promise<void> {
  const deliveryId = stableUuid("request", "lifecycle-delivery");
  const before = await rowFor(deliveryId);
  assert.equal(before?.phase, "delivery", "the delivery example starts here");
  const actor = contributor(await createVisitor({ displayName: "Resolver" }));
  await resolveRequest(actor, {
    requestId: deliveryId,
    outcome: "closed_without_fulfillment",
    summary: "marker-summary",
    reason: "marker-reason",
    expectedRowVersion: before?.rowVersion,
  });
  assert.equal(
    (await rowFor(deliveryId))?.phase,
    "resolved",
    "the live resolution shows before reset",
  );
  for (let pass = 0; pass < 2; pass++) {
    await reset();
    assert.equal(
      (await rowFor(deliveryId))?.phase,
      "delivery",
      "reset restores the delivery example",
    );
  }
  const live = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM request_resolutions
    WHERE request_id = ${deliveryId} AND fixture_key IS NULL`;
  assert.ok(Number(live[0].count) >= 1, "the live resolution stays as history");
}

async function checkResetAfterFixtureAnswer(): Promise<void> {
  const requestId = stableUuid("request", "lifecycle-waiting");
  const requester = await createVisitor({ displayName: "Fixture respondent" });
  // Associate the reference request with this test session to exercise the real ownership gate.
  await sql`UPDATE requests SET owner_visitor_id = ${requester.visitorId} WHERE id = ${requestId}`;
  const before = await rowFor(requestId);
  assert.ok(before);
  const [question] = await sql<{ id: string }[]>`
    SELECT id FROM clarification_requests WHERE request_id = ${requestId}
      AND request_generation = ${before.fixtureGeneration} AND answered_at IS NULL`;
  await answerClarification(requester, {
    requestId,
    clarificationId: question.id,
    answer: "Respondent marker",
    expectedRowVersion: before.rowVersion,
  });
  const [answered] =
    await sql`SELECT row_to_json(q) AS payload FROM clarification_requests q WHERE id = ${question.id}`;
  assert.notEqual((await rowFor(requestId))?.phase, "waiting");
  for (let pass = 0; pass < 2; pass++) {
    await reset();
    assert.equal(
      (await rowFor(requestId))?.phase,
      "waiting",
      "reset restores the reference question after a human answer",
    );
  }
  const [retained] =
    await sql`SELECT row_to_json(q) AS payload FROM clarification_requests q WHERE id = ${question.id}`;
  assert.deepEqual(
    retained.payload,
    answered.payload,
    "the recorded answer survives unchanged",
  );
}

async function main(): Promise<void> {
  await runScript("db-migrate.ts");
  await runScript("db-seed.ts");
  assertAllPhases(await phaseCounts(), "after seed");
  await checkResetRepeatable();
  await checkApprovedActionable();
  await checkResetAfterLiveResolution();
  await checkResetAfterFixtureAnswer();
  await checkLiveSurvivesReset();
  console.log("lifecycle-fixtures checks passed");
}

await main();
await sql.end();
