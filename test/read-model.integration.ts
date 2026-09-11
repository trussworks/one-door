// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { collectCorpus } from "../src/models/corpus.ts";
import { saveWip } from "../src/workflow/wip.ts";
import { getIntakeWorkspace } from "../src/workflow/intake-workspace.ts";

import {
  answerClarification,
  askClarification,
  WorkflowError,
  assignReview,
  completeFirstReview,
  createVisitor,
  executeHandoff,
  getRequestRecord,
  getReviewState,
  recordAssetOutcome,
  recordRouting,
  resetFixtures,
  resolveRequest,
  saveAssetDecision,
  saveDraft,
  saveRiceScore,
  saveRiskDecision,
  submitRequest,
  updateWorkItemStatus,
  type ActorContext,
  type VisitorContext,
} from "../src/workflow/index.ts";
import { dashboardView } from "../src/server/dashboard.ts";
import { defaultWaitThresholds } from "../src/domain/business-days.ts";
import {
  enrichedRequests,
  type EnrichedRequestRow,
} from "../src/server/read-model.ts";
import { myWork } from "../src/server/my-work.ts";
import { queueView } from "../src/server/queue.ts";
import { reportMetrics, reportView } from "../src/server/reports.ts";
import { requestView } from "../src/server/request-views.ts";
import { withReadSnapshot } from "../src/workflow/shared.ts";
import { queueOptions as parseQueueOptions } from "../src/server/query-options.ts";
import { compareValues } from "../src/domain/sorting.ts";
import { actionLabels, phaseLabels } from "../src/ui/status-labels.ts";
import { demoReviewPersona, metadata } from "../src/server/metadata.ts";

const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at an isolated database this check may write to.",
    );
  }
  return url;
}

async function runScript(name: string, url: string): Promise<void> {
  const script = fileURLToPath(new URL(`scripts/${name}`, repoRoot));
  await run(process.execPath, ["--experimental-strip-types", script], {
    cwd: fileURLToPath(repoRoot),
    env: { ...process.env, DATABASE_URL: url },
  });
}

const url = databaseUrl();
process.env.DATABASE_URL = url;
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function submitLive(
  visitor: VisitorContext,
  organizationId: string,
  label: string,
  rating: number,
) {
  const draft = await saveDraft(visitor, {
    organizationId,
    rawNeed: `Need for the ${label} read-model journey.`,
    content: {
      title: `Read-model journey ${label} ${randomUUID().slice(0, 8)}`,
      problem: "The office needs visible request progress.",
      affectedPeople: "Office staff",
      acceptanceCriteria: ["Progress is visible"],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready",
  });
  const submitted = await submitRequest(visitor, {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating,
    idempotencyKey: randomUUID(),
  });
  return { draftId: draft.draftId, requestId: submitted.requestId };
}

async function currentRevisionId(requestId: string): Promise<string> {
  const [row] = await sql.unsafe<{ id: string }[]>(
    `SELECT current_revision_id AS id FROM requests WHERE id = '${requestId}'`,
  );
  assert.ok(row.id, "request has a current revision");
  return row.id;
}

// Assessment rows are append-only (0006 trigger), so a backdated clock must
// be written at insert time.
async function scaffoldAssessments(
  draftId: string,
  revisionId: string,
  createdAtSql = "now()",
  assetModelCallId: string | null = null,
) {
  const assetId = randomUUID();
  const riskId = randomUUID();
  // Approval compares stored corpus hashes with current collectCorpus
  // hashes, so scaffolds record the real hash at insert time. The model
  // call goes in at insert because assessments are immutable afterward.
  const hashes = await withReadSnapshot(async (tx) => ({
    asset: (await collectCorpus(tx, "asset_match")).hash,
    risk: (await collectCorpus(tx, "risk_assess")).hash,
  }));
  const callSql = assetModelCallId ? `'${assetModelCallId}'` : "NULL";
  await sql.unsafe(`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin, revision_id, created_at, model_call_id)
    VALUES ('${assetId}', '${draftId}', 'succeeded', '${hashes.asset}', 'live', '${revisionId}', ${createdAtSql}, ${callSql});
    INSERT INTO risk_assessments
      (id, draft_id, status, policy_corpus_hash, origin, revision_id, created_at)
    VALUES ('${riskId}', '${draftId}', 'succeeded', '${hashes.risk}', 'live', '${revisionId}', ${createdAtSql});
  `);
  return { assetId, riskId };
}

async function scaffoldCandidate(
  assessmentId: string,
  catalogItemId: string,
  catalogVersion: number,
  rank = 1,
): Promise<string> {
  const id = randomUUID();
  await sql.unsafe(`
    INSERT INTO asset_candidates
      (id, assessment_id, catalog_item_id, catalog_version, rank, fit_band,
       coverage, gaps, dependencies, rationale)
    VALUES ('${id}', '${assessmentId}', '${catalogItemId}', ${catalogVersion},
       ${rank}, 'strong', '{}', '{}', '{}', 'scaffolded candidate')
  `);
  return id;
}

async function scaffoldFinding(
  assessmentId: string,
  policyRuleId: string,
): Promise<string> {
  const id = randomUUID();
  await sql.unsafe(`
    INSERT INTO risk_findings
      (id, assessment_id, policy_rule_id, kind, evidence, proposed_severity, rationale)
    VALUES ('${id}', '${assessmentId}', '${policyRuleId}', 'supported_risk',
       'scaffolded evidence', 'moderate', 'scaffolded rationale')
  `);
  return id;
}

const riceFactors = (personaId: string) => ({
  reach: 200,
  reachUnit: "staff",
  reachPeriod: "first year",
  reachRationale: "office headcount",
  reachActorId: personaId,
  impact: 2,
  impactRationale: "removes a manual step",
  impactActorId: personaId,
  confidence: 0.8,
  confidenceRationale: "based on prior rollouts",
  confidenceActorId: personaId,
  effort: 4,
  effortRationale: "one quarter of one team",
  effortActorId: personaId,
});

async function expectCode(
  code: string,
  action: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert.ok(
      error instanceof WorkflowError,
      `${label}: expected WorkflowError, got ${String(error)}`,
    );
    assert.equal(error.code, code, `${label}: wrong code (${error.message})`);
    return;
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`);
}

async function phaseOf(requestId: string): Promise<EnrichedRequestRow> {
  const [row] = await enrichedRequests(defaultWaitThresholds, [requestId]);
  assert.ok(row, "enriched row exists for " + requestId);
  return row;
}

// Seeded examples must read as the application reads them: ordinary
// assessments current against the live corpus, exactly one deliberately
// stale example, and every completed review scored and pinned.
async function checkFixtureCoherence() {
  const hashes = await withReadSnapshot(async (tx) => ({
    asset: (await collectCorpus(tx, "asset_match")).hash,
    risk: (await collectCorpus(tx, "risk_assess")).hash,
  }));
  const staleAssets = await sql.unsafe<{ fixture_key: string }[]>(
    `SELECT fixture_key FROM asset_assessments
     WHERE origin = 'fixture' AND catalog_corpus_hash <> '${hashes.asset}'`,
  );
  assert.deepEqual(
    staleAssets.map((row) => row.fixture_key),
    ["asset-assessment:levee-settlement-imagery:u2"],
    "exactly one seeded asset assessment is deliberately stale",
  );
  const [staleRisks] = await sql.unsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM risk_assessments
     WHERE origin = 'fixture' AND policy_corpus_hash <> '${hashes.risk}'`,
  );
  assert.equal(staleRisks.count, 0, "seeded risk assessments read current");
  const unscored = await sql.unsafe<{ display_id: string }[]>(
    `SELECT display_id FROM requests
     WHERE stage = 'first_review_completed' AND current_rice_score_id IS NULL`,
  );
  assert.deepEqual(
    unscored.map((row) => row.display_id),
    [],
    "every completed review carries a score",
  );
  const unpinned = await sql.unsafe<{ display_id: string }[]>(
    `SELECT r.display_id FROM requests r
     JOIN review_tasks t ON t.request_id = r.id
     WHERE r.stage = 'first_review_completed' AND t.state = 'completed'
       AND t.area IN ('assets', 'risk') AND t.completed_assessment_id IS NULL`,
  );
  assert.deepEqual(
    unpinned.map((row) => row.display_id),
    [],
    "completed areas pin their assessments",
  );
}

// A fresh demo session's "me" queue holds its own work plus the seeded
// examples assigned to the demo review persona — nothing is reassigned,
// no private draft appears, and live requests assigned to the persona
// never sweep into other sessions.
async function checkDemoReviewIdentity(organizationId: string) {
  const persona = await demoReviewPersona();
  assert.ok(persona, "the seeded demo review persona exists");
  assert.equal(persona.name, "Elena Castellanos");
  assert.equal(await demoReviewPersona("actor:not-a-fixture"), null);

  const fresh = await createVisitor();
  const meta = await metadata({
    visitorId: fresh.visitorId,
    actorId: fresh.actorId,
  });
  assert.equal(meta.demoReviewPersona?.actorId, persona.actorId);

  const assignmentsBefore = await sql.unsafe<{ state: string }[]>(
    `SELECT coalesce(coordinating_actor_id::text, '') || ':' || id AS state
     FROM requests ORDER BY id`,
  );
  await saveDraft(fresh, {
    organizationId,
    rawNeed: "A private demo draft that must stay out of every queue.",
  });
  const mine = await queueView(
    parseQueueOptions(new URLSearchParams(), fresh.actorId),
  );
  assert.ok(mine.total > 0, "a fresh session sees a populated me queue");
  const phases = new Set(mine.rows.map((row) => row.phase));
  assert.ok(phases.size >= 2, "the examples span more than one phase");
  assert.ok(
    mine.rows.some((row) => row.score !== null),
    "a scored example is visible",
  );
  for (const row of mine.rows)
    assert.ok(row.fixtureKey, "a fresh session sees seeded examples only");
  assert.ok(
    !mine.rows.some((row) => row.title.includes("private demo draft")),
    "unsubmitted drafts never appear",
  );
  const assignmentsAfter = await sql.unsafe<{ state: string }[]>(
    `SELECT coalesce(coordinating_actor_id::text, '') || ':' || id AS state
     FROM requests ORDER BY id`,
  );
  assert.deepEqual(
    assignmentsAfter.map((row) => row.state),
    assignmentsBefore.map((row) => row.state),
    "the demo scope never writes assignments",
  );

  await checkDemoScopeBoundaries(organizationId, fresh, persona);
}

