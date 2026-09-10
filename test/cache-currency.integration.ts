// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import {
  enqueueModelJob,
  runWorkerOnce,
  type ModelProvider,
} from "../src/models/index.ts";
import {
  completeFirstReview,
  confirmIntake,
  createVisitor,
  decideService,
  getIntakeState,
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
} from "../src/workflow/index.ts";
import { defaultWaitThresholds } from "../src/domain/business-days.ts";
import { enrichedRequests } from "../src/server/read-model.ts";
import { requestView } from "../src/server/request-views.ts";

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
  title: `Cache currency ${label} ${randomUUID().slice(0, 8)}`,
  problem: "The office needs cached results honored on reversion.",
  affectedPeople: "Office staff",
  acceptanceCriteria: ["Currency follows identity"],
  requirements: [],
  constraints: [],
  unknowns: [],
});

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

const providerOf = (text: () => string): ModelProvider => ({
  async complete() {
    return { outputText: text(), inputTokens: 900, outputTokens: 400 };
  },
});

const intakeOutput = (offeringId: string, rationale: string) =>
  JSON.stringify({
    content: draftContent("model"),
    questions: [],
    services: [
      {
        offeringId,
        fitBand: "possible",
        coverage: ["Hosts the application"],
        gaps: [],
        relatedOfferingKeys: [],
        rationale,
      },
    ],
  });

