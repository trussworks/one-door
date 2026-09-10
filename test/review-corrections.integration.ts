// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { collectCorpus } from "../src/models/corpus.ts";
import { withDb } from "../src/workflow/shared.ts";

import {
  enqueueModelJob,
  runWorkerOnce,
  type ModelProvider,
} from "../src/models/index.ts";
import {
  askClarification,
  assignReview,
  completeFirstReview,
  createVisitor,
  getReviewState,
  recordAssetOutcome,
  recordRiskOutcome,
  recordRouting,
  saveAssetDecision,
  saveDraft,
  saveRiceScore,
  submitRequest,
  WorkflowError,
  type ActorContext,
  type VisitorContext,
} from "../src/workflow/index.ts";
import { dashboardView } from "../src/server/dashboard.ts";
import { defaultWaitThresholds } from "../src/domain/business-days.ts";
import { enrichedRequests } from "../src/server/read-model.ts";
import { queueView } from "../src/server/queue.ts";
import { reportMetrics } from "../src/server/reports.ts";

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

async function expectCode(
  code: string,
  action: () => Promise<unknown>,
  label: string,
): Promise<WorkflowError> {
  try {
    await action();
  } catch (error) {
    assert.ok(
      error instanceof WorkflowError,
      `${label}: expected WorkflowError, got ${String(error)}`,
    );
    assert.equal(error.code, code, `${label}: wrong code (${error.message})`);
    return error;
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`);
}

const url = databaseUrl();
process.env.DATABASE_URL = url;
const sql = postgres(url, { max: 1, onnotice: () => {} });

const draftContent = (label: string) => ({
  title: `Corrections journey ${label} ${randomUUID().slice(0, 8)}`,
  problem: "The office needs a reviewed correctness path.",
  affectedPeople: "Office staff",
  acceptanceCriteria: ["The correction holds"],
  requirements: [],
  constraints: [],
  unknowns: [],
});

async function submitLive(
  visitor: VisitorContext,
  organizationId: string,
  label: string,
) {
  const draft = await saveDraft(visitor, {
    organizationId,
    rawNeed: `Need for the ${label} corrections journey.`,
    content: draftContent(label),
    state: "ready",
  });
  const submitted = await submitRequest(visitor, {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating: 5,
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

async function scaffoldAssessments(draftId: string, revisionId: string) {
  const assetId = randomUUID();
  const riskId = randomUUID();
  // Approval compares stored corpus hashes with current collectCorpus
  // hashes, so scaffolds record the real hash at insert time.
  const hashes = await withDb(async (db) => ({
    asset: (await collectCorpus(db, "asset_match")).hash,
    risk: (await collectCorpus(db, "risk_assess")).hash,
  }));
  await sql.unsafe(`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin, revision_id)
    VALUES ('${assetId}', '${draftId}', 'succeeded', '${hashes.asset}', 'live', '${revisionId}');
    INSERT INTO risk_assessments
      (id, draft_id, status, policy_corpus_hash, origin, revision_id)
    VALUES ('${riskId}', '${draftId}', 'succeeded', '${hashes.risk}', 'live', '${revisionId}');
  `);
  return { assetId, riskId };
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

const intakeOutput = (offeringId: string) =>
  JSON.stringify({
    content: draftContent("model"),
    questions: [],
    services: [
      {
        offeringId,
        fitBand: "possible",
        coverage: ["Hosts the application"],
        gaps: ["Workflow remains custom"],
        relatedOfferingKeys: [],
        rationale: "The offering hosts applications of this shape.",
      },
    ],
  });

const providerOf = (text: () => string): ModelProvider => ({
  async complete() {
    return { outputText: text(), inputTokens: 900, outputTokens: 400 };
  },
});

async function draftRowVersion(draftId: string): Promise<number> {
  const [row] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM drafts WHERE id = '${draftId}'`,
  );
  return row.v;
}

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [persona] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' ORDER BY id LIMIT 1`,
  );
  const [offering] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM service_offerings WHERE lifecycle = 'active' LIMIT 1`,
  );
  assert.ok(organization && persona && offering, "seed data present");
  const alice = await createVisitor();
  const reviewer: ActorContext = {
    actorId: persona.id,
    actingView: "contributor",
    visitorId: alice.visitorId,
  };

  // ── 1. Zero findings require an explicit human risk outcome ──────────────
  const ra = await submitLive(alice, organization.id, "RA");
  const raRevision = await currentRevisionId(ra.requestId);
  const { assetId } = await scaffoldAssessments(ra.draftId, raRevision);
  const candidateId = randomUUID();
  const [catalogItem] = await sql.unsafe<
    { id: string; current_version: number }[]
  >(
    `SELECT id, current_version FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     LIMIT 1`,
  );
  await sql.unsafe(`
    INSERT INTO asset_candidates
      (id, assessment_id, catalog_item_id, catalog_version, rank, fit_band,
       coverage, gaps, dependencies, rationale)
    VALUES ('${candidateId}', '${assetId}', '${catalogItem.id}',
       ${catalogItem.current_version}, 1, 'strong', '{}', '{}', '{}', 'probe')
  `);
  let [versionRow] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${ra.requestId}'`,
  );
  const accepted = await saveAssetDecision(reviewer, {
    requestId: ra.requestId,
    candidateId,
    decision: "accepted",
    expectedRowVersion: versionRow.v,
  });
  const assetsDone = await recordAssetOutcome(reviewer, {
    requestId: ra.requestId,
    outcome: "accepted",
    expectedRowVersion: accepted.rowVersion,
  });
  const scored = await saveRiceScore(reviewer, {
    requestId: ra.requestId,
    ...riceFactors(persona.id),
    expectedRowVersion: assetsDone.rowVersion,
  });
  const routed = await recordRouting(reviewer, {
    requestId: ra.requestId,
    nextOwner: "OIT Application Services",
    expectedRowVersion: scored.rowVersion,
  });
  const blocked = await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      completeFirstReview(reviewer, {
        requestId: ra.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        workPlan: [],
        expectedRowVersion: routed.rowVersion,
      }),
    "approval with an unreviewed zero-finding risk assessment",
  );
  assert.match(blocked.detail ?? "", /RISK_OUTCOME_PENDING/);

  await expectCode(
    "VALIDATION_FAILED",
    () => recordRiskOutcome(reviewer, { requestId: ra.requestId }),
    "risk outcome without the seen version",
  );
  await expectCode(
    "VERSION_CONFLICT",
    () =>
      recordRiskOutcome(reviewer, {
        requestId: ra.requestId,
        expectedRowVersion: routed.rowVersion + 7,
      }),
    "risk outcome with a stale version",
  );
  const riskDone = await recordRiskOutcome(reviewer, {
    requestId: ra.requestId,
    expectedRowVersion: routed.rowVersion,
  });
  assert.equal(riskDone.findingCount, 0, "zero findings confirmed by a person");
  const [audited] = await sql.unsafe<
    { actor: string; payload: Record<string, unknown> }[]
  >(
    `SELECT actor_id::text AS actor, payload FROM audit_events
     WHERE event_type = 'risk_outcome_recorded'
       AND subject_id = '${ra.requestId}'`,
  );
  assert.ok(audited, "the confirmation is audited");
  assert.equal(audited.actor, reviewer.actorId);
  assert.equal(audited.payload.revisionId, raRevision);
  assert.equal(audited.payload.requestGeneration, 1);
  const completed = await completeFirstReview(reviewer, {
    requestId: ra.requestId,
    rating: 4,
    idempotencyKey: randomUUID(),
    targetSystem: "servicenow",
    workPlan: [],
    expectedRowVersion: riskDone.rowVersion,
  });
  assert.equal(completed.stage, "first_review_completed");

  // Unsettled findings and missing assessments are rejected.
  const rb = await submitLive(alice, organization.id, "RB");
  const rbRevision = await currentRevisionId(rb.requestId);
  const { riskId: rbRisk } = await scaffoldAssessments(rb.draftId, rbRevision);
  const [rule] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`,
  );
  await sql.unsafe(`
    INSERT INTO risk_findings
      (id, assessment_id, policy_rule_id, kind, evidence, proposed_severity, rationale)
    VALUES ('${randomUUID()}', '${rbRisk}', '${rule.id}', 'supported_risk',
       'probe evidence', 'moderate', 'probe rationale')
  `);
  [versionRow] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${rb.requestId}'`,
  );
  const unsettled = await expectCode(
    "INVALID_STATE",
    () =>
      recordRiskOutcome(reviewer, {
        requestId: rb.requestId,
        expectedRowVersion: versionRow.v,
      }),
    "risk outcome over an undecided finding",
  );
  assert.match(unsettled.detail ?? "", /not settled/);
  const rc = await submitLive(alice, organization.id, "RC");
  const missing = await expectCode(
    "INVALID_STATE",
    () =>
      recordRiskOutcome(reviewer, {
        requestId: rc.requestId,
        expectedRowVersion: 1,
      }),
    "risk outcome without an assessment",
  );
  assert.match(missing.detail ?? "", /RISK_ASSESSMENT_MISSING/);

  // The explicit confirmation can be the first human review decision.
  const rd = await submitLive(alice, organization.id, "RD");
  const rdRevision = await currentRevisionId(rd.requestId);
  await scaffoldAssessments(rd.draftId, rdRevision);
  [versionRow] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${rd.requestId}'`,
  );
  await recordRiskOutcome(reviewer, {
    requestId: rd.requestId,
    expectedRowVersion: versionRow.v,
  });
  const metrics = await reportMetrics({ dataset: "live" });
  const rdRecord = metrics.timeToFirstReview.records.find(
    (record) => record.requestId === rd.requestId,
  );
  assert.ok(rdRecord, "the risk confirmation enters the first-review cohort");
  assert.ok(rdRecord.seconds >= 0, "measured from submission");

  // ── 1b. No match over proposed candidates needs explicit rejections ──────
  const rf = await submitLive(alice, organization.id, "RF");
  const rfRevision = await currentRevisionId(rf.requestId);
  const { assetId: rfAsset } = await scaffoldAssessments(
    rf.draftId,
    rfRevision,
  );
  const rfCandidate = randomUUID();
  await sql.unsafe(`
    INSERT INTO asset_candidates
      (id, assessment_id, catalog_item_id, catalog_version, rank, fit_band,
       coverage, gaps, dependencies, rationale)
    VALUES ('${rfCandidate}', '${rfAsset}', '${catalogItem.id}',
       ${catalogItem.current_version}, 1, 'strong', '{}', '{}', '{}', 'probe')
  `);
  [versionRow] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${rf.requestId}'`,
  );
  const undecided = await expectCode(
    "INVALID_STATE",
    () =>
      recordAssetOutcome(reviewer, {
        requestId: rf.requestId,
        outcome: "no_match",
        expectedRowVersion: versionRow.v,
      }),
    "no match over an undecided candidate",
  );
  assert.match(undecided.message, /without a rejected decision/);
  const rfRejected = await saveAssetDecision(reviewer, {
    requestId: rf.requestId,
    candidateId: rfCandidate,
    decision: "rejected",
    reason: "The proposed item does not cover the need.",
    expectedRowVersion: versionRow.v,
  });
  const rfOutcome = await recordAssetOutcome(reviewer, {
    requestId: rf.requestId,
    outcome: "no_match",
    expectedRowVersion: rfRejected.rowVersion,
  });
  assert.ok(rfOutcome, "no match records once every candidate is rejected");

  // ── 1c. Final approval rechecks corpus freshness, even when empty ────────
  const re = await submitLive(alice, organization.id, "RE");
  const reRevision = await currentRevisionId(re.requestId);
  await scaffoldAssessments(re.draftId, reRevision);
  [versionRow] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${re.requestId}'`,
  );
  const reAssets = await recordAssetOutcome(reviewer, {
    requestId: re.requestId,
    outcome: "no_match",
    expectedRowVersion: versionRow.v,
  });
  const reRisk = await recordRiskOutcome(reviewer, {
    requestId: re.requestId,
    expectedRowVersion: reAssets.rowVersion,
  });
  const reScored = await saveRiceScore(reviewer, {
    requestId: re.requestId,
    ...riceFactors(persona.id),
    expectedRowVersion: reRisk.rowVersion,
  });
  const reRouted = await recordRouting(reviewer, {
    requestId: re.requestId,
    nextOwner: "OIT Application Services",
    expectedRowVersion: reScored.rowVersion,
  });
  let reState = await getReviewState(re.requestId);
  assert.deepEqual(reState.blockers, [], "fresh evidence has no blockers");

  // A changed catalog member moves the corpus and blocks approval, though
  // this assessment proposed zero candidates.
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = current_version + 1
    WHERE id = '${catalogItem.id}'
  `);
  reState = await getReviewState(re.requestId);
  assert.ok(
    reState.blockers.includes("ASSET_CORPUS_STALE"),
    "catalog change stales the empty asset assessment",
  );
  const [staleRow] = await enrichedRequests(defaultWaitThresholds, [
    re.requestId,
  ]);
  assert.equal(
    staleRow.actionNeeded,
    "refresh_preparation",
    "the queue stops saying complete-first-review while the corpus is stale",
  );
  assert.equal(
    staleRow.attention.stalePreparation,
    true,
    "stale preparation reaches attention",
  );
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = ${catalogItem.current_version}
    WHERE id = '${catalogItem.id}'
  `);

  // A policy membership change does the same for the risk side.
  await sql.unsafe(
    `UPDATE policy_rules SET lifecycle = 'retired' WHERE id = '${rule.id}'`,
  );
  reState = await getReviewState(re.requestId);
  assert.ok(
    reState.blockers.includes("RISK_CORPUS_STALE"),
    "policy change stales the zero-finding risk assessment",
  );
  await sql.unsafe(
    `UPDATE policy_rules SET lifecycle = 'active' WHERE id = '${rule.id}'`,
  );
  reState = await getReviewState(re.requestId);
  assert.deepEqual(reState.blockers, [], "restored corpus clears the gate");
  const [freshRow] = await enrichedRequests(defaultWaitThresholds, [
    re.requestId,
  ]);
  assert.equal(freshRow.actionNeeded, "complete_first_review");
  assert.equal(freshRow.attention.stalePreparation, false);
  // Reference fixtures store seed-format hashes, so they read as needing
  // refresh instead of silently green.
  const seededRows = await queueView({ origin: "seed" });
  assert.ok(
    seededRows.rows.some(
      (row) =>
        row.attention.stalePreparation &&
        row.actionNeeded === "refresh_preparation",
    ),
    "seeded reference requests are visible as needing refresh",
  );
  const reCompleted = await completeFirstReview(reviewer, {
    requestId: re.requestId,
    rating: 4,
    idempotencyKey: randomUUID(),
    targetSystem: "servicenow",
    workPlan: [],
    expectedRowVersion: reRouted.rowVersion,
  });
  assert.equal(reCompleted.stage, "first_review_completed");
  const reMetrics = await reportMetrics({ dataset: "live" });
  const reRecord = reMetrics.timeToFirstReview.records.find(
    (record) => record.requestId === re.requestId,
  );
  assert.ok(
    reRecord,
    "a zero-candidate asset outcome counts as the first review decision",
  );

  // ── 1d. A new current assessment resets the area's human outcome ─────────
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded' WHERE status = 'queued'`,
  );
  const rg = await submitLive(alice, organization.id, "RG");
  const rgAssetOut = JSON.stringify({
    candidates: [
      {
        catalogItemId: catalogItem.id,
        fitBand: "possible",
        coverage: ["Covers the tracking core"],
        gaps: [],
        dependencies: [],
        rationale: "The governed asset covers the need.",
      },
    ],
  });
  const rgAssetRun = await runWorkerOnce({
    provider: providerOf(() => rgAssetOut),
  });
  assert.equal(rgAssetRun?.outcome, "succeeded");
  const rgRiskRun = await runWorkerOnce({
    provider: providerOf(() => JSON.stringify({ findings: [] })),
  });
  assert.equal(rgRiskRun?.outcome, "succeeded");

  const [rgCandidate] = await sql.unsafe<{ id: string }[]>(`
    SELECT c.id FROM asset_candidates c
    JOIN asset_assessments a ON a.id = c.assessment_id
    WHERE a.draft_id = '${rg.draftId}'
    ORDER BY a.created_at DESC LIMIT 1
  `);
  let rgState = await getReviewState(rg.requestId);
  const rgAccepted = await saveAssetDecision(reviewer, {
    requestId: rg.requestId,
    candidateId: rgCandidate.id,
    decision: "accepted",
    expectedRowVersion: rgState.rowVersion,
  });
  const rgAssets = await recordAssetOutcome(reviewer, {
    requestId: rg.requestId,
    outcome: "accepted",
    expectedRowVersion: rgAccepted.rowVersion,
  });
  const rgRisk = await recordRiskOutcome(reviewer, {
    requestId: rg.requestId,
    expectedRowVersion: rgAssets.rowVersion,
  });
  const rgScored = await saveRiceScore(reviewer, {
    requestId: rg.requestId,
    ...riceFactors(persona.id),
    expectedRowVersion: rgRisk.rowVersion,
  });
  await recordRouting(reviewer, {
    requestId: rg.requestId,
    nextOwner: "OIT Application Services",
    expectedRowVersion: rgScored.rowVersion,
  });
  rgState = await getReviewState(rg.requestId);
  assert.deepEqual(
    rgState.blockers,
    [],
    "fully reviewed before the corpus moves",
  );

  // The corpus changes and a new successful, empty assessment replaces the
  // reviewed one. The old human outcome must not carry over.
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = current_version + 1
    WHERE id = '${catalogItem.id}'
  `);
  await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: rg.draftId,
    requestId: rg.requestId,
  });
  const rgEmptyRun = await runWorkerOnce({
    provider: providerOf(() => JSON.stringify({ candidates: [] })),
  });
  assert.equal(rgEmptyRun?.outcome, "succeeded");
  rgState = await getReviewState(rg.requestId);
  assert.equal(
    rgState.tasks.find((task) => task.area === "assets")?.state,
    "pending",
    "the recorded human asset outcome was reset with the new assessment",
  );
  assert.ok(
    rgState.blockers.includes("ASSET_OUTCOME_PENDING"),
    "approval blocks until a fresh human outcome",
  );
  assert.equal(
    rgState.tasks.find((task) => task.area === "risk")?.state,
    "completed",
    "the untouched risk area keeps its recorded outcome",
  );
  const rgBlocked = await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      completeFirstReview(reviewer, {
        requestId: rg.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        workPlan: [],
        expectedRowVersion: rgState.rowVersion,
      }),
    "completion after the silent replacement",
  );
  assert.match(rgBlocked.detail ?? "", /ASSET_OUTCOME_PENDING/);
  const rgNoMatch = await recordAssetOutcome(reviewer, {
    requestId: rg.requestId,
    outcome: "no_match",
    expectedRowVersion: rgState.rowVersion,
  });
  const rgCompleted = await completeFirstReview(reviewer, {
    requestId: rg.requestId,
    rating: 4,
    idempotencyKey: randomUUID(),
    targetSystem: "servicenow",
    workPlan: [],
    expectedRowVersion: rgNoMatch.rowVersion,
  });
  assert.equal(rgCompleted.stage, "first_review_completed");
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = ${catalogItem.current_version}
    WHERE id = '${catalogItem.id}'
  `);

  // ── 1e. Capped preparation is honest, queued is ordinary ─────────────────
  const rh = await submitLive(alice, organization.id, "RH");
  let [rhRow] = await enrichedRequests(defaultWaitThresholds, [rh.requestId]);
  assert.equal(
    rhRow.actionNeeded,
    "wait_for_preparation",
    "queued preparation is ordinary processing",
  );
  assert.equal(rhRow.attention.cappedPreparation, false);
  await sql.unsafe(`
    UPDATE model_jobs
    SET status = 'capped', sanitized_error = 'daily_request_cap_reached'
    WHERE draft_id = '${rh.draftId}' AND status = 'queued'
  `);
  await assignReview(reviewer, {
    requestId: rh.requestId,
    coordinatorActorId: persona.id,
    expectedRowVersion: rhRow.rowVersion,
  });
  [rhRow] = await enrichedRequests(defaultWaitThresholds, [rh.requestId]);
  assert.equal(
    rhRow.actionNeeded,
    "review_usage_limit",
    "capped preparation names the usage limit, not ordinary waiting",
  );
  assert.equal(rhRow.attention.cappedPreparation, true);
  assert.equal(rhRow.needsAttention, true, "assigned capped request surfaces");
  const dashboard = await dashboardView();
  const rhDashboard = dashboard.requests.find(
    (row) => row.requestId === rh.requestId,
  );
  assert.ok(rhDashboard, "the capped request is on the dashboard");
  assert.equal(rhDashboard.attention.cappedPreparation, true);
  assert.equal(rhDashboard.actionNeeded, "review_usage_limit");
  assert.ok(
    dashboard.attentionCounts.cappedPreparation >= 1,
    "the attention filter counts capped preparation",
  );

  // A capped replacement of a STALE existing assessment also reads as
  // usage-limited, not as ordinary review work.
  const rj = await submitLive(alice, organization.id, "RJ");
  const rjRevision = await currentRevisionId(rj.requestId);
  await scaffoldAssessments(rj.draftId, rjRevision);
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = current_version + 1
    WHERE id = '${catalogItem.id}'
  `);
  const rjJob = await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: rj.draftId,
    requestId: rj.requestId,
  });
  await sql.unsafe(`
    UPDATE model_jobs
    SET status = 'capped', sanitized_error = 'daily_request_cap_reached'
    WHERE id = '${rjJob.jobId}'
  `);
  const [rjRow] = await enrichedRequests(defaultWaitThresholds, [rj.requestId]);
  assert.equal(
    rjRow.actionNeeded,
    "review_usage_limit",
    "a capped replacement of a stale assessment names the usage limit",
  );
  assert.equal(rjRow.attention.cappedPreparation, true);
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = ${catalogItem.current_version}
    WHERE id = '${catalogItem.id}'
  `);

  // ── 2. Rejecting current service suggestions needs a recorded reason ─────
  // Inert queued jobs from this run's submissions (and earlier suite runs)
  // would win the oldest-first claim; retire them so the worker
  // deterministically takes this section's intake jobs.
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded' WHERE status = 'queued'`,
  );
  const d1 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Need with current model suggestions.",
    content: draftContent("D1"),
    state: "ready",
  });
  const jobOne = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: d1.draftId,
  });
  const runOne = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id)),
  });
  assert.equal(runOne?.jobId, jobOne.jobId);
  assert.equal(runOne?.outcome, "succeeded");
  const noReason = await expectCode(
    "VALIDATION_FAILED",
    async () =>
      submitRequest(alice, {
        draftId: d1.draftId,
        expectedRowVersion: await draftRowVersion(d1.draftId),
        rating: 5,
        idempotencyKey: randomUUID(),
      }),
    "submission past current suggestions without a reason",
  );
  assert.match(noReason.message, /rejection reason/);
  const d1Submitted = await submitRequest(alice, {
    draftId: d1.draftId,
    expectedRowVersion: await draftRowVersion(d1.draftId),
    rating: 5,
    idempotencyKey: randomUUID(),
    rejectionReason: "The office prefers its existing arrangement.",
  });
  const d1Candidates = await sql.unsafe<
    { decision: string | null; reason: string | null; actor: string | null }[]
  >(
    `SELECT decision, decision_reason AS reason, decided_by_actor_id::text AS actor
     FROM service_candidates WHERE draft_id = '${d1.draftId}'`,
  );
  assert.ok(d1Candidates.length >= 1, "the current run proposed services");
  for (const candidate of d1Candidates) {
    assert.equal(candidate.decision, "rejected");
    assert.equal(
      candidate.reason,
      "The office prefers its existing arrangement.",
    );
    assert.ok(candidate.actor, "the deciding actor is recorded");
  }
  const [rejectionAudit] = await sql.unsafe<
    { payload: { candidateIds: string[] } }[]
  >(
    `SELECT payload FROM audit_events
     WHERE event_type = 'service_suggestions_rejected'
       AND subject_id = '${d1Submitted.requestId}'`,
  );
  assert.ok(rejectionAudit, "the rejection is audited with the submission");
  assert.equal(rejectionAudit.payload.candidateIds.length, d1Candidates.length);

  // Stale suggestions stay an honest human-routing path.
  const d2 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Need whose suggestions will go stale.",
    content: draftContent("D2"),
    state: "ready",
  });
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded' WHERE status = 'queued'`,
  );
  const jobTwo = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: d2.draftId,
  });
  const runTwo = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id)),
  });
  assert.equal(runTwo?.jobId, jobTwo.jobId);
  await saveDraft(alice, {
    draftId: d2.draftId,
    organizationId: organization.id,
    rawNeed: "Need whose suggestions will go stale.",
    content: { ...draftContent("D2-changed"), problem: "A changed problem." },
    state: "ready",
    expectedRowVersion: await draftRowVersion(d2.draftId),
  });
  await submitRequest(alice, {
    draftId: d2.draftId,
    expectedRowVersion: await draftRowVersion(d2.draftId),
    rating: 4,
    idempotencyKey: randomUUID(),
  });
  const d2Candidates = await sql.unsafe<{ decision: string | null }[]>(
    `SELECT decision FROM service_candidates WHERE draft_id = '${d2.draftId}'`,
  );
  assert.ok(d2Candidates.length >= 1, "stale candidates still exist");
  for (const candidate of d2Candidates)
    assert.equal(
      candidate.decision,
      null,
      "stale suggestions are neither required nor rejected",
    );

  // Selecting a current candidate still works with no reason.
  const d3 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Need that selects the suggestion.",
    content: draftContent("D3"),
    state: "ready",
  });
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded' WHERE status = 'queued'`,
  );
  const jobThree = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: d3.draftId,
  });
  const runThree = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id)),
  });
  assert.equal(runThree?.jobId, jobThree.jobId);
  const [d3Candidate] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM service_candidates WHERE draft_id = '${d3.draftId}' LIMIT 1`,
  );
  await submitRequest(alice, {
    draftId: d3.draftId,
    expectedRowVersion: await draftRowVersion(d3.draftId),
    rating: 5,
    idempotencyKey: randomUUID(),
    selectedServiceCandidateId: d3Candidate.id,
  });
  const [d3Row] = await sql.unsafe<{ decision: string | null }[]>(
    `SELECT decision FROM service_candidates WHERE id = '${d3Candidate.id}'`,
  );
  assert.equal(d3Row.decision, "accepted", "selection path unchanged");

  // ── 3. askClarification takes the version guard and bumps ────────────────
  [versionRow] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${rb.requestId}'`,
  );
  await expectCode(
    "VERSION_CONFLICT",
    () =>
      askClarification(reviewer, {
        requestId: rb.requestId,
        question: "Version-guard probe?",
        expectedRowVersion: versionRow.v + 5,
      }),
    "ask with a stale version",
  );
  const askedGuarded = await askClarification(reviewer, {
    requestId: rb.requestId,
    question: "Which office owns the data?",
    expectedRowVersion: versionRow.v,
  });
  assert.equal(
    askedGuarded.rowVersion,
    versionRow.v + 1,
    "asking bumps the request version",
  );
  const [afterAsk] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${rb.requestId}'`,
  );
  assert.equal(afterAsk.v, versionRow.v + 1);
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      askClarification(reviewer, {
        requestId: rc.requestId,
        question: "Probe without the seen version?",
      }),
    "ask requires the seen version",
  );
  const [rcRow] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${rc.requestId}'`,
  );
  const askedVersioned = await askClarification(reviewer, {
    requestId: rc.requestId,
    question: "Versioned ask after the guard?",
    expectedRowVersion: rcRow.v,
  });
  assert.equal(askedVersioned.rowVersion, rcRow.v + 1, "guarded ask bumps");

  console.log(
    "review-corrections checks passed: explicit zero-finding risk outcome " +
      "with audit and metric entry, recorded service-suggestion rejections " +
      "with stale and selected paths intact, and a guarded, versioned " +
      "askClarification.",
  );
} finally {
  await sql.end();
}
