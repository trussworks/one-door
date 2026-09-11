// Use a fresh isolated DATABASE_URL: migrations and seed persist; constraint probes roll back.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { listRequests } from "../src/db/queries.ts";
import { buildSeedData } from "../src/seed/build.ts";
import { contentHash as seedContentHash } from "../src/seed/stable.ts";

const run = promisify(execFile);

const repoRoot = new URL("../", import.meta.url);
const migrationsDirectory = new URL("migrations/", repoRoot);
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATIONS_TABLE = "_one_door_migrations";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
/** A zero effort trips the score-agreement expression before its own check. */
const DIVISION_BY_ZERO = "22012";
/** ERRCODE raised by the schema's append-only and proposal-protection triggers. */
const IMMUTABLE_VIOLATION = "55000";

const seed = buildSeedData();

/** Every seeded table, paired with the builder array that must fill it. */
const TABLE_ROWS: ReadonlyArray<readonly [string, number]> = [
  ["organizations", seed.organizations.length],
  ["actors", seed.actors.length],
  ["visitors", seed.visitors.length],
  ["wip", seed.wip.length],
  ["audit_events", seed.auditEvents.length],
  ["service_offerings", seed.serviceOfferings.length],
  ["drafts", seed.drafts.length],
  ["model_calls", seed.modelCalls.length],
  ["draft_turns", seed.draftTurns.length],
  ["service_candidates", seed.serviceCandidates.length],
  ["requests", seed.requests.length],
  ["task_completions", seed.taskCompletions.length],
  ["inventory_sources", seed.inventorySources.length],
  ["inventory_sync_runs", seed.inventorySyncRuns.length],
  ["inventory_source_records", seed.inventorySourceRecords.length],
  ["inventory_aliases", seed.inventoryAliases.length],
  ["inventory_conflicts", seed.inventoryConflicts.length],
  ["inventory_conflict_members", seed.inventoryConflictMembers.length],
  ["catalog_items", seed.catalogItems.length],
  ["catalog_field_decisions", seed.catalogFieldDecisions.length],
  ["catalog_item_sources", seed.catalogItemSources.length],
  ["review_tasks", seed.reviewTasks.length],
  ["asset_assessments", seed.assetAssessments.length],
  ["asset_candidates", seed.assetCandidates.length],
  ["asset_candidate_decisions", seed.assetCandidateDecisions.length],
  ["policy_rules", seed.policyRules.length],
  ["risk_assessments", seed.riskAssessments.length],
  ["risk_findings", seed.riskFindings.length],
  ["risk_finding_decisions", seed.riskFindingDecisions.length],
  ["rice_scores", seed.riceScores.length],
  ["work_systems", seed.workSystems.length],
  ["work_sync_runs", seed.workSyncRuns.length],
  ["external_work_items", seed.externalWorkItems.length],
  ["request_work_item_links", seed.requestWorkItemLinks.length],
];

const PAGE_SIZE = 10;
const PAGE_PAST_THE_END = 99;

type Sql = ReturnType<typeof postgres>;

/** Sentinel thrown to abandon an otherwise-successful probe transaction. */
class Rollback extends Error {}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at an isolated database this check may write to.",
    );
  }
  return url;
}

/**
 * Run a repository script against the caller's database.
 *
 * The npm scripts add `--env-file-if-exists=.env`, which would let the
 * repository's own .env override the caller's DATABASE_URL. Spawning node
 * directly, with an explicit environment, removes that possibility.
 */
async function runScript(name: string, url: string): Promise<string> {
  const script = fileURLToPath(new URL(`scripts/${name}`, repoRoot));
  const { stdout } = await run(
    process.execPath,
    ["--experimental-strip-types", script],
    {
      cwd: fileURLToPath(repoRoot),
      env: { ...process.env, DATABASE_URL: url },
    },
  );
  return stdout.trim();
}

/**
 * One hash covering every row of every seeded table. Ordering each row by its
 * full text form keeps the digest independent of physical row order without
 * assuming an `id` column (three tables have composite or natural keys).
 */