async function liveCallCount(): Promise<number> {
  const [row] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM model_calls`,
  );
  return row.total;
}

async function drainQueue(): Promise<void> {
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded' WHERE status = 'queued'`,
  );
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
  const offerings = await sql.unsafe<{ id: string; lifecycle: string }[]>(
    `SELECT id, lifecycle FROM service_offerings WHERE lifecycle = 'active'
     ORDER BY id LIMIT 2`,
  );
  assert.ok(offerings.length === 2, "two active offerings exist in the seed");
  const cited = offerings[0];
  const toggled = offerings[1];
  const alice = await createVisitor();
  const reviewer: ActorContext = {
    actorId: persona.id,
    actingView: "contributor",
    visitorId: alice.visitorId,
  };

  // ── 1. Intake A -> B -> A reuses the cached A run without a new bill ─────
  await drainQueue();
  const draft = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Need with a reusable cached interpretation.",
    content: draftContent("D"),
    state: "ready",
  });
  const jobA = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: draft.draftId,
  });
  const runA = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(cited.id, "Cache line A")),
  });
  assert.equal(runA?.jobId, jobA.jobId);
  assert.equal(runA?.outcome, "succeeded");

  // Corpus B: retire an unrelated offering, so membership changes.
  await sql.unsafe(
    `UPDATE service_offerings SET lifecycle = 'retired' WHERE id = '${toggled.id}'`,
  );
  const jobB = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: draft.draftId,
  });
  assert.notEqual(jobB.jobId, jobA.jobId, "corpus B is a new logical job");
  const runB = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(cited.id, "Cache line B")),
  });
  assert.equal(runB?.jobId, jobB.jobId);
  let state = await getIntakeState(alice, draft.draftId);
  assert.equal(state.intakeJob?.jobId, jobB.jobId, "B is current under B");

  // Corpus reverts to A.
  await sql.unsafe(
    `UPDATE service_offerings SET lifecycle = 'active' WHERE id = '${toggled.id}'`,
  );
  const callsBefore = await liveCallCount();
  const reusedA = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: draft.draftId,
  });
  assert.equal(reusedA.jobId, jobA.jobId, "the cached A job is reused");
  assert.equal(reusedA.status, "succeeded");
  const idleRun = await runWorkerOnce({
    provider: providerOf(() => {
      throw new Error("no provider call may happen for a cached result");
    }),
  });
  assert.equal(idleRun, null, "nothing is queued after the cache hit");
  assert.equal(
    await liveCallCount(),
    callsBefore,
    "no new provider bill for cached A",
  );

  state = await getIntakeState(alice, draft.draftId);
  assert.equal(state.intakeJob?.jobId, jobA.jobId, "A is current again");
  assert.equal(state.candidates.length, 1, "one current candidate");
  assert.match(
    JSON.stringify(state.candidates),
    /Cache line A/,
    "the A candidates are presented",
  );
  const [candidateSets] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(DISTINCT model_call_id)::int AS total
     FROM service_candidates WHERE draft_id = '${draft.draftId}'`,
  );
  assert.equal(candidateSets.total, 2, "B's candidates stay as history");
  const rejected = await decideService(alice, {
    draftId: draft.draftId,
    candidateId: state.candidates[0].candidateId,
    decision: "rejected",
    reason: "The office keeps its current arrangement.",
    expectedRowVersion: state.rowVersion,
  });
  assert.equal(rejected.decision, "rejected", "the A candidate is actionable");

  // ── 2. A completed B review cannot approve the revived A result ──────────
  await drainQueue();
  const rq = await (async () => {
    const d = await saveDraft(alice, {
      organizationId: organization.id,
      rawNeed: "Need for the reviewed reversion journey.",
      content: draftContent("RQ"),
      state: "ready",
    });
    const submitted = await submitRequest(alice, {
      draftId: d.draftId,
      expectedRowVersion: d.rowVersion,
      rating: 5,
      idempotencyKey: randomUUID(),
    });
    return { draftId: d.draftId, requestId: submitted.requestId };
  })();
  const [catalogItem] = await sql.unsafe<
    { id: string; current_version: number }[]
  >(
    `SELECT id, current_version FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     LIMIT 1`,
  );
  const assetOut = JSON.stringify({
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
  const runAssetA = await runWorkerOnce({
    provider: providerOf(() => assetOut),
  });
  assert.equal(runAssetA?.outcome, "succeeded");
  const runRisk = await runWorkerOnce({
    provider: providerOf(() => JSON.stringify({ findings: [] })),
  });
  assert.equal(runRisk?.outcome, "succeeded");
  const [assessmentA] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM asset_assessments WHERE draft_id = '${rq.draftId}'
     ORDER BY created_at DESC LIMIT 1`,
  );
  const [candidateA] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM asset_candidates WHERE assessment_id = '${assessmentA.id}'`,
  );
  let review = await getReviewState(rq.requestId);
  const accepted = await saveAssetDecision(reviewer, {
    requestId: rq.requestId,
    candidateId: candidateA.id,
    decision: "accepted",
    expectedRowVersion: review.rowVersion,
  });
  const assetsDoneA = await recordAssetOutcome(reviewer, {
    requestId: rq.requestId,
    outcome: "accepted",
    expectedRowVersion: accepted.rowVersion,
  });
  const riskDone = await recordRiskOutcome(reviewer, {
    requestId: rq.requestId,
    expectedRowVersion: assetsDoneA.rowVersion,
  });
  const scored = await saveRiceScore(reviewer, {
    requestId: rq.requestId,
    ...riceFactors(persona.id),
    expectedRowVersion: riskDone.rowVersion,
  });
  await recordRouting(reviewer, {
    requestId: rq.requestId,
    nextOwner: "OIT Application Services",
    expectedRowVersion: scored.rowVersion,
  });
  review = await getReviewState(rq.requestId);
  assert.deepEqual(review.blockers, [], "A is fully reviewed under corpus A");

  // Corpus B: the catalog member changes; a new empty result gets reviewed.
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = current_version + 1
    WHERE id = '${catalogItem.id}'
  `);
  await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: rq.draftId,
    requestId: rq.requestId,
  });
  const runAssetB = await runWorkerOnce({
    provider: providerOf(() => JSON.stringify({ candidates: [] })),
  });
  assert.equal(runAssetB?.outcome, "succeeded");
  review = await getReviewState(rq.requestId);
  assert.ok(
    review.blockers.includes("ASSET_OUTCOME_PENDING"),
    "the new B result reset the human outcome",
  );
  const noMatchB = await recordAssetOutcome(reviewer, {
    requestId: rq.requestId,
    outcome: "no_match",
    expectedRowVersion: review.rowVersion,
  });
  assert.ok(noMatchB, "B is reviewed as no-match");

  // Corpus reverts to A: the cached A assessment is current again.
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = ${catalogItem.current_version}
    WHERE id = '${catalogItem.id}'
  `);
  const callsAfterB = await liveCallCount();
  const view = await requestView(alice, rq.requestId, true);
  assert.equal(
    view.assetAssessment?.id,
    assessmentA.id,
    "the cached A assessment is presented as current",
  );
  const [bothAssessments] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM asset_assessments
     WHERE draft_id = '${rq.draftId}'`,
  );
  assert.equal(bothAssessments.total, 2, "the B assessment stays as history");
  review = await getReviewState(rq.requestId);
  assert.ok(
    review.blockers.includes("ASSET_OUTCOME_PENDING"),
    "B's completion does not approve the unreviewed revived A",
  );
  await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      completeFirstReview(reviewer, {
        requestId: rq.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        workPlan: [],
        expectedRowVersion: noMatchB.rowVersion,
      }),
    "approval on another result's completion",
  );
  const [rqRow] = await enrichedRequests(defaultWaitThresholds, [rq.requestId]);
  assert.equal(
    rqRow.actionNeeded,
    "review_assets",
    "the queue asks for a fresh human outcome on the revived result",
  );
  assert.equal(
    await liveCallCount(),
    callsAfterB,
    "the reversion itself billed nothing",
  );

  // A fresh human outcome for the revived A result approves.
  review = await getReviewState(rq.requestId);
  const assetsDoneAgain = await recordAssetOutcome(reviewer, {
    requestId: rq.requestId,
    outcome: "accepted",
    expectedRowVersion: review.rowVersion,
  });
  review = await getReviewState(rq.requestId);
  assert.deepEqual(review.blockers, [], "a fresh outcome clears the gate");
  const completed = await completeFirstReview(reviewer, {
    requestId: rq.requestId,
    rating: 4,
    idempotencyKey: randomUUID(),
    targetSystem: "servicenow",
    workPlan: [],
    expectedRowVersion: assetsDoneAgain.rowVersion,
  });
  assert.equal(completed.stage, "first_review_completed");

  // ── 2b. Approved evidence survives a later corpus flip (no dispatch) ─────
  const approvedView = await requestView(alice, rq.requestId, true);
  assert.equal(approvedView.assetAssessment?.id, assessmentA.id);
  const [assessmentB] = await sql.unsafe<
    { id: string; catalog_corpus_hash: string }[]
  >(
    `SELECT id, catalog_corpus_hash FROM asset_assessments
     WHERE draft_id = '${rq.draftId}' AND id <> '${assessmentA.id}'`,
  );
  const callsAtApproval = await liveCallCount();
  // The catalog flips back to B's exact corpus; nothing is enqueued, so no
  // worker or billing path runs and the late-worker guard never engages.
  await sql.unsafe(`
    UPDATE catalog_items SET current_version = current_version + 1
    WHERE id = '${catalogItem.id}'
  `);
  const flipped = await requestView(alice, rq.requestId, true);
  assert.equal(
    flipped.assetAssessment?.id,
    assessmentA.id,
    "the approved request keeps the evidence that was actually approved",
  );
  assert.equal(
    flipped.candidates.length,
    1,
    "the approved candidate set stays visible",
  );
  assert.equal(flipped.candidates[0].decision, "accepted");
  const flippedReview = await getReviewState(rq.requestId);
  assert.deepEqual(
    flippedReview.blockers,
    [],
    "the recorded approval still matches its evidence",
  );
  assert.ok(
    flippedReview.tasks.every((task) => task.state === "completed"),
    "review stays closed",
  );
  const [flippedRow] = await enrichedRequests(defaultWaitThresholds, [
    rq.requestId,
  ]);
  assert.equal(flippedRow.phase, "approved");
  assert.equal(flippedRow.assetAssessmentStatus, "succeeded");
  assert.equal(
    await liveCallCount(),
    callsAtApproval,
    "the flip dispatched and billed nothing",
  );

  // A newly created request still assesses against the current catalog B.
  const nb = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Need created after the corpus flip.",
    content: draftContent("post-flip"),
    state: "ready",
  });
  const nbSubmitted = await submitRequest(alice, {
    draftId: nb.draftId,
    expectedRowVersion: nb.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded'
     WHERE status = 'queued' AND purpose = 'risk_assess'`,
  );
  const nbRun = await runWorkerOnce({
    provider: providerOf(() => JSON.stringify({ candidates: [] })),
  });
  assert.equal(nbRun?.outcome, "succeeded");
  const nbView = await requestView(alice, nbSubmitted.requestId, true);
  assert.equal(
    nbView.assetAssessment?.catalogCorpusHash,
    assessmentB.catalog_corpus_hash,
    "a new request uses the current catalog, not the pinned evidence",
  );

  await sql.unsafe(`
    UPDATE catalog_items SET current_version = ${catalogItem.current_version}
    WHERE id = '${catalogItem.id}'
  `);
  const restoredView = await requestView(alice, rq.requestId, true);
  assert.equal(
    restoredView.assetAssessment?.id,
    assessmentA.id,
    "restoration and the pin agree",
  );

  // ── 3. Rejection feedback invalidates asset reuse and reaches the model ──
  await drainQueue();
  const fbProposal = {
    title: "Feedback loop request",
    problem: "The office needs the feedback loop verified.",
    affectedPeople: "Office staff",
    acceptanceCriteria: ["Feedback reaches preparation"],
    requirements: [],
    constraints: [],
    unknowns: [],
  };
  const fb = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Need for the feedback loop.",
  });
  const fbIntake = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: fb.draftId,
  });
  const fbIntakeRun = await runWorkerOnce({
    provider: providerOf(() =>
      JSON.stringify({
        content: fbProposal,
        questions: [],
        services: [
          {
            offeringId: cited.id,
            fitBand: "possible",
            coverage: ["Hosts the application"],
            gaps: [],
            relatedOfferingKeys: [],
            rationale: "The offering hosts applications of this shape.",
          },
        ],
      }),
    ),
  });
  assert.equal(fbIntakeRun?.jobId, fbIntake.jobId);
  let fbState = await getIntakeState(alice, fb.draftId);
  const confirmed = await confirmIntake(alice, {
    draftId: fb.draftId,
    jobId: fbIntake.jobId,
    expectedRowVersion: fbState.rowVersion,
    content: fbProposal,
  });
  assert.ok(confirmed.assetJobId, "confirmation starts asset discovery");

  let captured = "";
  const capturing = (output: string): ModelProvider => ({
    async complete({ input }) {
      captured = input;
      return { outputText: output, inputTokens: 900, outputTokens: 400 };
    },
  });
  const fbAssetRun = await runWorkerOnce({
    provider: capturing(JSON.stringify({ candidates: [] })),
  });
  assert.equal(fbAssetRun?.jobId, confirmed.assetJobId);
  assert.ok(
    !captured.includes("serviceFeedback"),
    "no feedback exists before a rejection",
  );

  // Unchanged input: the cached asset result is reused with no new bill.
  const fbCallsBefore = await liveCallCount();
  const fbReuse = await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: fb.draftId,
  });
  assert.equal(
    fbReuse.jobId,
    confirmed.assetJobId,
    "unchanged input reuses the cached asset job",
  );
  assert.equal(await liveCallCount(), fbCallsBefore, "reuse bills nothing");

  // A recorded rejection with its reason changes the asset input.
  fbState = await getIntakeState(alice, fb.draftId);
  await decideService(alice, {
    draftId: fb.draftId,
    candidateId: fbState.candidates[0].candidateId,
    decision: "rejected",
    reason: "The office already has a covered arrangement.",
    expectedRowVersion: fbState.rowVersion,
  });
  const fbAsset2 = await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: fb.draftId,
  });
  assert.notEqual(
    fbAsset2.jobId,
    confirmed.assetJobId,
    "changed feedback invalidates the cached asset result",
  );
  const fbRun2 = await runWorkerOnce({
    provider: capturing(JSON.stringify({ candidates: [] })),
  });
  assert.equal(fbRun2?.jobId, fbAsset2.jobId);
  assert.ok(
    captured.includes("serviceFeedback") &&
      captured.includes("The office already has a covered arrangement."),
    "the rejection reason reaches the provider input",
  );
  assert.equal(
    await liveCallCount(),
    fbCallsBefore + 1,
    "exactly one new call for the changed input",
  );

  console.log(
    "cache-currency checks passed: A→B→A intake reuse with no new bill and " +
      "history preserved, corpus-identity assessment reversion, " +
      "approval-pinned evidence under later corpus flips, and an " +
      "identity-bound review gate that demands a fresh human outcome, " +
      "with rejection feedback invalidating asset reuse.",
  );
} finally {
  await sql.end();
}