// A live request assigned to the persona stays out of other sessions' "me";
// an explicit by-actor scope still finds it, and the session's own live
// assignment joins the examples.
async function checkDemoScopeBoundaries(
  organizationId: string,
  fresh: Awaited<ReturnType<typeof createVisitor>>,
  persona: { actorId: string; name: string },
) {
  const owner = await createVisitor();
  const live = await submitLive(owner, organizationId, "demo-scope", 4);
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded'
     WHERE status = 'queued' AND request_id = '${live.requestId}'`,
  );
  await sql.unsafe(
    `UPDATE requests SET coordinating_actor_id = '${persona.actorId}'
     WHERE id = '${live.requestId}'`,
  );
  const meAgain = await queueView(
    parseQueueOptions(new URLSearchParams(), fresh.actorId),
  );
  assert.ok(
    !meAgain.rows.some((row) => row.requestId === live.requestId),
    "a live request assigned to the persona is not in every visitor's me",
  );
  const explicitScope = parseQueueOptions(
    new URLSearchParams({ reviewer: persona.actorId }),
    fresh.actorId,
  );
  const explicit = await queueView(explicitScope);
  assert.ok(
    explicit.rows.some((row) => row.requestId === live.requestId),
    "the complete by-actor scope includes the live request",
  );
  assert.equal(
    explicit.pageCount,
    1,
    "a scope within one page does not paginate",
  );
  assert.equal(
    explicit.rows.length,
    explicit.total,
    "one page carries the whole scope",
  );

  // The session's own live assignment joins the examples.
  const ownWork = await submitLive(owner, organizationId, "own-live", 5);
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded'
     WHERE status = 'queued' AND request_id = '${ownWork.requestId}'`,
  );
  await sql.unsafe(
    `UPDATE requests SET coordinating_actor_id = '${fresh.actorId}'
     WHERE id = '${ownWork.requestId}'`,
  );
  const withOwn = await queueView(
    parseQueueOptions(new URLSearchParams(), fresh.actorId),
  );
  assert.ok(
    withOwn.rows.some((row) => row.requestId === ownWork.requestId),
    "the session's own live assignment remains in me",
  );
  assert.ok(
    withOwn.rows.some((row) => row.fixtureKey),
    "the seeded examples remain alongside own work",
  );
}

// The reviewer card describes the cited catalog version. Current text is
// served only while the cited version is current; after a catalog
// correction the field decisions at or before the cited version
// reconstruct the old text, and a field without provenance stays null.
async function checkCitedCatalogText(organizationId: string, actorId: string) {
  const viewer = await createVisitor();
  const live = await submitLive(viewer, organizationId, "cited-text", 4);
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded'
     WHERE status = 'queued' AND request_id = '${live.requestId}'`,
  );
  const revision = await currentRevisionId(live.requestId);
  const { assetId } = await scaffoldAssessments(live.draftId, revision);
  const [item] = await sql.unsafe<
    { id: string; current_version: number; description: string }[]
  >(
    `SELECT id, current_version, description FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
       AND EXISTS (SELECT 1 FROM catalog_field_decisions d
         WHERE d.catalog_item_id = catalog_items.id
           AND d.field_name = 'description')
     ORDER BY id LIMIT 1`,
  );
  assert.ok(item, "a provenance-bearing catalog item exists");
  await scaffoldCandidate(assetId, item.id, item.current_version);
  const before = await requestView(viewer, live.requestId, false);
  const citedBefore = before.candidates.find(
    (row) => row.catalogItemId === item.id,
  );
  assert.equal(citedBefore?.catalogTextCurrent, true);
  assert.equal(citedBefore?.description, item.description);

  await sql.unsafe(`
    UPDATE catalog_items
    SET description = 'Revised description for the cited-text scaffold.',
      current_version = current_version + 1,
      row_version = row_version + 1
    WHERE id = '${item.id}';
    INSERT INTO catalog_field_decisions
      (id, catalog_item_id, canonical_version, field_name, value,
       decided_by_actor_id, rationale)
    VALUES ('${randomUUID()}', '${item.id}', ${item.current_version + 1},
      'description', '"Revised description for the cited-text scaffold."',
      '${actorId}', 'cited-text scaffold correction')
  `);
  const after = await requestView(viewer, live.requestId, false);
  const cited = after.candidates.find((row) => row.catalogItemId === item.id);
  assert.equal(cited?.catalogTextCurrent, false, "drift is never silent");
  const decisions = await sql.unsafe<{ field_name: string; value: unknown }[]>(
    `SELECT DISTINCT ON (field_name) field_name, value
     FROM catalog_field_decisions
     WHERE catalog_item_id = '${item.id}'
       AND field_name IN ('description', 'capabilities')
       AND canonical_version <= ${item.current_version}
     ORDER BY field_name, canonical_version DESC`,
  );
  const expected = new Map(decisions.map((row) => [row.field_name, row.value]));
  assert.deepEqual(
    cited?.description ?? null,
    expected.get("description") ?? null,
    "the cited version's description is served, or null without provenance",
  );
  assert.deepEqual(
    cited?.capabilities ?? null,
    expected.get("capabilities") ?? null,
    "the cited version's capabilities follow the same contract",
  );
}

/** A succeeded call and job whose corpus snapshot holds the given records. */
async function scaffoldSnapshotJob(
  live: { draftId: string; requestId: string },
  records: unknown[],
): Promise<string> {
  const callId = randomUUID();
  const marker = createHash("sha256")
    .update(`snapshot-cited-${callId}`)
    .digest("hex");
  const snapshot = JSON.stringify({ hash: marker, versions: {}, records });
  await sql.unsafe(`
    INSERT INTO model_calls
      (id, draft_id, purpose, provider, model, prompt_version, input_hash,
       corpus_versions, status, reserved_cost_micros, idempotency_key, origin,
       completed_at, validated_output)
    VALUES ('${callId}', '${live.draftId}', 'asset_match', 'anthropic',
      'claude-scaffold', 'scaffold-v1', '${marker}', '{}', 'succeeded',
      1000, '${marker}', 'live', now(), '{}');
    INSERT INTO model_jobs
      (id, purpose, draft_id, request_id, input_hash, corpus_hash,
       prompt_version, status, current_model_call_id, corpus_snapshot)
    VALUES ('${randomUUID()}', 'asset_match', '${live.draftId}',
      '${live.requestId}', '${marker}', '${marker}', 'scaffold-v1',
      'succeeded', '${callId}', '${snapshot}');
  `);
  return callId;
}

// The producing job's corpus snapshot is the model's actual input: when it
// holds the cited item at the cited version, that text wins over the
// field-decision reconstruction, and a snapshot at another version is
// never borrowed.
async function checkSnapshotCitedText(organizationId: string, actorId: string) {
  const viewer = await createVisitor();
  const live = await submitLive(viewer, organizationId, "snapshot-text", 4);
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded'
     WHERE status = 'queued' AND request_id = '${live.requestId}'`,
  );
  const revision = await currentRevisionId(live.requestId);
  const items = await sql.unsafe<{ id: string; current_version: number }[]>(
    `SELECT id, current_version FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
       AND EXISTS (SELECT 1 FROM catalog_field_decisions d
         WHERE d.catalog_item_id = catalog_items.id
           AND d.field_name = 'description')
     ORDER BY id LIMIT 2`,
  );
  assert.equal(items.length, 2, "two provenance-bearing items exist");
  const [snapItem, borrowItem] = items;
  const snapshotText =
    "Exact model-input description retained by the job snapshot.";
  const wrongVersionText =
    "Different-version text that must never be borrowed.";
  const record = (item: { id: string }, version: number, text: string) => ({
    catalogItemId: item.id,
    version,
    description: text,
    capabilities: [text],
  });
  const callId = await scaffoldSnapshotJob(live, [
    record(snapItem, snapItem.current_version, snapshotText),
    record(borrowItem, borrowItem.current_version + 7, wrongVersionText),
  ]);
  const { assetId } = await scaffoldAssessments(
    live.draftId,
    revision,
    "now()",
    callId,
  );
  await scaffoldCandidate(assetId, snapItem.id, snapItem.current_version);
  await scaffoldCandidate(
    assetId,
    borrowItem.id,
    borrowItem.current_version,
    2,
  );
  for (const item of items)
    await sql.unsafe(`
      UPDATE catalog_items
      SET description = 'Revised after the snapshot scaffold.',
        current_version = current_version + 1,
        row_version = row_version + 1
      WHERE id = '${item.id}';
      INSERT INTO catalog_field_decisions
        (id, catalog_item_id, canonical_version, field_name, value,
         decided_by_actor_id, rationale)
      VALUES ('${randomUUID()}', '${item.id}', ${item.current_version + 1},
        'description', '"Revised after the snapshot scaffold."',
        '${actorId}', 'snapshot scaffold correction')
    `);
  const view = await requestView(viewer, live.requestId, false);
  const snapCited = view.candidates.find(
    (row) => row.catalogItemId === snapItem.id,
  );
  assert.equal(snapCited?.catalogTextCurrent, false);
  assert.equal(
    snapCited?.description,
    snapshotText,
    "the model-input snapshot text wins over the field-decision fallback",
  );
  assert.deepEqual(snapCited?.capabilities, [snapshotText]);
  await checkNeverBorrowed(view, borrowItem, wrongVersionText);
}

