// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { buildSeedData } from "../src/seed/build.ts";
import { stableUuid } from "../src/seed/stable.ts";

const run = promisify(execFile);

const repoRoot = new URL("../", import.meta.url);

const IMPORT_RUN_ID = stableUuid("inventory-sync-run", "architecture-20260910");
const IMPORT_SOURCE_VERSION = "2026-09-10";
const IMPORTED_ITEM_KEYS = ["colorado-azure-landing-zone", "notify-stream"];
const ARCHITECTURE_SOURCE_KEY = "inventory-source:architecture-registry";

/** Stable sentinel identities so reruns of this check insert nothing new. */
const SENTINEL_ACTOR_ID = stableUuid("test-sentinel", "actor");
const SENTINEL_VISITOR_ID = stableUuid("test-sentinel", "visitor");
const SENTINEL_DRAFT_ID = stableUuid("test-sentinel", "draft");
const SENTINEL_WIP_ID = stableUuid("test-sentinel", "wip");

const seed = buildSeedData();

const COUNTED_TABLES = [
  "organizations",
  "actors",
  "visitors",
  "wip",
  "audit_events",
  "service_offerings",
  "drafts",
  "model_calls",
  "draft_turns",
  "service_candidates",
  "requests",
  "task_completions",
  "inventory_sources",
  "inventory_sync_runs",
  "inventory_source_records",
  "inventory_aliases",
  "inventory_conflicts",
  "inventory_conflict_members",
  "catalog_items",
  "catalog_field_decisions",
  "catalog_item_sources",
  "review_tasks",
  "asset_assessments",
  "asset_candidates",
  "asset_candidate_decisions",
  "policy_rules",
  "risk_assessments",
  "risk_findings",
  "risk_finding_decisions",
  "rice_scores",
  "work_systems",
  "work_sync_runs",
  "external_work_items",
  "request_work_item_links",
] as const;

type Sql = ReturnType<typeof postgres>;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at an isolated database this check may write to.",
    );
  }
  return url;
}

async function runScript(
  name: string,
  url: string,
  extraArgs: readonly string[] = [],
): Promise<string> {
  const script = fileURLToPath(new URL(`scripts/${name}`, repoRoot));
  const { stdout } = await run(
    process.execPath,
    ["--experimental-strip-types", script, ...extraArgs],
    {
      cwd: fileURLToPath(repoRoot),
      env: { ...process.env, DATABASE_URL: url },
    },
  );
  return stdout.trim();
}

async function rowCounts(sql: Sql): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of COUNTED_TABLES) {
    const [row] = await sql.unsafe<{ total: string }[]>(
      `SELECT count(*)::text AS total FROM ${table}`,
    );
    counts.set(table, Number(row.total));
  }
  return counts;
}

/** Assert that exactly the named tables changed, by exactly the given delta. */
function assertDeltas(
  before: Map<string, number>,
  after: Map<string, number>,
  expected: Readonly<Record<string, number>>,
  when: string,
): void {
  for (const table of COUNTED_TABLES) {
    const delta = (after.get(table) ?? 0) - (before.get(table) ?? 0);
    assert.equal(delta, expected[table] ?? 0, `${table} delta ${when}`);
  }
}

interface SourceState {
  current_sync_run_id: string | null;
  last_successful_epoch: string | null;
  row_version: number;
}

async function architectureSourceState(sql: Sql): Promise<SourceState> {
  const [row] = await sql.unsafe<
    Array<{
      current_sync_run_id: string | null;
      last_successful_epoch: string | null;
      row_version: number;
    }>
  >(
    `SELECT current_sync_run_id,
            extract(epoch FROM last_successful_at)::text AS last_successful_epoch,
            row_version
     FROM inventory_sources WHERE fixture_key = '${ARCHITECTURE_SOURCE_KEY}'`,
  );
  assert.ok(row, "the architecture source exists");
  return row;
}

interface ConflictState {
  state: string;
  reopened_by_run_id: string | null;
  current_evidence_version: number;
}

async function conflictState(
  sql: Sql,
  itemKey: string,
): Promise<ConflictState> {
  const conflictId = stableUuid("inventory-conflict", itemKey);
  const [row] = await sql.unsafe<ConflictState[]>(
    `SELECT state, reopened_by_run_id, current_evidence_version
     FROM inventory_conflicts WHERE id = '${conflictId}'`,
  );
  assert.ok(row, `the conflict for ${itemKey} exists`);
  return row;
}