async function wholeContentHash(sql: Sql): Promise<string> {
  const perTable: string[] = [];
  for (const [table] of TABLE_ROWS) {
    const [row] = await sql.unsafe<{ digest: string | null }[]>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest FROM ${table} t`,
    );
    perTable.push(`${table}:${row?.digest ?? "empty"}`);
  }
  return createHash("sha256").update(perTable.join("\n")).digest("hex");
}

async function rowCounts(sql: Sql): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const [table] of TABLE_ROWS) {
    const [row] = await sql.unsafe<{ total: string }[]>(
      `SELECT count(*)::text AS total FROM ${table}`,
    );
    counts.set(table, Number(row.total));
  }
  return counts;
}

function assertExpectedCounts(counts: Map<string, number>, when: string): void {
  for (const [table, expected] of TABLE_ROWS) {
    assert.equal(counts.get(table), expected, `${table} count ${when}`);
  }
}

/** Probe failures collected across the run so one execution reports them all. */
const probeFailures: string[] = [];

/**
 * Expect a write to fail with one of the given SQLSTATE codes, inside a
 * transaction that is always rolled back. A miss is recorded, not thrown, so a
 * single run lists every violated contract.
 */
async function expectViolation(
  sql: Sql,
  label: string,
  codes: readonly string[],
  probe: (transaction: Sql) => Promise<unknown>,
): Promise<void> {
  let observed: string | undefined;
  let accepted = false;
  try {
    await sql.begin(async (transaction) => {
      await probe(transaction as unknown as Sql);
      accepted = true;
      throw new Rollback("force rollback");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      observed = (error as { code?: string }).code;
    }
  }
  if (accepted) {
    probeFailures.push(`${label}: the violating statement was accepted`);
  } else if (!observed || !codes.includes(observed)) {
    probeFailures.push(
      `${label}: expected SQLSTATE ${codes.join("/")}, got ${observed ?? "no error"}`,
    );
  }
}

/** Run statements that must succeed, then roll the transaction back. */
async function expectAccepted(
  sql: Sql,
  label: string,
  probe: (transaction: Sql) => Promise<unknown>,
): Promise<void> {
  try {
    await sql.begin(async (transaction) => {
      await probe(transaction as unknown as Sql);
      throw new Rollback("done");
    });
  } catch (error) {
    if (error instanceof Rollback) return;
    throw new Error(
      `${label}: expected the statement to be accepted, got ${String(error)}`,
      { cause: error },
    );
  }
  throw new Error(`${label}: transaction unexpectedly committed`);
}

async function one<T>(sql: Sql, query: string, label: string): Promise<T> {
  const rows = await sql.unsafe<T[]>(query);
  assert.ok(rows.length >= 1, `${label}: no row found`);
  return rows[0];
}

const url = databaseUrl();
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  // ── 1. Migrations ────────────────────────────────────────────────────────
  await runScript("db-migrate.ts", url);
  const secondMigrate = await runScript("db-migrate.ts", url);
  assert.match(secondMigrate, /Applied 0 migration/, "second migrate run");

  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  const ledger = await sql.unsafe<{ name: string; sha256: string }[]>(
    `SELECT name, sha256 FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  assert.deepEqual(
    ledger.map((row) => row.name),
    migrationFiles,
    "ledger lists exactly the migration files on disk",
  );
  for (const row of ledger) {
    const file = await readFile(new URL(row.name, migrationsDirectory), "utf8");
    const digest = createHash("sha256").update(file).digest("hex");
    assert.equal(digest, row.sha256, `ledger hash for ${row.name}`);
  }

  // ── 2. Seed idempotence and fixture manifest ─────────────────────────────
  await runScript("db-seed.ts", url);
  const afterFirstSeed = await wholeContentHash(sql);
  await runScript("db-seed.ts", url);
  const afterSecondSeed = await wholeContentHash(sql);
  assert.equal(afterFirstSeed, afterSecondSeed, "second seed changed content");
  assertExpectedCounts(await rowCounts(sql), "after seeding");

  const manifest = await one<{ content_hash: string }>(
    sql,
    `SELECT content_hash FROM _one_door_fixture_seed WHERE name = 'reference'`,
    "reference manifest",
  );
  assert.equal(
    manifest.content_hash,
    seedContentHash(seed),
    "installed manifest hash equals the builder's hash",
  );

  // ── 3. Semantic joins on the fixture ─────────────────────────────────────
  for (const itemKey of [
    "colorado-azure-landing-zone",
    "azure-devops-delivery-platform",
  ]) {
    await one(
      sql,
      `SELECT id FROM catalog_items
       WHERE item_key = '${itemKey}' AND publication_state = 'published'`,
      `published Azure anchor asset ${itemKey}`,
    );
  }

  const [orphans] = await sql.unsafe<
    { missing_sources: string; missing_fields: string }[]
  >(`
    SELECT
      count(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM catalog_item_sources s WHERE s.catalog_item_id = c.id
      ))::text AS missing_sources,
      count(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM catalog_field_decisions d WHERE d.catalog_item_id = c.id
      ))::text AS missing_fields
    FROM catalog_items c
  `);
  assert.equal(
    Number(orphans.missing_sources),
    0,
    "catalog items without source records",
  );
  assert.equal(
    Number(orphans.missing_fields),
    0,
    "catalog items without field provenance",
  );

  const [completionShape] = await sql.unsafe<
    {
      requester: string;
      contributor: string;
      requests: string;
      completed: string;
    }[]
  >(`
    SELECT
      (SELECT count(*) FROM task_completions WHERE task_type = 'requester_submission')::text AS requester,
      (SELECT count(*) FROM task_completions WHERE task_type = 'contributor_first_review')::text AS contributor,
      (SELECT count(*) FROM requests)::text AS requests,
      (SELECT count(*) FROM requests WHERE stage = 'first_review_completed')::text AS completed
  `);
  assert.equal(
    completionShape.requester,
    completionShape.requests,
    "one requester completion per request",
  );
  assert.equal(
    completionShape.contributor,
    completionShape.completed,
    "one contributor completion per completed first review",
  );

  const [linkShape] = await sql.unsafe<
    { unlinked: string; multi: string; dual_system: string }[]
  >(`
    SELECT
      (SELECT count(*) FROM external_work_items w
        WHERE NOT EXISTS (SELECT 1 FROM request_work_item_links l WHERE l.work_item_id = w.id))::text AS unlinked,
      (SELECT count(*) FROM (
        SELECT 1 FROM request_work_item_links GROUP BY work_item_id HAVING count(*) > 1
      ) m)::text AS multi,
      (SELECT count(*) FROM (
        SELECT l.request_id FROM request_work_item_links l
        JOIN external_work_items w ON w.id = l.work_item_id
        GROUP BY l.request_id HAVING count(DISTINCT w.system) > 1
      ) d)::text AS dual_system
  `);
  assert.ok(
    Number(linkShape.unlinked) >= 1,
    "an unlinked external item exists",
  );
  assert.ok(
    Number(linkShape.multi) >= 1,
    "a multi-request external item exists",
  );
  assert.ok(Number(linkShape.dual_system) >= 1, "a request spans both systems");

  for (const state of ["open", "resolved", "reopened"]) {
    await one(
      sql,
      `SELECT id FROM inventory_conflicts WHERE state = '${state}' LIMIT 1`,
      `an inventory conflict in state ${state}`,
    );
  }
  await one(
    sql,
    `SELECT system FROM work_systems WHERE sync_health = 'failed'`,
    "a failed work system",
  );
  await one(
    sql,
    `SELECT id FROM inventory_source_records WHERE state = 'stale' LIMIT 1`,
    "a stale source record",
  );

  const [selectedShape] = await sql.unsafe<
    { selected: string; joined: string }[]
  >(`
    SELECT
      (SELECT count(*) FROM requests WHERE routing_state = 'service_selected')::text AS selected,
      (SELECT count(*) FROM requests r
        JOIN service_candidates c
          ON c.id = r.selected_service_candidate_id AND c.draft_id = r.source_draft_id)::text AS joined
  `);
  assert.equal(
    selectedShape.selected,
    selectedShape.joined,
    "every selected service candidate belongs to the request's own draft",
  );

  // ── 4. Constraint probes (each rolled back) ──────────────────────────────
  const countsBeforeProbes = await rowCounts(sql);

  const fixtureCompletion = await one<{
    request_id: string;
    actor_id: string;
    task_type: string;
    acting_view: string;
  }>(
    sql,
    `SELECT request_id, actor_id, task_type, acting_view FROM task_completions LIMIT 1`,
    "a fixture task completion",
  );
  await expectViolation(
    sql,
    "duplicate task completion",
    [UNIQUE_VIOLATION],
    (t) =>
      t.unsafe(`
      INSERT INTO task_completions
        (id, request_id, actor_id, task_type, acting_view, rating, origin, idempotency_key)
      VALUES
        ('${randomUUID()}', '${fixtureCompletion.request_id}', '${fixtureCompletion.actor_id}',
         '${fixtureCompletion.task_type}', '${fixtureCompletion.acting_view}', 4, 'fixture',
         '${randomUUID()}')
    `),
  );

  const freshPair = await one<{ request_id: string; actor_id: string }>(
    sql,
    `SELECT r.id AS request_id, a.id AS actor_id
     FROM requests r CROSS JOIN actors a
     WHERE NOT EXISTS (
       SELECT 1 FROM task_completions t
       WHERE t.request_id = r.id AND t.actor_id = a.id
         AND t.task_type = 'requester_submission'
     )
     LIMIT 1`,
    "an actor/request pair with no completion",
  );
  await expectViolation(sql, "rating below 1", [CHECK_VIOLATION], (t) =>
    t.unsafe(`
      INSERT INTO task_completions
        (id, request_id, actor_id, task_type, acting_view, rating, origin, idempotency_key)
      VALUES
        ('${randomUUID()}', '${freshPair.request_id}', '${freshPair.actor_id}',
         'requester_submission', 'requester', 0, 'fixture', '${randomUUID()}')
    `),
  );
  await expectViolation(
    sql,
    "live completion without visitor",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(`
      INSERT INTO task_completions
        (id, request_id, actor_id, task_type, acting_view, rating, origin, idempotency_key)
      VALUES
        ('${randomUUID()}', '${freshPair.request_id}', '${freshPair.actor_id}',
         'requester_submission', 'requester', 4, 'live', '${randomUUID()}')
    `),
  );
  await expectViolation(
    sql,
    "completion for an invented request",
    [FOREIGN_KEY_VIOLATION],
    (t) =>
      t.unsafe(`
      INSERT INTO task_completions
        (id, request_id, actor_id, task_type, acting_view, rating, origin, idempotency_key)
      VALUES
        ('${randomUUID()}', '${randomUUID()}', '${freshPair.actor_id}',
         'requester_submission', 'requester', 4, 'fixture', '${randomUUID()}')
    `),
  );

  const scoredRequest = await one<{ id: string; actor: string }>(
    sql,
    `SELECT r.id, s.reach_actor_id AS actor FROM requests r
     JOIN rice_scores s ON s.request_id = r.id LIMIT 1`,
    "a scored request",
  );
  const riceProbe = () => `
    INSERT INTO rice_scores
      (id, request_id, version, reach, reach_unit, reach_period, reach_rationale, reach_actor_id,
       impact, impact_rationale, impact_actor_id,
       confidence, confidence_rationale, confidence_actor_id,
       effort, effort_rationale, effort_actor_id,
       score, rubric_version, formula_version, created_by_actor_id, origin)
    SELECT '${randomUUID()}', '${scoredRequest.id}', 99,
       400, 'staff members', 'first year', 'probe', '${scoredRequest.actor}',
       2, 'probe', '${scoredRequest.actor}',
       0.8, 'probe', '${scoredRequest.actor}',
       4, 'probe', '${scoredRequest.actor}',
       160, 'rubric-v1', 'rice-v1', '${scoredRequest.actor}', 'fixture'
  `;
  await expectAccepted(sql, "valid rice version insert", (t) =>
    t.unsafe(riceProbe()),
  );
  await expectViolation(
    sql,
    "rice effort of zero",
    [CHECK_VIOLATION, DIVISION_BY_ZERO],
    (t) => t.unsafe(riceProbe().replace("4, 'probe', '", "0, 'probe', '")),
  );
  await expectViolation(
    sql,
    "rice confidence above one",
    [CHECK_VIOLATION],
    (t) => t.unsafe(riceProbe().replace("0.8", "1.5")),
  );
  await expectViolation(
    sql,
    "rice score disagreeing with rice-v1",
    [CHECK_VIOLATION],
    (t) => t.unsafe(riceProbe().replace("160,", "161,")),
  );
  await expectViolation(sql, "rice blank reach unit", [CHECK_VIOLATION], (t) =>
    t.unsafe(riceProbe().replace("'staff members'", "' '")),
  );

  const riskAssessment = await one<{ id: string; rule: string }>(
    sql,
    `SELECT a.id, p.id AS rule FROM risk_assessments a
     CROSS JOIN policy_rules p WHERE a.status = 'succeeded' LIMIT 1`,
    "a succeeded risk assessment and a rule",
  );
  await expectViolation(
    sql,
    "supported risk without severity",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(`
        INSERT INTO risk_findings
          (id, assessment_id, policy_rule_id, kind, evidence, proposed_severity, rationale)
        VALUES
          ('${randomUUID()}', '${riskAssessment.id}', '${riskAssessment.rule}',
           'supported_risk', 'probe evidence', NULL, 'probe')
      `),
  );
  await expectViolation(
    sql,
    "missing information carrying a severity",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(`
        INSERT INTO risk_findings
          (id, assessment_id, policy_rule_id, kind, missing_information, proposed_severity, rationale)
        VALUES
          ('${randomUUID()}', '${riskAssessment.id}', '${riskAssessment.rule}',
           'missing_information', 'probe gap', 'low', 'probe')
      `),
  );

  const fixtureDraft = await one<{ id: string }>(
    sql,
    `SELECT id FROM drafts WHERE fixture_key IS NOT NULL LIMIT 1`,
    "a fixture draft",
  );
  await expectViolation(
    sql,
    "succeeded model call without validated output",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(`
        INSERT INTO model_calls
          (id, draft_id, purpose, provider, model, prompt_version, input_hash,
           corpus_versions, status, reserved_cost_micros, idempotency_key, origin, completed_at)
        VALUES
          ('${randomUUID()}', '${fixtureDraft.id}', 'intake_interpret', 'probe', 'probe',
           'v1', 'probe', '{}', 'succeeded', 0, '${randomUUID()}', 'fixture', now())
      `),
  );
  await expectViolation(
    sql,
    "reserved model call with a completion time",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(`
        INSERT INTO model_calls
          (id, draft_id, purpose, provider, model, prompt_version, input_hash,
           corpus_versions, status, reserved_cost_micros, idempotency_key, origin, completed_at)
        VALUES
          ('${randomUUID()}', '${fixtureDraft.id}', 'intake_interpret', 'probe', 'probe',
           'v1', 'probe', '{}', 'reserved', 0, '${randomUUID()}', 'fixture', now())
      `),
  );

  const turnParts = await one<{
    draft_id: string;
    actor_id: string;
    call_id: string;
  }>(
    sql,
    `SELECT d.id AS draft_id, a.id AS actor_id, m.id AS call_id
     FROM drafts d CROSS JOIN actors a CROSS JOIN model_calls m LIMIT 1`,
    "draft, actor, and model call for a turn probe",
  );
  await expectViolation(
    sql,
    "assistant turn carrying a human actor",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(`
        INSERT INTO draft_turns (id, draft_id, ordinal, actor, actor_id, model_call_id, content)
        VALUES ('${randomUUID()}', '${turnParts.draft_id}', 9999, 'assistant',
                '${turnParts.actor_id}', '${turnParts.call_id}', 'probe')
      `),
  );

  const selectedRequest = await one<{ id: string }>(
    sql,
    `SELECT id FROM requests WHERE routing_state = 'service_selected' LIMIT 1`,
    "a service-selected request",
  );
  await expectViolation(
    sql,
    "service_selected with no selected candidate",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(
        `UPDATE requests SET selected_service_candidate_id = NULL
         WHERE id = '${selectedRequest.id}'`,
      ),
  );

  const foreignCandidate = await one<{
    request_id: string;
    candidate_id: string;
  }>(
    sql,
    `SELECT r.id AS request_id, c.id AS candidate_id
     FROM requests r JOIN service_candidates c ON c.draft_id <> r.source_draft_id
     WHERE r.routing_state = 'service_selected' LIMIT 1`,
    "a candidate from another draft",
  );
  await expectViolation(
    sql,
    "selected candidate from a different draft",
    [FOREIGN_KEY_VIOLATION],
    (t) =>
      t.unsafe(
        `UPDATE requests SET selected_service_candidate_id = '${foreignCandidate.candidate_id}'
         WHERE id = '${foreignCandidate.request_id}'`,
      ),
  );

  const ricePointerPair = await one<{
    request_id: string;
    other_score: string;
  }>(
    sql,
    `SELECT r.id AS request_id, s.id AS other_score
     FROM requests r JOIN rice_scores s ON s.request_id <> r.id
     WHERE r.current_rice_score_id IS NOT NULL LIMIT 1`,
    "a scored request and another request's score",
  );
  await expectViolation(
    sql,
    "current RICE pointer at another request's score",
    [FOREIGN_KEY_VIOLATION],
    (t) =>
      t.unsafe(
        `UPDATE requests SET current_rice_score_id = '${ricePointerPair.other_score}'
         WHERE id = '${ricePointerPair.request_id}'`,
      ),
  );

  const crossDecision = await one<{
    candidate_id: string;
    other_decision: string;
  }>(
    sql,
    `SELECT c.id AS candidate_id, d.id AS other_decision
     FROM asset_candidates c JOIN asset_candidate_decisions d ON d.candidate_id <> c.id
     LIMIT 1`,
    "an asset decision belonging to a different candidate",
  );
  await expectViolation(
    sql,
    "current decision pointer at another candidate's decision",
    [FOREIGN_KEY_VIOLATION],
    (t) =>
      t.unsafe(
        `UPDATE asset_candidates SET current_decision_id = '${crossDecision.other_decision}'
         WHERE id = '${crossDecision.candidate_id}'`,
      ),
  );

  const activeOffering = await one<{
    id: string;
    offering_key: string;
    owner: string;
  }>(
    sql,
    `SELECT id, offering_key, owner_organization_id AS owner
     FROM service_offerings WHERE lifecycle = 'active' LIMIT 1`,
    "an active service offering",
  );
  await expectViolation(
    sql,
    "second active version of one offering key",
    [UNIQUE_VIOLATION],
    (t) =>
      t.unsafe(`
        INSERT INTO service_offerings
          (id, offering_key, version, lifecycle, name, description,
           owner_organization_id, capabilities, prerequisites, review_date, content_hash)
        VALUES
          ('${randomUUID()}', '${activeOffering.offering_key}', 999, 'active', 'probe', 'probe',
           '${activeOffering.owner}', '{}', '{}', '2026-09-01', 'probe')
      `),
  );

  await expectViolation(
    sql,
    "asset rejection without a reason",
    [CHECK_VIOLATION],
    async (t) => {
      const [candidate] = await t.unsafe<{ id: string; actor: string }[]>(
        `SELECT c.id, a.id AS actor FROM asset_candidates c CROSS JOIN actors a LIMIT 1`,
      );
      await t.unsafe(`
        INSERT INTO asset_candidate_decisions (id, candidate_id, decision, actor_id, origin)
        VALUES ('${randomUUID()}', '${candidate.id}', 'rejected', '${candidate.actor}', 'fixture')
      `);
    },
  );
  await expectViolation(
    sql,
    "severity override without a final severity",
    [CHECK_VIOLATION],
    async (t) => {
      const [finding] = await t.unsafe<{ id: string; actor: string }[]>(
        `SELECT f.id, a.id AS actor FROM risk_findings f CROSS JOIN actors a LIMIT 1`,
      );
      await t.unsafe(`
        INSERT INTO risk_finding_decisions (id, finding_id, decision, actor_id, rationale, origin)
        VALUES ('${randomUUID()}', '${finding.id}', 'overridden', '${finding.actor}', 'probe', 'fixture')
      `);
    },
  );
  await expectViolation(
    sql,
    "a confirmed finding cannot carry a different final severity",
    [CHECK_VIOLATION],
    async (t) => {
      const [finding] = await t.unsafe<{ id: string; actor: string }[]>(
        `SELECT f.id, a.id AS actor FROM risk_findings f CROSS JOIN actors a LIMIT 1`,
      );
      await t.unsafe(`
        INSERT INTO risk_finding_decisions (id, finding_id, decision, final_severity, actor_id, origin)
        VALUES ('${randomUUID()}', '${finding.id}', 'confirmed', 'high', '${finding.actor}', 'fixture')
      `);
    },
  );
  await expectViolation(
    sql,
    "follow-up decision with a NULL rationale",
    [CHECK_VIOLATION],
    async (t) => {
      const [finding] = await t.unsafe<{ id: string; actor: string }[]>(
        `SELECT f.id, a.id AS actor FROM risk_findings f CROSS JOIN actors a LIMIT 1`,
      );
      await t.unsafe(`
        INSERT INTO risk_finding_decisions (id, finding_id, decision, actor_id, origin)
        VALUES ('${randomUUID()}', '${finding.id}', 'follow_up_required', '${finding.actor}', 'fixture')
      `);
    },
  );
  await expectViolation(
    sql,
    "rejected service candidate with a NULL reason",
    [CHECK_VIOLATION],
    async (t) => {
      const [candidate] = await t.unsafe<{ id: string; actor: string }[]>(
        `SELECT c.id, a.id AS actor FROM service_candidates c CROSS JOIN actors a LIMIT 1`,
      );
      await t.unsafe(`
        UPDATE service_candidates
        SET decision = 'rejected', decided_by_actor_id = '${candidate.actor}',
            decided_at = now(), decision_reason = NULL
        WHERE id = '${candidate.id}'
      `);
    },
  );
  await expectViolation(
    sql,
    "failed model call with a NULL sanitized error",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(`
        INSERT INTO model_calls
          (id, draft_id, purpose, provider, model, prompt_version, input_hash,
           corpus_versions, status, reserved_cost_micros, idempotency_key, origin, completed_at)
        VALUES
          ('${randomUUID()}', '${fixtureDraft.id}', 'intake_interpret', 'probe', 'probe',
           'v1', 'probe', '{}', 'failed', 0, '${randomUUID()}', 'fixture', now())
      `),
  );
  await expectViolation(
    sql,
    "failed work sync run with a NULL sanitized error",
    [CHECK_VIOLATION],
    (t) =>
      t.unsafe(`
        INSERT INTO work_sync_runs (id, system, status, item_count, started_at, completed_at)
        VALUES ('${randomUUID()}', 'servicenow', 'failed', 0, now(), now())
      `),
  );
  await expectViolation(
    sql,
    "steward field decision with no source and NULL rationale",
    [CHECK_VIOLATION],
    async (t) => {
      const [parts] = await t.unsafe<{ item: string; actor: string }[]>(
        `SELECT c.id AS item, a.id AS actor FROM catalog_items c CROSS JOIN actors a LIMIT 1`,
      );
      await t.unsafe(`
        INSERT INTO catalog_field_decisions
          (id, catalog_item_id, canonical_version, field_name, value, decided_by_actor_id)
        VALUES ('${randomUUID()}', '${parts.item}', 999, 'probe', '"x"', '${parts.actor}')
      `);
    },
  );

  // ── 5. Immutability triggers ─────────────────────────────────────────────
  const immutableProbes: ReadonlyArray<readonly [string, string]> = [
    [
      "audit_events UPDATE",
      `UPDATE audit_events SET event_type = 'probe' WHERE id IN (SELECT id FROM audit_events LIMIT 1)`,
    ],
    [
      "audit_events DELETE",
      `DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events LIMIT 1)`,
    ],
    [
      "draft_turns UPDATE",
      `UPDATE draft_turns SET content = 'probe' WHERE id IN (SELECT id FROM draft_turns LIMIT 1)`,
    ],
    [
      "draft_turns DELETE",
      `DELETE FROM draft_turns WHERE id IN (SELECT id FROM draft_turns LIMIT 1)`,
    ],
    [
      "inventory_source_records UPDATE",
      `UPDATE inventory_source_records SET state = 'stale' WHERE id IN (SELECT id FROM inventory_source_records WHERE state = 'present' LIMIT 1)`,
    ],
    [
      "task_completions UPDATE",
      `UPDATE task_completions SET rating = 5 WHERE id IN (SELECT id FROM task_completions LIMIT 1)`,
    ],
    [
      "task_completions DELETE",
      `DELETE FROM task_completions WHERE id IN (SELECT id FROM task_completions LIMIT 1)`,
    ],
    [
      "rice_scores UPDATE",
      `UPDATE rice_scores SET reach_rationale = 'probe' WHERE id IN (SELECT id FROM rice_scores LIMIT 1)`,
    ],
    [
      "rice_scores DELETE",
      `DELETE FROM rice_scores WHERE id IN (SELECT id FROM rice_scores WHERE id NOT IN (SELECT current_rice_score_id FROM requests WHERE current_rice_score_id IS NOT NULL) LIMIT 1)`,
    ],
    [
      "asset_candidate_decisions UPDATE",
      `UPDATE asset_candidate_decisions SET reason = 'probe' WHERE id IN (SELECT id FROM asset_candidate_decisions LIMIT 1)`,
    ],
    [
      "risk_finding_decisions UPDATE",
      `UPDATE risk_finding_decisions SET rationale = 'probe' WHERE id IN (SELECT id FROM risk_finding_decisions LIMIT 1)`,
    ],
    [
      "catalog_field_decisions UPDATE",
      `UPDATE catalog_field_decisions SET field_name = 'probe' WHERE id IN (SELECT id FROM catalog_field_decisions LIMIT 1)`,
    ],
    [
      "asset_assessments UPDATE",
      `UPDATE asset_assessments SET catalog_corpus_hash = 'probe' WHERE id IN (SELECT id FROM asset_assessments LIMIT 1)`,
    ],
    [
      "risk_assessments DELETE",
      `DELETE FROM risk_assessments WHERE id IN (SELECT id FROM risk_assessments WHERE id NOT IN (SELECT assessment_id FROM risk_findings) LIMIT 1)`,
    ],
    [
      "service_offerings content UPDATE",
      `UPDATE service_offerings SET name = 'probe' WHERE id IN (SELECT id FROM service_offerings LIMIT 1)`,
    ],
    [
      "service_offerings DELETE",
      `DELETE FROM service_offerings WHERE id IN (SELECT id FROM service_offerings WHERE supersedes_id IS NULL LIMIT 1)`,
    ],
    [
      "policy_rules content UPDATE",
      `UPDATE policy_rules SET title = 'probe' WHERE id IN (SELECT id FROM policy_rules LIMIT 1)`,
    ],
    [
      "asset_candidates proposal UPDATE",
      `UPDATE asset_candidates SET rationale = 'probe' WHERE id IN (SELECT id FROM asset_candidates LIMIT 1)`,
    ],
    [
      "asset_candidates DELETE",
      `DELETE FROM asset_candidates WHERE id IN (SELECT id FROM asset_candidates WHERE current_decision_id IS NULL AND id NOT IN (SELECT candidate_id FROM asset_candidate_decisions) LIMIT 1)`,
    ],
    [
      "risk_findings proposal UPDATE",
      `UPDATE risk_findings SET rationale = 'probe' WHERE id IN (SELECT id FROM risk_findings LIMIT 1)`,
    ],
  ];
  for (const [label, statement] of immutableProbes) {
    await expectViolation(sql, label, [IMMUTABLE_VIOLATION], (t) =>
      t.unsafe(statement),
    );
  }

  // Exactly the permitted mutations pass the same triggers.
  await expectAccepted(sql, "offering lifecycle retirement", (t) =>
    t.unsafe(
      `UPDATE service_offerings SET lifecycle = 'retired'
       WHERE id = '${activeOffering.id}'`,
    ),
  );
  await expectAccepted(
    sql,
    "clearing a current decision pointer",
    async (t) => {
      const [candidate] = await t.unsafe<{ id: string }[]>(
        `SELECT id FROM asset_candidates WHERE current_decision_id IS NOT NULL LIMIT 1`,
      );
      await t.unsafe(
        `UPDATE asset_candidates SET current_decision_id = NULL WHERE id = '${candidate.id}'`,
      );
    },
  );

  // ── 6. Visitor ownership ─────────────────────────────────────────────────
  await expectAccepted(sql, "visitor-scoped ownership", async (t) => {
    const [organization] = await t.unsafe<{ id: string }[]>(
      `SELECT id FROM organizations LIMIT 1`,
    );
    const make = async () => {
      const actorId = randomUUID();
      const visitorId = randomUUID();
      await t.unsafe(`
        INSERT INTO actors (id, kind, display_name) VALUES ('${actorId}', 'visitor', 'Probe visitor')
      `);
      await t.unsafe(
        `INSERT INTO visitors (id, actor_id) VALUES ('${visitorId}', '${actorId}')`,
      );
      const draftId = randomUUID();
      await t.unsafe(`
        INSERT INTO drafts
          (id, visitor_id, requester_actor_id, requesting_organization_id,
           raw_need, structured_content, field_origins, state, current_step)
        VALUES
          ('${draftId}', '${visitorId}', '${actorId}', '${organization.id}',
           'probe need', '{}', '{}', 'open', 'describe')
      `);
      return { visitorId, draftId };
    };
    const a = await make();
    const b = await make();
    const mine = await t.unsafe<{ id: string }[]>(
      `SELECT id FROM drafts WHERE visitor_id = '${a.visitorId}'`,
    );
    assert.deepEqual(
      mine.map((row) => row.id),
      [a.draftId],
      "the ownership predicate returns only the owner's drafts",
    );
    const theirs = await t.unsafe<{ id: string }[]>(
      `SELECT id FROM drafts WHERE id = '${b.draftId}' AND visitor_id = '${a.visitorId}'`,
    );
    assert.equal(
      theirs.length,
      0,
      "a guessed id under the wrong visitor returns nothing",
    );

    // wip uniqueness for the same visitor/view/page/subject
    const wipId = randomUUID();
    await t.unsafe(`
      INSERT INTO wip (id, visitor_id, acting_view, page_key, subject_key, payload)
      VALUES ('${wipId}', '${a.visitorId}', 'requester', 'intake', '${a.draftId}', '{}')
    `);
    let wipDuplicate: string | undefined;
    try {
      await t.unsafe(`SAVEPOINT wip_probe`);
      await t.unsafe(`
        INSERT INTO wip (id, visitor_id, acting_view, page_key, subject_key, payload)
        VALUES ('${randomUUID()}', '${a.visitorId}', 'requester', 'intake', '${a.draftId}', '{}')
      `);
    } catch (error) {
      wipDuplicate = (error as { code?: string }).code;
      await t.unsafe(`ROLLBACK TO SAVEPOINT wip_probe`);
    }
    assert.equal(
      wipDuplicate,
      UNIQUE_VIOLATION,
      "duplicate wip slot is rejected",
    );
  });

  // ── 7. listRequests over the fixture ─────────────────────────────────────
  process.env.DATABASE_URL = url;
  const firstPage = await listRequests(1, PAGE_SIZE);
  assert.equal(firstPage.total, seed.requests.length);
  assert.equal(firstPage.items.length, PAGE_SIZE);
  assert.equal(
    firstPage.totalPages,
    Math.ceil(seed.requests.length / PAGE_SIZE),
  );
  const clamped = await listRequests(PAGE_PAST_THE_END, PAGE_SIZE);
  assert.equal(
    clamped.currentPage,
    firstPage.totalPages,
    "page past the end clamps",
  );
  assert.ok(clamped.items.length >= 1, "the clamped page has rows");
  const everything = [
    ...firstPage.items,
    ...(await listRequests(2, PAGE_SIZE)).items,
    ...clamped.items,
  ];
  assert.ok(
    everything.every((item) => item.daysInStage >= 0),
    "no negative time in stage",
  );
  assert.ok(
    everything.every(
      (item) => item.displayId && item.organization && item.requesterName,
    ),
    "every row joins display id, organization, and requester",
  );
  assert.ok(
    everything.some((item) => item.riceScore !== null),
    "a scored request appears in the listing",
  );
  assert.ok(
    everything.some((item) => item.riceScore === null),
    "an unscored request appears in the listing",
  );

  // ── Nothing moved ────────────────────────────────────────────────────────
  assert.deepEqual(
    await rowCounts(sql),
    countsBeforeProbes,
    "a probe changed row counts",
  );
  assert.equal(
    await wholeContentHash(sql),
    afterSecondSeed,
    "a probe changed table content",
  );

  if (probeFailures.length > 0) {
    console.error("Contract violations:");
    for (const failure of probeFailures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    throw new Error(`${probeFailures.length} database contract(s) violated`);
  }

  console.log(
    [
      "Database integration checks passed:",
      `  ${TABLE_ROWS.length} tables at expected counts`,
      "  migrate and seed idempotent; ledger and manifest hashes verified",
      "  constraint, composite-pointer, and immutability probes all rejected",
      "  visitor ownership and listRequests verified; no rows were left behind",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