async function checkNeverBorrowed(
  view: Awaited<ReturnType<typeof requestView>>,
  borrowItem: { id: string; current_version: number },
  wrongVersionText: string,
) {
  const [decision] = await sql.unsafe<{ value: unknown }[]>(
    `SELECT value FROM catalog_field_decisions
     WHERE catalog_item_id = '${borrowItem.id}' AND field_name = 'description'
       AND canonical_version <= ${borrowItem.current_version}
     ORDER BY canonical_version DESC LIMIT 1`,
  );
  const borrowCited = view.candidates.find(
    (row) => row.catalogItemId === borrowItem.id,
  );
  assert.notEqual(
    borrowCited?.description,
    wrongVersionText,
    "a snapshot at a different version is never borrowed",
  );
  assert.deepEqual(
    borrowCited?.description ?? null,
    decision?.value ?? null,
    "without a version-exact snapshot the field-decision fallback serves",
  );
}

// A clicked heading sorts the whole filtered queue before the page slice,
// overrides the order select, and orders text and numbers in both directions.
async function checkQueueHeadingSort() {
  const heading = (
    key: "title" | "organization" | "action" | "coordinator" | "risk" | "score",
    direction: "asc" | "desc",
  ) => queueView({ heading: { key, direction } });
  const baseline = await heading("title", "asc");
  assert.ok(baseline.total > 5, "enough queue rows to page through");
  assert.ok(baseline.total <= 100, "the baseline holds the whole queue");
  const titles = baseline.rows.map((row) => row.title);
  assert.deepEqual(
    titles,
    [...titles].sort((a, b) => compareValues(a, b, "asc")),
    "titles ascend under the heading sort",
  );
  const descTitles = (await heading("title", "desc")).rows.map(
    (row) => row.title,
  );
  assert.deepEqual(
    descTitles,
    [...descTitles].sort((a, b) => compareValues(a, b, "desc")),
    "titles descend when the heading flips",
  );
  const overridden = await queueView({
    sort: "waiting",
    heading: { key: "title", direction: "asc" },
  });
  assert.deepEqual(
    overridden.rows.map((row) => row.requestId),
    baseline.rows.map((row) => row.requestId),
    "a heading sort overrides the order select",
  );
  await checkQueueHeadingValues(heading);
  await checkQueueCompoundHeadings(heading);
}

// Pagination over the complete filtered and sorted queue: one page holds up
// to 100 rows, fixed 100-row pages past that, a filter reaches rows beyond
// the first page, and an out-of-range page clamps to the last page. Runs
// last because it floods the queue past one page.
async function checkQueuePagination(organizationId: string) {
  const heading = { key: "title", direction: "asc" } as const;
  const before = await queueView({ heading });
  assert.ok(before.total < 100, "the suite starts under one page");
  const flooder = await createVisitor();
  for (let index = before.total; index < 100; index += 1)
    await submitLive(flooder, organizationId, `pageflood-${index}`, 4);

  const atBoundary = await queueView({ heading });
  assert.equal(atBoundary.total, 100, "the flood reaches the boundary");
  assert.equal(atBoundary.pageCount, 1, "one hundred rows stay on one page");
  assert.equal(atBoundary.rows.length, 100, "the single page holds every row");

  await submitLive(flooder, organizationId, "pageflood-overflow", 4);
  const pageOne = await queueView({ heading });
  const pageTwo = await queueView({ heading, page: 2 });
  assert.equal(pageOne.total, 101, "one more row crosses the boundary");
  assert.equal(pageOne.pageCount, 2, "the queue now has two pages");
  assert.equal(pageOne.rows.length, 100, "the first page is full");
  assert.equal(pageTwo.rows.length, 1, "the second page holds the remainder");
  assert.equal(pageTwo.total, pageOne.total, "total is page-independent");
  assert.equal(
    pageTwo.mixedReachBasis,
    pageOne.mixedReachBasis,
    "the Reach-basis warning covers the whole queue, not the visible page",
  );
  const ids = new Set(
    [...pageOne.rows, ...pageTwo.rows].map((row) => row.requestId),
  );
  assert.equal(ids.size, 101, "the pages partition the whole scope");
  const lastOfPageOne = pageOne.rows[pageOne.rows.length - 1];
  assert.ok(
    compareValues(lastOfPageOne.title, pageTwo.rows[0].title, "asc") <= 0,
    "the second page continues the sorted order",
  );

  const beyond = pageTwo.rows[0];
  const filtered = await queueView({ heading, phase: beyond.phase });
  assert.ok(filtered.total <= 100, "the phase filter narrows to one page");
  assert.ok(
    filtered.rows.some((row) => row.requestId === beyond.requestId),
    "a filter reaches a row beyond the first page",
  );

  const clamped = await queueView({ heading, page: 9 });
  assert.equal(clamped.page, 2, "a page past the end clamps to the last page");
  assert.deepEqual(
    clamped.rows.map((row) => row.requestId),
    pageTwo.rows.map((row) => row.requestId),
    "the clamped page serves the last page's rows",
  );
}

// Compound columns order by what the reader sees, in display order:
// requester then agency, and action label then phase label.
async function checkQueueCompoundHeadings(
  heading: (
    key: "organization" | "action",
    direction: "asc" | "desc",
  ) => ReturnType<typeof queueView>,
) {
  const byPair = (pairs: [string, string][], direction: "asc" | "desc") =>
    [...pairs].sort(
      (a, b) =>
        compareValues(a[0], b[0], direction) ||
        compareValues(a[1], b[1], direction),
    );
  const people = (await heading("organization", "asc")).rows.map(
    (row): [string, string] => [row.requesterName, row.organizationName],
  );
  assert.deepEqual(
    people,
    byPair(people, "asc"),
    "requester name orders first, agency breaks ties",
  );
  for (const direction of ["asc", "desc"] as const) {
    const statuses = (await heading("action", direction)).rows.map(
      (row): [string, string] => [
        actionLabels[row.actionNeeded],
        phaseLabels[row.phase],
      ],
    );
    assert.ok(
      new Set(statuses.map(([phase]) => phase)).size > 1,
      "more than one phase label is present",
    );
    assert.deepEqual(
      statuses,
      byPair(statuses, direction),
      `status orders by displayed labels ${direction}, not internal tokens`,
    );
  }
}

// Numeric columns order numerically with unscored rows last in both
// directions, and the coordinator column orders by server-resolved names.
async function checkQueueHeadingValues(
  heading: (
    key: "coordinator" | "score",
    direction: "asc" | "desc",
  ) => ReturnType<typeof queueView>,
) {
  for (const direction of ["asc", "desc"] as const) {
    const scores = (await heading("score", direction)).rows.map(
      (row) => row.score,
    );
    assert.ok(
      scores.some((score) => score === null) &&
        scores.some((score) => score !== null),
      "scored and unscored rows both exist",
    );
    const values = scores.map((score) =>
      score === null ? null : Number(score),
    );
    assert.deepEqual(
      values,
      [...values].sort((a, b) => compareValues(a, b, direction)),
      `scores order ${direction} with unscored rows last`,
    );
  }
  const actorRows = await sql.unsafe<{ id: string; display_name: string }[]>(
    `SELECT id, display_name FROM actors`,
  );
  const names = new Map(actorRows.map((row) => [row.id, row.display_name]));
  const coordinators = (await heading("coordinator", "asc")).rows.map((row) =>
    row.coordinatorActorId ? (names.get(row.coordinatorActorId) ?? null) : null,
  );
  assert.ok(
    coordinators.some((name) => name !== null),
    "assigned coordinators exist",
  );
  assert.deepEqual(
    coordinators,
    [...coordinators].sort((a, b) => compareValues(a, b, "asc")),
    "coordinators order by resolved display name, unassigned last",
  );
}