const url = databaseUrl();
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  // ── 1. Clean database to reference fixture ───────────────────────────────
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  const referenceSource = seed.inventorySources.find(
    (source) => source.fixtureKey === ARCHITECTURE_SOURCE_KEY,
  );
  assert.ok(referenceSource, "the seed defines the architecture source");
  const referenceConflicts = new Map(
    IMPORTED_ITEM_KEYS.map((itemKey) => {
      const conflict = seed.inventoryConflicts.find(
        (row) => row.id === stableUuid("inventory-conflict", itemKey),
      );
      assert.ok(conflict, `the seed defines the conflict for ${itemKey}`);
      return [itemKey, conflict] as const;
    }),
  );

  // ── 2. Live visitor-owned sentinel rows ──────────────────────────────────
  const [anyOrganization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations LIMIT 1`,
  );
  await sql.unsafe(`
    INSERT INTO actors (id, kind, display_name)
    VALUES ('${SENTINEL_ACTOR_ID}', 'visitor', 'Integration sentinel visitor')
    ON CONFLICT (id) DO NOTHING
  `);
  await sql.unsafe(`
    INSERT INTO visitors (id, actor_id)
    VALUES ('${SENTINEL_VISITOR_ID}', '${SENTINEL_ACTOR_ID}')
    ON CONFLICT (id) DO NOTHING
  `);
  await sql.unsafe(`
    INSERT INTO drafts
      (id, visitor_id, requester_actor_id, requesting_organization_id,
       raw_need, structured_content, field_origins, state, current_step)
    VALUES
      ('${SENTINEL_DRAFT_ID}', '${SENTINEL_VISITOR_ID}', '${SENTINEL_ACTOR_ID}',
       '${anyOrganization.id}', 'sentinel need', '{}', '{}', 'open', 'describe')
    ON CONFLICT (id) DO NOTHING
  `);
  await sql.unsafe(`
    INSERT INTO wip (id, visitor_id, acting_view, page_key, subject_key, payload)
    VALUES ('${SENTINEL_WIP_ID}', '${SENTINEL_VISITOR_ID}', 'requester', 'intake',
            '${SENTINEL_DRAFT_ID}', '{"sentinel":true}')
    ON CONFLICT (id) DO NOTHING
  `);

  const sentinelSnapshot = async () =>
    (
      await sql.unsafe<Array<{ row: string }>>(`
        SELECT t::text AS row FROM actors t WHERE id = '${SENTINEL_ACTOR_ID}'
        UNION ALL SELECT t::text FROM visitors t WHERE id = '${SENTINEL_VISITOR_ID}'
        UNION ALL SELECT t::text FROM drafts t WHERE id = '${SENTINEL_DRAFT_ID}'
        UNION ALL SELECT t::text FROM wip t WHERE id = '${SENTINEL_WIP_ID}'
      `)
    ).map((entry) => entry.row);
  const sentinelBefore = await sentinelSnapshot();
  assert.equal(sentinelBefore.length, 4, "all four sentinel rows committed");

  // ── 3. First import ──────────────────────────────────────────────────────
  const [priorRun] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM inventory_sync_runs WHERE id = '${IMPORT_RUN_ID}'`,
  );
  assert.ok(
    !priorRun,
    "this check proves the first import appends, so it needs a database " +
      "that has never run db-import-fixture.ts; supply a fresh one",
  );
  const beforeImport = await rowCounts(sql);
  const sourceBefore = await architectureSourceState(sql);
  const firstImport = await runScript("db-import-fixture.ts", url);
  assert.match(firstImport, /Imported architecture fixture 2026-09-10/);
  const afterImport = await rowCounts(sql);

  assertDeltas(
    beforeImport,
    afterImport,
    {
      inventory_sync_runs: 1,
      inventory_source_records: 2,
      inventory_conflict_members: 4,
      audit_events: 1,
    },
    "after the first import",
  );

  const [importedRun] = await sql.unsafe<
    Array<{ source_version: string; status: string; record_count: number }>
  >(
    `SELECT source_version, status, record_count
     FROM inventory_sync_runs WHERE id = '${IMPORT_RUN_ID}'`,
  );
  assert.ok(importedRun, "the 2026-09-10 run exists");
  assert.equal(importedRun.source_version, IMPORT_SOURCE_VERSION);
  assert.equal(importedRun.status, "succeeded");
  assert.equal(importedRun.record_count, 2);

  for (const itemKey of IMPORTED_ITEM_KEYS) {
    const importedRecordId = stableUuid(
      "inventory-record",
      "architecture-20260910:" + itemKey,
    );
    const [record] = await sql.unsafe<
      Array<{ state: string; prior_record_id: string | null }>
    >(
      `SELECT state, prior_record_id FROM inventory_source_records
       WHERE id = '${importedRecordId}'`,
    );
    assert.ok(record, `the imported record for ${itemKey} exists`);
    assert.equal(record.state, "present");
    assert.equal(
      record.prior_record_id,
      stableUuid("inventory-record", "architecture-20260903:" + itemKey),
      `the imported ${itemKey} record links its 2026-09-03 predecessor`,
    );

    const conflict = await conflictState(sql, itemKey);
    const reference = referenceConflicts.get(itemKey);
    assert.ok(reference);
    assert.equal(conflict.state, "reopened", `${itemKey} conflict reopened`);
    assert.equal(conflict.reopened_by_run_id, IMPORT_RUN_ID);
    assert.equal(
      conflict.current_evidence_version,
      (reference.currentEvidenceVersion ?? 1) + 1,
      `${itemKey} evidence version advanced by one`,
    );
    assert.equal(conflict.current_evidence_version, 2);

    const [memberCount] = await sql.unsafe<{ total: string }[]>(
      `SELECT count(*)::text AS total FROM inventory_conflict_members
       WHERE conflict_id = '${stableUuid("inventory-conflict", itemKey)}'
         AND evidence_version = 2`,
    );
    assert.equal(
      Number(memberCount.total),
      2,
      `${itemKey} has two version-2 members`,
    );
  }

  const sourceAfterImport = await architectureSourceState(sql);
  assert.equal(sourceAfterImport.current_sync_run_id, IMPORT_RUN_ID);
  assert.equal(
    Number(sourceAfterImport.last_successful_epoch),
    Date.parse("2026-09-10T12:00:00.000Z") / 1000,
  );
  assert.equal(sourceAfterImport.row_version, sourceBefore.row_version + 1);

  const [importAudit] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM audit_events
     WHERE event_type = 'inventory_fixture_imported' AND origin = 'system'`,
  );
  assert.equal(Number(importAudit.total), 1, "one import audit event");

  // ── 4. Second import is idempotent ───────────────────────────────────────
  const secondImport = await runScript("db-import-fixture.ts", url);
  assert.match(secondImport, /already matches; no rows changed/);
  assertDeltas(
    afterImport,
    await rowCounts(sql),
    {},
    "after the second import",
  );

  // ── 5. Fixture reset ─────────────────────────────────────────────────────
  const beforeReset = await rowCounts(sql);
  const resetOutput = await runScript("db-reset-fixtures.ts", url, [
    "--confirm-fixture-reset",
  ]);
  assert.match(resetOutput, /Fixture state restored/);
  const afterReset = await rowCounts(sql);

  assertDeltas(beforeReset, afterReset, { audit_events: 1 }, "after the reset");

  const sourceAfterReset = await architectureSourceState(sql);
  assert.equal(
    sourceAfterReset.current_sync_run_id,
    referenceSource.currentSyncRunId ?? null,
    "the source's current-run pointer returned to its reference value",
  );
  assert.equal(
    sourceAfterReset.last_successful_epoch === null
      ? null
      : Number(sourceAfterReset.last_successful_epoch),
    referenceSource.lastSuccessfulAt
      ? Date.parse(referenceSource.lastSuccessfulAt) / 1000
      : null,
    "the source's success time returned to its reference value",
  );

  for (const itemKey of IMPORTED_ITEM_KEYS) {
    const conflict = await conflictState(sql, itemKey);
    const reference = referenceConflicts.get(itemKey);
    assert.ok(reference);
    assert.equal(
      conflict.state,
      reference.state,
      `${itemKey} conflict state reset`,
    );
    assert.equal(
      conflict.reopened_by_run_id,
      reference.reopenedByRunId ?? null,
      `${itemKey} reopened-by pointer reset`,
    );
    assert.equal(
      conflict.current_evidence_version,
      reference.currentEvidenceVersion ?? 1,
      `${itemKey} evidence pointer reset to reference`,
    );
  }

  // Imported evidence and history remain untouched.
  const [evidence] = await sql.unsafe<
    Array<{ runs: string; records: string; members: string; audits: string }>
  >(`
    SELECT
      (SELECT count(*) FROM inventory_sync_runs WHERE id = '${IMPORT_RUN_ID}')::text AS runs,
      (SELECT count(*) FROM inventory_source_records WHERE run_id = '${IMPORT_RUN_ID}')::text AS records,
      (SELECT count(*) FROM inventory_conflict_members WHERE evidence_version = 2)::text AS members,
      (SELECT count(*) FROM audit_events WHERE origin = 'system'
        AND event_type IN ('inventory_fixture_imported', 'fixture_reset_completed'))::text AS audits
  `);
  assert.equal(Number(evidence.runs), 1, "the imported run remains");
  assert.equal(Number(evidence.records), 2, "the imported records remain");
  assert.equal(Number(evidence.members), 4, "the version-2 members remain");
  assert.equal(
    Number(evidence.audits),
    2,
    "import and reset audit events remain",
  );

  assert.deepEqual(
    await sentinelSnapshot(),
    sentinelBefore,
    "the live visitor-owned sentinel rows are byte-identical after both commands",
  );

  // ── 6. Reset refuses without its confirmation flag ───────────────────────
  await assert.rejects(
    runScript("db-reset-fixtures.ts", url),
    /confirm-fixture-reset/,
    "reset without the flag is refused",
  );

  console.log(
    [
      "Fixture-operation checks passed:",
      "  import appended run 2026-09-10 with 2 records, 4 members, 1 audit event",
      "  second import changed nothing",
      "  reset restored source and conflict pointers to reference values",
      "  imported evidence, completions, model calls, audit, and sentinels remain",
      "  reset without --confirm-fixture-reset is refused",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