async function checkDraftTitles(organizationId: string) {
  const owner = await createVisitor();
  const other = await createVisitor();
  const draft = await saveDraft(owner, {
    organizationId,
    rawNeed: "Original description",
    content: { title: "Canonical title" },
  });
  const input = {
    actingView: "requester",
    pageKey: "requester-requirements",
    subjectKey: draft.draftId + ":manual",
    expectedRowVersion: 0,
  };
  const saved = await saveWip(owner, {
    ...input,
    payload: { title: "Renamed saved draft" },
  });
  await saveWip(owner, {
    ...input,
    subjectKey: draft.draftId + ":older-job",
    payload: { title: "Older workspace title" },
  });
  await saveWip(other, {
    ...input,
    payload: { title: "Another visitor's title" },
  });
  const listed = (await myWork(owner)).drafts.find(
    (row) => row.draftId === draft.draftId,
  );
  assert.equal(listed?.displayTitle, "Renamed saved draft");
  assert.equal(listed?.workSavedAt, saved.savedAt);
  assert.equal(
    listed?.content.title,
    "Canonical title",
    "listing does not rewrite request content",
  );
  assert.equal(
    (await myWork(other)).drafts.length,
    0,
    "a matching WIP key does not confer draft ownership",
  );
  const ratingScope = {
    actingView: "requester",
    pageKey: "submit-request",
    subjectKey: draft.draftId,
    expectedRowVersion: 0,
  };
  await saveWip(owner, { ...ratingScope, payload: { rating: "4" } });
  await saveWip(other, { ...ratingScope, payload: { rating: "1" } });
  assert.equal(
    (await getIntakeWorkspace(owner, draft.draftId)).priorSubmissionRating,
    4,
  );
  await saveWip(owner, {
    ...ratingScope,
    expectedRowVersion: 1,
    payload: { rating: "9" },
  });
  assert.equal(
    (await getIntakeWorkspace(owner, draft.draftId)).priorSubmissionRating,
    null,
  );
}

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const personas = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' ORDER BY id LIMIT 2`,
  );
  const reviewerVisitor = await createVisitor();
  const reviewer: ActorContext = {
    actorId: personas[0].id,
    actingView: "contributor",
    visitorId: reviewerVisitor.visitorId,
  };
  const coordinator = personas[1] ?? personas[0];
  const [catalogItem] = await sql.unsafe<
    { id: string; current_version: number }[]
  >(
    `SELECT id, current_version FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     LIMIT 1`,
  );
  const [activeRule] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`,
  );
  assert.ok(catalogItem && activeRule, "seed data present");
  await checkDraftTitles(organization.id);
  await checkFixtureCoherence();
  await checkDemoReviewIdentity(organization.id);
  await checkCitedCatalogText(organization.id, personas[0].id);
  await checkSnapshotCitedText(organization.id, personas[0].id);
  await checkQueueHeadingSort();

  // ── 0. Report baseline for delta assertions ──────────────────────────────
  const baseline = await reportMetrics({ dataset: "live" });

  const alice = await createVisitor();
  const r1 = await submitLive(alice, organization.id, "R1", 5);
  const r2 = await submitLive(alice, organization.id, "R2", 4);

  // ── 1. Received: submitted, assessments still preparing ──────────────────
  let row = await phaseOf(r1.requestId);
  assert.equal(row.phase, "received");
  assert.equal(row.actionNeeded, "wait_for_preparation");
  assert.equal(row.waitingOn, "internal");
  assert.equal(row.phaseSince, row.createdAt, "clock starts at submission");
  assert.equal(row.attention.missingOwner, true, "no coordinator yet");
  assert.equal(row.origin, "live");

  // ── 2. Review: both assessments present for the current revision ─────────
  const rev1 = await currentRevisionId(r1.requestId);
  await scaffoldAssessments(r1.draftId, rev1);
  row = await phaseOf(r1.requestId);
  assert.equal(row.phase, "review");
  assert.equal(row.actionNeeded, "review_assets");
  const reviewSince = row.phaseSince;

  // Assignment and a title edit bump updated_at but never the phase clock.
  await assignReview(reviewer, {
    requestId: r1.requestId,
    coordinatorActorId: coordinator.id,
    assignments: [{ area: "assets", assigneeActorId: reviewer.actorId }],
    expectedRowVersion: row.rowVersion,
  });
  await sql.unsafe(
    `UPDATE requests SET title = title || ' (edited)', updated_at = now()
     WHERE id = '${r1.requestId}'`,
  );
  row = await phaseOf(r1.requestId);
  assert.equal(row.phaseSince, reviewSince, "edits do not reset the clock");
  assert.equal(row.attention.missingOwner, false, "coordinator assigned");

  // ── 3. Waiting on the requester, with the 5-business-day threshold ───────
  const asked = await askClarification(reviewer, {
    requestId: r1.requestId,
    question: "Which office signs off on the data?",
    expectedRowVersion: row.rowVersion,
  });
  row = await phaseOf(r1.requestId);
  assert.equal(row.phase, "waiting");
  assert.equal(row.waitingOn, "requester");
  assert.equal(row.actionNeeded, "wait_for_requester");
  assert.equal(row.overdue, false, "just asked");

  await sql.unsafe(`
    UPDATE requests SET created_at = now() - interval '14 days'
      WHERE id = '${r1.requestId}';
    UPDATE clarification_requests SET asked_at = now() - interval '13 days'
      WHERE id = '${asked.clarificationId}';
  `);
  row = await phaseOf(r1.requestId);
  assert.ok(row.businessDaysInPhase >= 8, "13 calendar days of waiting");
  assert.equal(row.overdue, true, "over the 5-business-day default");
  assert.equal(row.attention.waitingOverdue, true);
  assert.equal(row.attention.unansweredClarification, true);

  // ── 4. The answer returns the request; old assessments are stale ─────────
  const preAnswer = await phaseOf(r1.requestId);
  await answerClarification(alice, {
    requestId: r1.requestId,
    expectedRowVersion: preAnswer.rowVersion,
    clarificationId: asked.clarificationId,
    answer: "The Budget Office signs off.",
  });
  row = await phaseOf(r1.requestId);
  assert.equal(
    row.phase,
    "received",
    "a new revision needs fresh assessments before review",
  );
  assert.equal(row.actionNeeded, "wait_for_preparation");

  // Return-to-review events land exactly 7 calendar days (5 business days)
  // in the past: the answer by update, the assessments at insert time.
  const rev2 = await currentRevisionId(r1.requestId);
  const { assetId, riskId } = await scaffoldAssessments(
    r1.draftId,
    rev2,
    "now() - interval '7 days'",
  );
  const candidateId = await scaffoldCandidate(
    assetId,
    catalogItem.id,
    catalogItem.current_version,
  );
  const findingId = await scaffoldFinding(riskId, activeRule.id);
  await sql.unsafe(`
    UPDATE clarification_requests SET answered_at = now() - interval '7 days'
      WHERE id = '${asked.clarificationId}'
  `);
  row = await phaseOf(r1.requestId);
  assert.equal(row.phase, "review");
  assert.equal(row.businessDaysInPhase, 5, "7 calendar days back in review");
  assert.equal(row.overdue, true, "over the 3-business-day default");
  assert.equal(row.attention.reviewOverdue, true);
  const stableSince = row.phaseSince;

  // Thresholds are configurable: a 10-day internal threshold clears overdue.
  const relaxed = await enrichedRequests(
    { internalBusinessDays: 10, requesterBusinessDays: 10 },
    [r1.requestId],
  );
  assert.equal(relaxed[0].overdue, false, "thresholds change the verdict");
  const echoed = await queueView({
    thresholds: { internalBusinessDays: 10, requesterBusinessDays: 10 },
  });
  assert.equal(echoed.thresholds.internalBusinessDays, 10, "echoed back");

  // ── 5. Decisions advance the action; the clock never moves ───────────────
  let state = await phaseOf(r1.requestId);
  const accepted = await saveAssetDecision(reviewer, {
    requestId: r1.requestId,
    candidateId,
    decision: "accepted",
    expectedRowVersion: state.rowVersion,
  });
  const assetsDone = await recordAssetOutcome(reviewer, {
    requestId: r1.requestId,
    outcome: "accepted",
    expectedRowVersion: accepted.rowVersion,
  });
  row = await phaseOf(r1.requestId);
  assert.equal(row.actionNeeded, "review_risk");
  const confirmed = await saveRiskDecision(reviewer, {
    requestId: r1.requestId,
    findingId,
    decision: "confirmed",
    expectedRowVersion: assetsDone.rowVersion,
  });
  row = await phaseOf(r1.requestId);
  assert.equal(row.actionNeeded, "complete_first_review");
  assert.equal(
    row.priorityPending,
    true,
    "missing priority remains visible without delaying first review",
  );
  assert.equal(
    row.score,
    null,
    "a missing estimate never becomes a zero score",
  );
  await saveRiceScore(reviewer, {
    requestId: r1.requestId,
    ...riceFactors(coordinator.id),
    expectedRowVersion: confirmed.rowVersion,
  });
  row = await phaseOf(r1.requestId);
  assert.equal(row.actionNeeded, "complete_first_review");
  assert.equal(
    row.priorityPending,
    false,
    "recording the complete score settles pending priority",
  );
  assert.equal(row.score !== null && Number(row.score), 80);
  assert.equal(
    row.phaseSince,
    stableSince,
    "a RICE save is not a phase change",
  );

  // ── 6. Queue: filters, sort, pagination ──────────────────────────────────
  // Reruns grow the shared database past one page, so filter checks assert
  // page semantics plus the two known rows' own facts, never page membership.
  const scoredRows = await queueView({ scored: true });
  assert.ok(
    scoredRows.rows.every((entry) => entry.score !== null),
    "scored filter returns only scored rows",
  );
  const unscored = await queueView({ scored: false });
  assert.ok(
    unscored.rows.every((entry) => entry.score === null),
    "unscored filter returns only unscored rows",
  );
  assert.ok(
    unscored.rows.every((entry) => entry.requestId !== r1.requestId),
    "the scored R1 never appears among unscored rows",
  );
  const [r2Row] = await enrichedRequests(defaultWaitThresholds, [r2.requestId]);
  assert.equal(r2Row.score, null, "R2 is unscored and matches that filter");
  const assigneeRows = await queueView({
    assigneeActorId: reviewer.actorId,
  });
  assert.ok(
    assigneeRows.rows.some((entry) => entry.requestId === r1.requestId),
    "area assignee filter finds R1",
  );
  const coordinatorRows = await queueView({
    assigneeActorId: coordinator.id,
  });
  assert.ok(
    coordinatorRows.rows.some((entry) => entry.requestId === r1.requestId),
    "coordinator filter finds R1",
  );
  const byWaiting = await queueView({ sort: "waiting" });
  const byScore = await queueView({ sort: "score" });
  assert.ok(byScore.rows.filter((entry) => entry.score !== null).length >= 2);
  const lastScorePage = await queueView({
    sort: "score",
    page: byScore.pageCount,
  });
  assert.ok(lastScorePage.rows.some((entry) => entry.score === null));
  for (let i = 1; i < byScore.rows.length; i += 1) {
    const previous =
      byScore.rows[i - 1].score === null
        ? -1
        : Number(byScore.rows[i - 1].score);
    const current =
      byScore.rows[i].score === null ? -1 : Number(byScore.rows[i].score);
    assert.ok(
      previous >= current,
      "RICE order is numeric, with unscored requests last",
    );
  }

  for (let i = 1; i < byWaiting.rows.length; i += 1)
    assert.ok(
      byWaiting.rows[i - 1].phaseSince <= byWaiting.rows[i].phaseSince,
      "waiting sort is oldest phase first",
    );
  const wholeQueue = await queueView({});
  assert.ok(wholeQueue.total >= 2, "total counts all matches");
  assert.equal(
    wholeQueue.rows.length,
    wholeQueue.total,
    "one page holds the whole queue while it fits",
  );
  assert.equal(wholeQueue.pageCount, 1, "no pagination under the page size");

  // ── 7. The three role surfaces agree ─────────────────────────────────────
  const own = await myWork(alice);
  const ownRow = own.requests.find(
    (entry) => entry.requestId === r1.requestId,
  ) as (typeof own.requests)[number] & { phase?: string; phaseSince?: string };
  assert.ok(ownRow, "requester sees the request");
  assert.equal(ownRow.phase, row.phase);
  assert.equal(ownRow.phaseSince, row.phaseSince);
  const view = await requestView(alice, r1.requestId, true);
  assert.equal(view.status?.phase, row.phase);
  assert.equal(view.status?.phaseSince, row.phaseSince);
  assert.equal(view.status?.actionNeeded, row.actionNeeded);

  // ── 8. Approval, failed handoff, delivery, blocked sources ───────────────
  state = await phaseOf(r1.requestId);
  const routed = await recordRouting(reviewer, {
    requestId: r1.requestId,
    nextOwner: "OIT Application Services",
    expectedRowVersion: state.rowVersion,
  });
  await completeFirstReview(reviewer, {
    requestId: r1.requestId,
    rating: 4,
    idempotencyKey: randomUUID(),
    targetSystem: "servicenow",
    workPlan: [
      { title: "Provision the environment", relationship: "required" },
      { title: "Notify the office", relationship: "supporting" },
    ],
    expectedRowVersion: routed.rowVersion,
  });
  row = await phaseOf(r1.requestId);
  assert.equal(row.phase, "approved");
  assert.equal(row.actionNeeded, "execute_handoff");
  assert.equal(row.waitingOn, "internal");
  assert.equal(row.overdue, false, "approved carries no overdue clock");

  const failed = await executeHandoff(reviewer, {
    requestId: r1.requestId,
    simulateFailure: true,
  });
  assert.equal(failed.status, "failed");
  row = await phaseOf(r1.requestId);
  assert.equal(row.phase, "approved", "a failed handoff keeps the approval");
  assert.equal(row.actionNeeded, "retry_handoff");
  assert.equal(row.attention.blockedDelivery, true);

  const handedOff = await executeHandoff(reviewer, {
    requestId: r1.requestId,
  });
  assert.equal(handedOff.status, "confirmed");
  row = await phaseOf(r1.requestId);
  assert.equal(row.phase, "delivery");
  assert.equal(row.actionNeeded, "monitor_delivery");
  assert.equal(row.workLinks.length, 2, "both simulated items are linked");

  const required = handedOff.links.find(
    (link) => link.relationship === "required",
  );
  assert.ok(required);
  await updateWorkItemStatus(reviewer, {
    workItemId: required.workItemId,
    sourceStatus: "in progress",
    closed: false,
    syncHealth: "stale",
  });
  row = await phaseOf(r1.requestId);
  assert.equal(row.attention.blockedDelivery, true, "stale source blocks");
  await updateWorkItemStatus(reviewer, {
    workItemId: required.workItemId,
    sourceStatus: "closed",
    closed: true,
    syncHealth: "current",
  });
  row = await phaseOf(r1.requestId);
  assert.equal(row.attention.blockedDelivery, false);
  assert.equal(
    row.actionNeeded,
    "record_outcome",
    "every required item closed on current data",
  );

  // ── 9. Dashboard: one row per request, sources, unlinked work ────────────
  const dashboard = await dashboardView();
  const dashboardRows = dashboard.requests.filter(
    (entry) => entry.requestId === r1.requestId,
  );
  assert.equal(dashboardRows.length, 1, "two links, one request row");
  assert.equal(dashboardRows[0].workLinks.length, 2);
  const linkedIds = new Set(
    dashboardRows[0].workLinks.map((link) => link.workItemId),
  );
  assert.ok(
    dashboard.unlinkedWork.every((item) => !linkedIds.has(item.workItemId)),
    "linked items never appear as unlinked",
  );
  assert.ok(dashboard.sources.workSystems.length >= 1, "work systems listed");
  assert.ok(
    dashboard.sources.inventorySources.every((source) =>
      ["current", "stale", "failed"].includes(source.health),
    ),
    "inventory sources carry computed health",
  );
  assert.equal(
    dashboard.totals.open + dashboard.totals.resolved,
    dashboard.requests.length,
    "totals partition the requests",
  );

  // ── 10. Resolution ends the walk ─────────────────────────────────────────
  const resolved = await resolveRequest(reviewer, {
    requestId: r1.requestId,
    outcome: "fulfilled_reuse",
    summary: "Fulfilled through the existing shared platform.",
    expectedRowVersion: (await phaseOf(r1.requestId)).rowVersion,
  });
  assert.ok(resolved, "resolution recorded");
  row = await phaseOf(r1.requestId);
  assert.equal(row.phase, "resolved");
  assert.equal(row.actionNeeded, "none");
  assert.equal(row.waitingOn, null);
  assert.equal(row.needsAttention, false, "resolved requests need nothing");

  // ── 11. Reports: deltas, cohorts, ranges, datasets ───────────────────────
  const after = await reportMetrics({ dataset: "live" });
  assert.equal(
    after.volume.submissions.count - baseline.volume.submissions.count,
    2,
    "two new submissions",
  );
  assert.ok(after.volume.submissions.requestIds.includes(r1.requestId));
  assert.ok(
    after.requesterSatisfaction.records.some(
      (record) => record.requestId === r1.requestId,
    ),
    "the drilldown names the contributing response",
  );
  assert.equal(
    after.volume.firstReviewsCompleted.count -
      baseline.volume.firstReviewsCompleted.count,
    1,
  );
  assert.equal(
    after.volume.fulfilled.count - baseline.volume.fulfilled.count,
    1,
  );
  assert.equal(
    after.closures.count - baseline.closures.count,
    0,
    "no closure without fulfillment",
  );
  assert.equal(
    after.requesterSatisfaction.responses -
      baseline.requesterSatisfaction.responses,
    2,
  );
  assert.equal(
    after.requesterSatisfaction.satisfied -
      baseline.requesterSatisfaction.satisfied,
    2,
    "ratings 5 and 4 both satisfy",
  );
  assert.equal(after.requesterSatisfaction.target, 0.9);
  assert.equal(
    after.reviewerSatisfaction.responses -
      baseline.reviewerSatisfaction.responses,
    1,
    "reviewer ratings stay separate",
  );
  assert.equal(after.reuse.reuseOnly - baseline.reuse.reuseOnly, 1);
  assert.ok(after.reuse.fulfilledRequestIds.includes(r1.requestId));
  assert.ok(
    after.reuse.reuseRate !== null && after.reuse.reuseRate > 0,
    "reuse rate over fulfilled requests",
  );

  const r1Timing = after.timeToFirstReview.records.find(
    (record) => record.requestId === r1.requestId,
  );
  assert.ok(r1Timing, "R1 entered the first-review cohort today");
  assert.ok(
    r1Timing.seconds > 1_000_000,
    "duration measured from the backdated submission",
  );
  assert.equal(after.timeToFirstReview.startEvent, "request_submitted");
  assert.ok(
    after.timeToFirstReview.records.every(
      (record) => record.requestId !== r2.requestId,
    ),
    "an undecided request has no first review",
  );
  assert.ok(after.timeToFirstReview.medianSeconds !== null);

  const outside = await reportMetrics({
    dataset: "live",
    fromDate: "2000-01-01",
    toDate: "2000-01-02",
  });
  assert.ok(
    !outside.volume.submissions.requestIds.includes(r1.requestId) &&
      outside.requesterSatisfaction.records.every(
        (record) => record.requestId !== r1.requestId,
      ) &&
      !outside.reuse.fulfilledRequestIds.includes(r1.requestId),
    "a past range excludes today's events",
  );

  const seed = await reportMetrics({ dataset: "seed" });
  assert.equal(seed.dataset, "seed");
  assert.ok(
    !seed.volume.submissions.requestIds.includes(r1.requestId),
    "live requests never enter the seed dataset",
  );

  const fullReport = await reportView(alice, { dataset: "live" });
  assert.ok(fullReport.report.requesterSatisfaction, "report block present");
  assert.ok(fullReport.quota, "quota stays separate from the metrics");

  // ── 12. Fixture reset: measured history survives, stale work retires ─────
  const seedBefore = await reportMetrics({ dataset: "seed" });
  const cohortBefore = new Set(
    seedBefore.timeToFirstReview.records.map((record) => record.requestId),
  );
  // Fixture requests carry NULL revision pointers; their evidence matches by
  // the strict NULL-equals-NULL revision rule.
  const [fixture] = await sql.unsafe<
    {
      id: string;
      draft_id: string;
      generation: number;
      created_at: Date;
    }[]
  >(`
    SELECT id, source_draft_id AS draft_id,
      fixture_generation AS generation, created_at
    FROM requests
    WHERE fixture_key IS NOT NULL
    ORDER BY display_id
    LIMIT 1
  `);
  assert.ok(fixture, "a fixture request exists in the seed");
  const baselineRecord =
    seedBefore.timeToFirstReview.records.find(
      (record) => record.requestId === fixture.id,
    ) ?? null;
  const submittedMs = new Date(fixture.created_at).getTime();
  // A live decision one minute before the baseline decision (but after
  // submission) must own the cohort entry only while its generation lasts.
  const baselineMs = baselineRecord
    ? submittedMs + baselineRecord.seconds * 1000
    : Date.now();
  const liveDecisionAt = new Date(
    Math.max(submittedMs + 1000, baselineMs - 60_000),
  ).toISOString();

  const completionId = randomUUID();
  const liveRiceId = randomUUID();
  const liveAssessmentId = randomUUID();
  await sql.unsafe(`
    INSERT INTO task_completions
      (id, request_id, actor_id, visitor_id, task_type, acting_view, rating,
       origin, idempotency_key, request_generation)
    VALUES ('${completionId}', '${fixture.id}', '${reviewer.actorId}',
      '${reviewer.visitorId}', 'contributor_first_review', 'contributor', 5,
      'live', '${randomUUID()}', ${fixture.generation});
    INSERT INTO rice_scores
      (id, request_id, version, reach, reach_unit, reach_period,
       reach_rationale, reach_actor_id, impact, impact_rationale,
       impact_actor_id, confidence, confidence_rationale, confidence_actor_id,
       effort, effort_rationale, effort_actor_id, score, rubric_version,
       formula_version, created_by_actor_id, origin, request_generation,
       created_at)
    VALUES ('${liveRiceId}', '${fixture.id}',
      (SELECT coalesce(max(version), 0) + 1 FROM rice_scores
        WHERE request_id = '${fixture.id}'),
      100, 'staff', 'probe period', 'probe', '${reviewer.actorId}',
      1, 'probe', '${reviewer.actorId}', 0.5, 'probe', '${reviewer.actorId}',
      2, 'probe', '${reviewer.actorId}', 25, 'probe', 'probe',
      '${reviewer.actorId}', 'live', ${fixture.generation},
      '${liveDecisionAt}');
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin, request_generation)
    VALUES ('${liveAssessmentId}', '${fixture.draft_id}', 'succeeded',
      '${(await withReadSnapshot(async (tx) => collectCorpus(tx, "asset_match"))).hash}',
      'live', ${fixture.generation});
  `);

  const liveBefore = await reportMetrics({ dataset: "live" });
  assert.ok(
    liveBefore.reviewerSatisfaction.records.some(
      (record) => record.completionId === completionId,
    ),
    "the live response counts while the generation is current",
  );
  const seedMid = await reportMetrics({ dataset: "seed" });
  const midRecord = seedMid.timeToFirstReview.records.find(
    (record) => record.requestId === fixture.id,
  );
  assert.ok(midRecord, "a current-generation live decision enters the cohort");
  const expectedMidSeconds =
    (new Date(liveDecisionAt).getTime() - submittedMs) / 1000;
  assert.ok(
    Math.abs(midRecord.seconds - expectedMidSeconds) < 1,
    "the live decision now defines the first-decision time",
  );
  const viewBefore = await requestView(alice, fixture.id, false);
  assert.equal(
    viewBefore.assetAssessment?.id,
    liveAssessmentId,
    "the live assessment is current before the reset",
  );

  await resetFixtures(reviewer);
  const [postReset] = await sql.unsafe<{ generation: number }[]>(
    `SELECT fixture_generation AS generation FROM requests
     WHERE id = '${fixture.id}'`,
  );
  assert.equal(
    postReset.generation,
    fixture.generation + 1,
    "live evidence made the reset advance the generation",
  );

  const liveAfter = await reportMetrics({ dataset: "live" });
  assert.equal(
    liveAfter.reviewerSatisfaction.responses,
    liveBefore.reviewerSatisfaction.responses,
    "the reset removed no live survey response",
  );
  const kept = liveAfter.reviewerSatisfaction.records.find(
    (record) => record.completionId === completionId,
  );
  assert.ok(kept, "the response keeps its identity in the drilldown");
  assert.equal(
    kept.requestGeneration,
    fixture.generation,
    "the record names the generation it was given in",
  );

  const seedAfter = await reportMetrics({ dataset: "seed" });
  const afterRecord = seedAfter.timeToFirstReview.records.find(
    (record) => record.requestId === fixture.id,
  );
  if (baselineRecord) {
    assert.ok(
      afterRecord && Math.abs(afterRecord.seconds - baselineRecord.seconds) < 1,
      "the cohort entry reverts to the fixture baseline decision time",
    );
  } else {
    assert.equal(
      afterRecord,
      undefined,
      "the old-generation live decision left the seed cohort",
    );
  }
  for (const requestId of cohortBefore)
    assert.ok(
      seedAfter.timeToFirstReview.records.some(
        (record) => record.requestId === requestId,
      ),
      "fixture baseline decisions survive the reset: " + requestId,
    );
  assert.equal(
    seedAfter.requesterSatisfaction.responses,
    seedBefore.requesterSatisfaction.responses,
    "seed reference responses stay separate and stable",
  );

  const viewAfter = await requestView(alice, fixture.id, false);
  assert.notEqual(
    viewAfter.assetAssessment?.id,
    liveAssessmentId,
    "the old-generation live assessment does not reappear",
  );
  assert.ok(
    viewAfter.assetAssessment === null ||
      viewAfter.assetAssessment.origin === "fixture",
    "what remains current is fixture baseline evidence or nothing",
  );

  // ── 13. One repeatable-read snapshot under a concurrent write ────────────
  const r3 = await submitLive(alice, organization.id, "R3", 5);
  const rev3 = await currentRevisionId(r3.requestId);
  await scaffoldAssessments(r3.draftId, rev3);
  const q3 = await askClarification(reviewer, {
    requestId: r3.requestId,
    question: "Concurrency probe question?",
    expectedRowVersion: (await phaseOf(r3.requestId)).rowVersion,
  });

  const inSnapshot = await withReadSnapshot(async (tx) => {
    const before = await getRequestRecord(r3.requestId, tx);
    // The concurrent writer commits on separate connections while this
    // snapshot stays open: the answer creates a new revision, the RICE save
    // moves the current-score pointer.
    await answerClarification(alice, {
      requestId: r3.requestId,
      expectedRowVersion: before.rowVersion,
      clarificationId: q3.clarificationId,
      answer: "A concurrent answer that changes the revision.",
    });
    const [versionRow] = await sql.unsafe<{ v: number }[]>(
      `SELECT row_version AS v FROM requests WHERE id = '${r3.requestId}'`,
    );
    await saveRiceScore(reviewer, {
      requestId: r3.requestId,
      ...riceFactors(coordinator.id),
      expectedRowVersion: versionRow.v,
    });
    const record2 = await getRequestRecord(r3.requestId, tx);
    const review2 = await getReviewState(r3.requestId, tx);
    const [row2] = await enrichedRequests(
      defaultWaitThresholds,
      [r3.requestId],
      tx,
    );
    return { before, record2, review2, row2 };
  });
  assert.equal(
    inSnapshot.record2.currentRevisionId,
    inSnapshot.before.currentRevisionId,
    "the snapshot pairs the pre-write revision",
  );
  assert.equal(
    inSnapshot.record2.rowVersion,
    inSnapshot.before.rowVersion,
    "the snapshot pairs the pre-write row version",
  );
  assert.equal(
    inSnapshot.review2.currentRiceScoreId,
    null,
    "the snapshot pairs the pre-write score reference",
  );
  assert.equal(
    inSnapshot.row2.phase,
    "waiting",
    "the snapshot still sees the open question",
  );

  const freshRecord = await getRequestRecord(r3.requestId);
  assert.notEqual(
    freshRecord.currentRevisionId,
    inSnapshot.before.currentRevisionId,
    "a fresh read sees the committed writes",
  );
  const freshView = await requestView(alice, r3.requestId, true);
  assert.equal(
    freshView.currentRevisionId,
    freshView.record.currentRevisionId,
    "facts and record come from one snapshot",
  );
  assert.equal(
    freshView.review.currentRiceScoreId,
    freshView.record.currentRiceScoreId,
    "review state and record agree on the score reference",
  );
  assert.equal(
    freshView.scores[0]?.id,
    freshView.record.currentRiceScoreId,
    "the score history contains the referenced score",
  );
  assert.equal(
    freshView.assetAssessment,
    null,
    "stale assessments never pair with the new revision",
  );
  const rev3b = await currentRevisionId(r3.requestId);
  await scaffoldAssessments(r3.draftId, rev3b);
  const pairedView = await requestView(alice, r3.requestId, true);
  assert.equal(
    pairedView.assetAssessment?.revisionId,
    pairedView.record.currentRevisionId,
    "a current assessment pairs with the revision it evaluated",
  );

  // ── 14. Risk in the queue and the Reach-basis warning ────────────────────
  // A fresh coordinator scopes every queue read to this section's rows, so
  // the asserts hold on a shared database and across reruns.
  const rmCoordinator = await createVisitor();
  const qr1 = await submitLive(alice, organization.id, "Q1", 5);
  const qr2 = await submitLive(alice, organization.id, "Q2", 5);
  const qr3 = await submitLive(alice, organization.id, "Q3", 5);
  await sql.unsafe(`
    UPDATE requests SET coordinating_actor_id = '${rmCoordinator.actorId}'
    WHERE id IN ('${qr1.requestId}', '${qr2.requestId}', '${qr3.requestId}')
  `);
  const scoped = { assigneeActorId: rmCoordinator.actorId };

  const qr1Rev = await currentRevisionId(qr1.requestId);
  const qr1Scaffold = await scaffoldAssessments(qr1.draftId, qr1Rev);
  const qr1Moderate = await scaffoldFinding(qr1Scaffold.riskId, activeRule.id);
  const qr1High = randomUUID();
  const qr1Missing = randomUUID();
  await sql.unsafe(`
    INSERT INTO risk_findings
      (id, assessment_id, policy_rule_id, kind, evidence, proposed_severity, rationale)
    VALUES ('${qr1High}', '${qr1Scaffold.riskId}', '${activeRule.id}',
      'supported_risk', 'unencrypted export', 'high', 'a high finding');
    INSERT INTO risk_findings
      (id, assessment_id, policy_rule_id, kind, missing_information, rationale)
    VALUES ('${qr1Missing}', '${qr1Scaffold.riskId}', '${activeRule.id}',
      'missing_information', 'data classification unknown', 'needs facts');
  `);
  await sql.unsafe(`
    INSERT INTO risk_assessments
      (id, draft_id, status, policy_corpus_hash, origin, revision_id, sanitized_error)
    VALUES ('${randomUUID()}', '${qr3.draftId}', 'failed', 'never-ran', 'live',
      '${await currentRevisionId(qr3.requestId)}', 'provider_error')
  `);
  // Submission enqueues preparation; drain it so qr2 reads truly unassessed.
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded' WHERE status = 'queued'`,
  );

  row = await phaseOf(qr1.requestId);
  assert.deepEqual(
    row.risk,
    {
      status: "assessed",
      highestSeverity: "high",
      openFindings: 2,
      missingInformation: 1,
    },
    "risk facts come from the current assessment",
  );
  assert.equal((await phaseOf(qr2.requestId)).risk.status, "unassessed");
  assert.equal(
    (await phaseOf(qr3.requestId)).risk.status,
    "failed",
    "failed preparation is not low risk",
  );

  // Human decisions: an override replaces severity, cleared removes it.
  const qr1Version = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${qr1.requestId}'`,
  );
  await saveRiskDecision(reviewer, {
    requestId: qr1.requestId,
    findingId: qr1High,
    decision: "overridden",
    finalSeverity: "low",
    rationale: "Mitigated by the existing export control.",
    expectedRowVersion: qr1Version[0].v,
  });
  row = await phaseOf(qr1.requestId);
  assert.equal(row.risk.highestSeverity, "moderate", "override honored");

  // A carried-over severity on a non-override decision is unstorable.
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      saveRiskDecision(reviewer, {
        requestId: qr1.requestId,
        findingId: qr1Moderate,
        decision: "confirmed",
        finalSeverity: "high",
        expectedRowVersion: row.rowVersion,
      }),
    "confirmed with a stale severity",
  );
  // A not-applicable ruling needs its documentation.
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      saveRiskDecision(reviewer, {
        requestId: qr1.requestId,
        findingId: qr1Moderate,
        decision: "cleared",
        expectedRowVersion: row.rowVersion,
      }),
    "cleared without a rationale",
  );
  const clearedDone = await saveRiskDecision(reviewer, {
    requestId: qr1.requestId,
    findingId: qr1Moderate,
    decision: "cleared",
    rationale: "The rule does not apply to internal-only data.",
    expectedRowVersion: row.rowVersion,
  });
  row = await phaseOf(qr1.requestId);
  assert.deepEqual(
    row.risk,
    {
      status: "assessed",
      highestSeverity: "low",
      openFindings: 1,
      missingInformation: 1,
    },
    "a cleared finding counts nowhere",
  );

  // A supported risk sent to follow-up is also an information gap.
  const followUpDone = await saveRiskDecision(reviewer, {
    requestId: qr1.requestId,
    findingId: qr1High,
    decision: "follow_up_required",
    rationale: "The export control needs written confirmation.",
    expectedRowVersion: clearedDone.rowVersion,
  });
  row = await phaseOf(qr1.requestId);
  assert.deepEqual(
    row.risk,
    {
      status: "assessed",
      highestSeverity: "high",
      openFindings: 1,
      missingInformation: 2,
    },
    "follow-up keeps the risk open and counts as a gap",
  );
  const gapRows = await queueView({ ...scoped, risk: "information_gap" });
  assert.deepEqual(
    gapRows.rows.map((entry) => entry.requestId),
    [qr1.requestId],
    "the gap filter finds unresolved information",
  );

  // An overridden information gap becomes an open risk at the human severity.
  const missingDone = await saveRiskDecision(reviewer, {
    requestId: qr1.requestId,
    findingId: qr1Missing,
    decision: "overridden",
    finalSeverity: "critical",
    rationale: "The unknown classification is itself a critical exposure.",
    expectedRowVersion: followUpDone.rowVersion,
  });
  row = await phaseOf(qr1.requestId);
  assert.deepEqual(
    row.risk,
    {
      status: "assessed",
      highestSeverity: "critical",
      openFindings: 2,
      missingInformation: 1,
    },
    "the human severity on an information gap counts as open risk",
  );
  await saveRiskDecision(reviewer, {
    requestId: qr1.requestId,
    findingId: qr1High,
    decision: "overridden",
    finalSeverity: "low",
    rationale: "Confirmation arrived; the control stands.",
    expectedRowVersion: missingDone.rowVersion,
  });
  row = await phaseOf(qr1.requestId);
  assert.equal(row.risk.missingInformation, 0, "every gap is resolved");
  assert.equal(
    (await queueView({ ...scoped, risk: "information_gap" })).total,
    0,
  );
  assert.equal(
    row.reviewTasks.find((task) => task.area === "risk")?.state,
    "completed",
    "cleared and overridden rulings settle the risk area",
  );

  // Filter and ordering: severity at-or-above on assessed rows only.
  const lowUp = await queueView({ ...scoped, risk: "low" });
  assert.deepEqual(
    lowUp.rows.map((entry) => entry.requestId),
    [qr1.requestId],
    "severity filters match assessed rows only",
  );
  assert.deepEqual(
    (await queueView({ ...scoped, risk: "high" })).rows.map(
      (entry) => entry.requestId,
    ),
    [qr1.requestId],
    "critical satisfies at-or-above high",
  );
  const unassessed = await queueView({ ...scoped, risk: "unassessed" });
  assert.deepEqual(
    unassessed.rows.map((entry) => entry.requestId).sort(),
    [qr2.requestId, qr3.requestId].sort(),
    "unassessed collects rows without a usable current assessment",
  );
  const byRisk = await queueView({ ...scoped, sort: "risk" });
  assert.deepEqual(
    byRisk.rows.map((entry) => entry.requestId),
    [qr1.requestId, qr3.requestId, qr2.requestId],
    "assessed ranks above failed above unassessed",
  );

  // Reach basis: the flag covers the whole filtered queue, not one page.
  const qr1Score = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${qr1.requestId}'`,
  );
  await saveRiceScore(reviewer, {
    requestId: qr1.requestId,
    ...riceFactors(coordinator.id),
    expectedRowVersion: qr1Score[0].v,
  });
  let basis = await queueView({ ...scoped, scored: true });
  assert.equal(basis.total, 1);
  assert.equal(basis.rows[0].reachUnit, "staff");
  assert.equal(basis.rows[0].reachPeriod, "first year");
  assert.equal(basis.mixedReachBasis, false, "one basis raises no warning");
  const qr2Score = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${qr2.requestId}'`,
  );
  await saveRiceScore(reviewer, {
    requestId: qr2.requestId,
    ...riceFactors(coordinator.id),
    reach: 900,
    reachUnit: "residents",
    reachPeriod: "per month",
    expectedRowVersion: qr2Score[0].v,
  });
  basis = await queueView({ ...scoped, scored: true });
  assert.equal(basis.mixedReachBasis, true, "unlike bases raise the warning");
  basis = await queueView({ ...scoped, scored: true, sort: "score" });
  assert.equal(basis.rows.length, 2);
  assert.equal(basis.total, 2);
  assert.equal(
    basis.mixedReachBasis,
    true,
    "the warning covers the whole filtered queue",
  );

  // A new revision retires the assessment: qr1 stops ranking as current.
  const qr1Ask = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${qr1.requestId}'`,
  );
  const qr1Asked = await askClarification(reviewer, {
    requestId: qr1.requestId,
    question: "Which offices export the data?",
    expectedRowVersion: qr1Ask[0].v,
  });
  const [qr1Open] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM clarification_requests
     WHERE request_id = '${qr1.requestId}' AND answered_at IS NULL`,
  );
  await answerClarification(alice, {
    requestId: qr1.requestId,
    clarificationId: qr1Open.id,
    answer: "Only the records office exports it.",
    contentChanges: { problem: "Revised after the export answer." },
    expectedRowVersion: qr1Asked.rowVersion,
  });
  row = await phaseOf(qr1.requestId);
  assert.equal(
    row.risk.status,
    "preparing",
    "an obsolete assessment never ranks as current",
  );
  assert.equal((await queueView({ ...scoped, risk: "low" })).total, 0);

  // The decisions bind to the current revision: after the answer revised
  // the request, a ruling on the retired assessment's finding is refused.
  const qr1Latest = await phaseOf(qr1.requestId);
  await expectCode(
    "INVALID_STATE",
    () =>
      saveRiskDecision(reviewer, {
        requestId: qr1.requestId,
        findingId: qr1High,
        decision: "confirmed",
        expectedRowVersion: qr1Latest.rowVersion,
      }),
    "a ruling on an obsolete assessment",
  );

  // Cleared and overridden-gap rulings carry through the approval gate.
  const qr4 = await submitLive(alice, organization.id, "Q4", 5);
  const qr4Scaffold = await scaffoldAssessments(
    qr4.draftId,
    await currentRevisionId(qr4.requestId),
  );
  const qr4Supported = await scaffoldFinding(qr4Scaffold.riskId, activeRule.id);
  const qr4Missing = randomUUID();
  await sql.unsafe(`
    INSERT INTO risk_findings
      (id, assessment_id, policy_rule_id, kind, missing_information, rationale)
    VALUES ('${qr4Missing}', '${qr4Scaffold.riskId}', '${activeRule.id}',
      'missing_information', 'retention period unknown', 'needs facts')
  `);
  const qr4Cleared = await saveRiskDecision(reviewer, {
    requestId: qr4.requestId,
    findingId: qr4Supported,
    decision: "cleared",
    rationale: "The moderated risk does not apply to this office.",
    expectedRowVersion: (await phaseOf(qr4.requestId)).rowVersion,
  });
  const qr4Gap = await saveRiskDecision(reviewer, {
    requestId: qr4.requestId,
    findingId: qr4Missing,
    decision: "overridden",
    finalSeverity: "moderate",
    rationale: "Unknown retention is a moderate exposure until answered.",
    expectedRowVersion: qr4Cleared.rowVersion,
  });
  const qr4Assets = await recordAssetOutcome(reviewer, {
    requestId: qr4.requestId,
    outcome: "no_match",
    expectedRowVersion: qr4Gap.rowVersion,
  });
  const qr4Scored = await saveRiceScore(reviewer, {
    requestId: qr4.requestId,
    ...riceFactors(coordinator.id),
    expectedRowVersion: qr4Assets.rowVersion,
  });
  const qr4Routed = await recordRouting(reviewer, {
    requestId: qr4.requestId,
    nextOwner: "OIT Application Services",
    expectedRowVersion: qr4Scored.rowVersion,
  });
  const qr4Done = await completeFirstReview(reviewer, {
    requestId: qr4.requestId,
    rating: 4,
    idempotencyKey: randomUUID(),
    targetSystem: "servicenow",
    workPlan: [],
    expectedRowVersion: qr4Routed.rowVersion,
  });
  assert.equal(qr4Done.stage, "first_review_completed");
  row = await phaseOf(qr4.requestId);
  assert.equal(row.phase, "approved", "the settled rulings pass approval");
  assert.equal(row.risk.highestSeverity, "moderate");
  assert.equal(row.risk.missingInformation, 0);

  const assigned = await assignReview(reviewer, {
    requestId: r3.requestId,
    expectedRowVersion: (await getRequestRecord(r3.requestId)).rowVersion,
    coordinatorActorId: coordinator.id,
    assignments: [{ area: "risk", assigneeActorId: coordinator.id }],
  });
  await assignReview(reviewer, {
    requestId: r3.requestId,
    expectedRowVersion: assigned.rowVersion,
    coordinatorActorId: null,
    assignments: [{ area: "risk", assigneeActorId: null }],
  });
  const cleared = await getReviewState(r3.requestId);
  assert.equal(
    cleared.coordinatingActorId,
    null,
    "clearing an assignment persists",
  );
  assert.equal(
    cleared.tasks.find((task) => task.area === "risk")?.assigneeActorId,
    null,
  );

  // ── 15. The unassigned reviewer scope ────────────────────────────────────
  // reviewer=unassigned maps to its own option and never reaches the
  // by-actor branch, whose value must be a UUID.
  const mapActor = randomUUID();
  assert.deepEqual(
    parseQueueOptions(new URLSearchParams("reviewer=unassigned"), mapActor),
    { unassigned: true, sort: "waiting", page: 1 },
  );
  assert.equal(
    parseQueueOptions(new URLSearchParams(""), mapActor).assigneeActorId,
    mapActor,
    "reviewer defaults to me",
  );
  assert.equal(
    parseQueueOptions(new URLSearchParams("reviewer=all"), mapActor)
      .assigneeActorId,
    undefined,
  );
  assert.equal(
    parseQueueOptions(
      new URLSearchParams(`reviewer=${coordinator.id}`),
      mapActor,
    ).assigneeActorId,
    coordinator.id,
    "a person keeps the by-actor scope",
  );

  // u1 has no coordinator but a task assignee: still unassigned. u2 has a
  // coordinator: assigned.
  const u1 = await submitLive(alice, organization.id, "U1", 5);
  const u2 = await submitLive(alice, organization.id, "U2", 5);
  const u1Assigned = await assignReview(reviewer, {
    requestId: u1.requestId,
    expectedRowVersion: (await getRequestRecord(u1.requestId)).rowVersion,
    assignments: [{ area: "risk", assigneeActorId: coordinator.id }],
  });
  assert.ok(u1Assigned.rowVersion, "task assignment without a coordinator");
  await assignReview(reviewer, {
    requestId: u2.requestId,
    expectedRowVersion: (await getRequestRecord(u2.requestId)).rowVersion,
    coordinatorActorId: coordinator.id,
  });

  // Exactly the rows without a coordinator, per the database itself.
  const expectedUnassigned = (
    await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM requests
       WHERE fixture_key IS NULL AND coordinating_actor_id IS NULL`,
    )
  )
    .map((row) => row.id)
    .sort();
  const unassignedView = await queueView({
    unassigned: true,
    origin: "live",
  });
  assert.deepEqual(
    unassignedView.rows.map((entry) => entry.requestId).sort(),
    expectedUnassigned,
    "the unassigned scope returns exactly the coordinator-less rows",
  );
  assert.ok(
    unassignedView.rows.some((entry) => entry.requestId === u1.requestId),
    "a task assignee does not make a request assigned",
  );
  assert.ok(
    unassignedView.rows.every((entry) => entry.requestId !== u2.requestId),
    "a coordinator removes the row from the unassigned scope",
  );

  // Combinations preserve the other filters.
  const unassignedApproved = await queueView({
    unassigned: true,
    origin: "live",
    phase: "approved",
  });
  assert.ok(
    unassignedApproved.rows.some((entry) => entry.requestId === qr4.requestId),
    "unassigned combines with the phase filter",
  );
  assert.ok(
    unassignedApproved.rows.every(
      (entry) =>
        entry.phase === "approved" && entry.coordinatorActorId === null,
    ),
    "every combined row satisfies both filters",
  );
  const unassignedByTask = await queueView({
    unassigned: true,
    assigneeActorId: coordinator.id,
    origin: "live",
  });
  assert.ok(
    unassignedByTask.rows.some((entry) => entry.requestId === u1.requestId),
    "unassigned with by-actor narrows to coordinator-less task work",
  );
  assert.ok(
    unassignedByTask.rows.every(
      (entry) =>
        entry.coordinatorActorId === null &&
        entry.reviewTasks.some(
          (task) => task.assigneeActorId === coordinator.id,
        ),
    ),
    "by-actor inside the unassigned scope matches task assignments only",
  );
  const byTaskOnly = await queueView({
    assigneeActorId: coordinator.id,
    origin: "live",
  });
  assert.ok(
    byTaskOnly.rows.some((entry) => entry.requestId === u1.requestId) &&
      byTaskOnly.rows.some((entry) => entry.requestId === u2.requestId),
    "the by-actor scope still matches coordinator and task assignments",
  );

  await checkQueuePagination(organization.id);

  console.log(
    "read-model checks passed: phase walk with stable clocks, configurable " +
      "thresholds, queue filters/sort/pagination, coherent role surfaces, " +
      "dashboard attention and sources, delta-verified report metrics, " +
      "reset-proof measurement history, a repeatable-read view boundary " +
      "under concurrent writes, current-assessment risk facts with filter " +
      "and ordering, the whole-queue Reach-basis warning, and the unassigned reviewer scope.",
  );
} finally {
  await sql.end();
}
