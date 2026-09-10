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
  answerClarification,
  askClarification,
  confirmIntake,
  createVisitor,
  decideAssetFit,
  getAssetPreview,
  getIntakeState,
  getOwnDraft,
  resetFixtures,
  saveAssetDecision,
  saveDraft,
  submitRequest,
  WorkflowError,
  type ActorContext,
} from "../src/workflow/index.ts";
import { draftView, requestView } from "../src/server/request-views.ts";

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

const providerOf = (text: () => string): ModelProvider => ({
  async complete() {
    return { outputText: text(), inputTokens: 900, outputTokens: 400 };
  },
});

const assetOutput = (items: Array<{ id: string; rationale: string }>) =>
  JSON.stringify({
    candidates: items.map((item) => ({
      catalogItemId: item.id,
      fitBand: "possible",
      coverage: ["Covers the request"],
      gaps: [],
      dependencies: [],
      rationale: item.rationale,
    })),
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
  const items = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     ORDER BY item_key LIMIT 2`,
  );
  assert.equal(items.length, 2, "two published approved catalog items exist");
  const [itemOne, itemTwo] = items;
  const alice = await createVisitor();
  const bob = await createVisitor();
  const reviewer: ActorContext = {
    actorId: persona.id,
    actingView: "contributor",
    visitorId: alice.visitorId,
  };

  const proposal = {
    title: `Requester fit ${randomUUID().slice(0, 8)}`,
    problem: "The office needs an existing-asset check during intake.",
    affectedPeople: "Office staff",
    acceptanceCriteria: ["Fit verdicts survive into review"],
    requirements: [],
    constraints: [],
    unknowns: [],
  };

  // ── 1. Preview, guarded verdicts, and reviewer separation ────────────────
  await drainQueue();
  const draft = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Need for the requester fit journey.",
  });
  const intake = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: draft.draftId,
  });
  const intakeRun = await runWorkerOnce({
    provider: providerOf(() =>
      JSON.stringify({ content: proposal, questions: [], services: [] }),
    ),
  });
  assert.equal(intakeRun?.jobId, intake.jobId);
  const confirmed = await confirmIntake(alice, {
    draftId: draft.draftId,
    jobId: intake.jobId,
    expectedRowVersion: (await getOwnDraft(alice, draft.draftId)).rowVersion,
    content: proposal,
  });
  assert.ok(confirmed.assetJobId, "confirmation starts asset discovery");
  const assetRunA = await runWorkerOnce({
    provider: providerOf(() =>
      assetOutput([
        { id: itemOne.id, rationale: "run A first item" },
        { id: itemTwo.id, rationale: "run A second item" },
      ]),
    ),
  });
  assert.equal(assetRunA?.jobId, confirmed.assetJobId);

  let preview = await getAssetPreview(alice, draft.draftId);
  assert.equal(preview.assetJob?.status, "succeeded");
  assert.equal(preview.candidates.length, 2, "both candidates presented");
  assert.ok(
    preview.candidates.every((row) => row.fitDecision === null),
    "no verdicts yet",
  );
  assert.deepEqual(preview.decisions, []);
  const [candidateOne, candidateTwo] = preview.candidates;

  await expectCode(
    "VERSION_CONFLICT",
    () =>
      decideAssetFit(alice, {
        draftId: draft.draftId,
        candidateId: candidateOne.candidateId,
        decision: "accepted",
        expectedRowVersion: preview.rowVersion + 7,
      }),
    "a stale seen version",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      decideAssetFit(alice, {
        draftId: draft.draftId,
        candidateId: candidateTwo.candidateId,
        decision: "rejected",
        expectedRowVersion: preview.rowVersion,
      }),
    "rejection without a reason",
  );
  await expectCode(
    "NOT_OWNER",
    () =>
      decideAssetFit(bob, {
        draftId: draft.draftId,
        candidateId: candidateOne.candidateId,
        decision: "accepted",
        expectedRowVersion: preview.rowVersion,
      }),
    "another visitor's verdict",
  );
  await expectCode(
    "NOT_FOUND",
    () =>
      decideAssetFit(alice, {
        draftId: draft.draftId,
        candidateId: randomUUID(),
        decision: "accepted",
        expectedRowVersion: preview.rowVersion,
      }),
    "a candidate from nowhere",
  );

  const accepted = await decideAssetFit(alice, {
    draftId: draft.draftId,
    candidateId: candidateOne.candidateId,
    decision: "accepted",
    expectedRowVersion: preview.rowVersion,
  });
  const rejected = await decideAssetFit(alice, {
    draftId: draft.draftId,
    candidateId: candidateTwo.candidateId,
    decision: "rejected",
    reason: "Already covered by the county portal.",
    expectedRowVersion: accepted.rowVersion,
  });
  assert.equal(rejected.rowVersion, accepted.rowVersion + 1);

  preview = await getAssetPreview(alice, draft.draftId);
  assert.equal(preview.candidates[0].fitDecision?.decision, "accepted");
  assert.equal(preview.candidates[1].fitDecision?.decision, "rejected");
  assert.equal(
    preview.candidates[1].fitDecision?.reason,
    "Already covered by the county portal.",
  );
  assert.equal(preview.decisions.length, 2);
  assert.ok(preview.decisions.every((row) => row.current));
  const [reviewerRows] = await sql.unsafe<{ total: number }[]>(`
    SELECT count(*)::int AS total FROM asset_candidate_decisions
    WHERE candidate_id IN
      ('${candidateOne.candidateId}', '${candidateTwo.candidateId}')
  `);
  assert.equal(reviewerRows.total, 0, "reviewer decisions stay untouched");

  // ── 2. A -> B -> A reversion revives A's verdicts without a new bill ─────
  const editedB = await saveDraft(alice, {
    draftId: draft.draftId,
    content: { problem: "A different problem statement for run B." },
    expectedRowVersion: rejected.rowVersion,
  });
  await expectCode(
    "INVALID_STATE",
    () =>
      decideAssetFit(alice, {
        draftId: draft.draftId,
        candidateId: candidateOne.candidateId,
        decision: "accepted",
        expectedRowVersion: editedB.rowVersion,
      }),
    "a verdict on a superseded result",
  );
  const assetJobB = await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: draft.draftId,
  });
  assert.notEqual(assetJobB.jobId, confirmed.assetJobId);
  const assetRunB = await runWorkerOnce({
    provider: providerOf(() =>
      assetOutput([{ id: itemOne.id, rationale: "run B first item" }]),
    ),
  });
  assert.equal(assetRunB?.jobId, assetJobB.jobId);
  preview = await getAssetPreview(alice, draft.draftId);
  assert.equal(preview.candidates.length, 1);
  const rejectedOnB = await decideAssetFit(alice, {
    draftId: draft.draftId,
    candidateId: preview.candidates[0].candidateId,
    decision: "rejected",
    reason: "The B variant does not need the portal.",
    expectedRowVersion: preview.rowVersion,
  });
  preview = await getAssetPreview(alice, draft.draftId);
  assert.equal(preview.decisions.length, 3);
  assert.equal(
    preview.decisions.filter((row) => row.current).length,
    1,
    "only the B verdict is current on B",
  );

  const callsBeforeReversion = await liveCallCount();
  const revertedA = await saveDraft(alice, {
    draftId: draft.draftId,
    content: { problem: proposal.problem },
    expectedRowVersion: rejectedOnB.rowVersion,
  });
  const reusedA = await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: draft.draftId,
  });
  assert.equal(
    reusedA.jobId,
    confirmed.assetJobId,
    "the reverted input reuses A's job",
  );
  assert.equal(await liveCallCount(), callsBeforeReversion, "no new bill");
  preview = await getAssetPreview(alice, draft.draftId);
  assert.equal(preview.candidates.length, 2, "A's candidates are back");
  assert.equal(preview.candidates[0].fitDecision?.decision, "accepted");
  assert.equal(preview.candidates[1].fitDecision?.decision, "rejected");
  assert.equal(preview.decisions.length, 3, "B's verdict stays visible");
  const bRow = preview.decisions.find(
    (row) => row.reason === "The B variant does not need the portal.",
  );
  assert.equal(bRow?.current, false, "B's verdict is history on A");

  // One combined snapshot: the current logical job, not creation order,
  // drives every surface of the draft view.
  const coherent = await draftView(alice, draft.draftId);
  assert.equal(
    coherent.currentJobs.asset_match?.jobId,
    confirmed.assetJobId,
    "the combined view reports the current logical job",
  );
  assert.equal(
    coherent.jobs[0].jobId,
    assetJobB.jobId,
    "newest-created history is a different job",
  );
  assert.equal(
    coherent.assetPreview.assetJob?.jobId,
    coherent.currentJobs.asset_match?.jobId,
    "asset preview and job status agree",
  );
  assert.equal(
    coherent.draft.rowVersion,
    coherent.intake.rowVersion,
    "draft and intake describe the same committed moment",
  );

  // ── 3. Verdicts survive submission, reviewer independence, reset, revision ──
  const ready = await saveDraft(alice, {
    draftId: draft.draftId,
    state: "ready",
    expectedRowVersion: revertedA.rowVersion,
  });
  const callsBeforeSubmit = await liveCallCount();
  const submitted = await submitRequest(alice, {
    draftId: draft.draftId,
    expectedRowVersion: ready.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  assert.equal(
    await liveCallCount(),
    callsBeforeSubmit,
    "submission reuses the pre-submit asset result",
  );
  let view = await requestView(alice, submitted.requestId, true);
  assert.equal(view.assetFitDecisions.length, 3);
  assert.equal(
    view.assetFitDecisions.filter((row) => row.current).length,
    2,
    "A's verdicts are current in the reviewer view",
  );
  assert.ok(
    view.candidates.every((row) => row.decision === null),
    "reviewer candidate decisions start empty",
  );

  const reviewedCandidate = view.candidates.find(
    (row) => row.catalogItemId === itemOne.id,
  );
  assert.ok(reviewedCandidate, "the accepted item reached reviewer candidates");
  await saveAssetDecision(reviewer, {
    requestId: submitted.requestId,
    candidateId: reviewedCandidate.id,
    decision: "accepted",
    expectedRowVersion: view.record.rowVersion,
  });
  view = await requestView(alice, submitted.requestId, true);
  assert.equal(
    view.candidates.find((row) => row.catalogItemId === itemOne.id)?.decision,
    "accepted",
  );
  assert.equal(
    view.assetFitDecisions.length,
    3,
    "a reviewer decision adds no requester verdict",
  );

  await resetFixtures(reviewer);
  view = await requestView(alice, submitted.requestId, true);
  assert.equal(
    view.assetFitDecisions.filter((row) => row.current).length,
    2,
    "a fixture reset changes nothing for the live request",
  );

  await drainQueue();
  const asked = await askClarification(reviewer, {
    requestId: submitted.requestId,
    question: "Which teams use the portal today?",
    expectedRowVersion: view.record.rowVersion,
  });
  const [openQuestion] = await sql.unsafe<{ id: string }[]>(`
    SELECT id FROM clarification_requests
    WHERE request_id = '${submitted.requestId}' AND answered_at IS NULL
  `);
  await answerClarification(alice, {
    requestId: submitted.requestId,
    clarificationId: openQuestion.id,
    answer: "Every records team in the office.",
    expectedRowVersion: asked.rowVersion,
  });
  const supersedingJob = await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: draft.draftId,
    requestId: submitted.requestId,
  });
  assert.notEqual(supersedingJob.jobId, confirmed.assetJobId);
  const supersedingRun = await runWorkerOnce({
    provider: providerOf(() =>
      assetOutput([{ id: itemOne.id, rationale: "after the answer" }]),
    ),
  });
  assert.equal(supersedingRun?.jobId, supersedingJob.jobId);
  view = await requestView(alice, submitted.requestId, true);
  assert.equal(view.assetFitDecisions.length, 3, "history is never dropped");
  assert.ok(
    view.assetFitDecisions.every((row) => !row.current),
    "an answered clarification supersedes every prior verdict",
  );
  assert.equal(
    view.currentJobs.asset_match?.jobId,
    supersedingJob.jobId,
    "the request view reports the current logical asset job",
  );

  // ── 4. Stable draft creation with a caller creation key ──────────────────
  const keyOne = `create-${randomUUID()}`;
  const creation = {
    organizationId: organization.id,
    rawNeed: "Need created exactly once.",
    creationKey: keyOne,
  };
  const first = await saveDraft(alice, creation);
  const replay = await saveDraft(alice, creation);
  assert.equal(replay.draftId, first.draftId, "the replay returns the draft");
  const [keyRows] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM drafts WHERE creation_key = '${keyOne}'`,
  );
  assert.equal(keyRows.total, 1, "one draft per creation key");

  const progressed = await saveDraft(alice, {
    draftId: first.draftId,
    rawNeed: "Progressed past creation.",
    expectedRowVersion: first.rowVersion,
  });
  const lateReplay = await saveDraft(alice, creation);
  assert.equal(lateReplay.rowVersion, progressed.rowVersion);
  assert.equal(
    (await getOwnDraft(alice, first.draftId)).rawNeed,
    "Progressed past creation.",
    "a stale replay never overwrites progress",
  );

  await expectCode(
    "VALIDATION_FAILED",
    () => saveDraft(alice, { ...creation, rawNeed: "A different need." }),
    "the same key with different content",
  );
  await expectCode(
    "NOT_OWNER",
    () => saveDraft(bob, creation),
    "the same key from another visitor",
  );

  const keyTwo = `create-${randomUUID()}`;
  const concurrent = {
    organizationId: organization.id,
    rawNeed: "Need created concurrently.",
    creationKey: keyTwo,
  };
  const [left, right] = await Promise.all([
    saveDraft(alice, concurrent),
    saveDraft(alice, concurrent),
  ]);
  assert.equal(left.draftId, right.draftId, "concurrent creates converge");
  const [concurrentRows] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM drafts WHERE creation_key = '${keyTwo}'`,
  );
  assert.equal(concurrentRows.total, 1);

  const keyThree = `create-${randomUUID()}`;
  const submittable = {
    organizationId: organization.id,
    rawNeed: "Need that gets submitted.",
    content: { ...proposal, title: `Submitted creation ${keyThree}` },
    state: "ready" as const,
    creationKey: keyThree,
  };
  const toSubmit = await saveDraft(alice, submittable);
  await submitRequest(alice, {
    draftId: toSubmit.draftId,
    expectedRowVersion: toSubmit.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  const submittedReplay = await saveDraft(alice, submittable);
  assert.equal(submittedReplay.draftId, toSubmit.draftId);
  assert.equal(
    submittedReplay.state,
    "submitted",
    "a replay reports the submitted draft as it stands",
  );

  // ── 5. The database enforces insert-only and same-draft ancestry ─────────
  const probeDecisionId = preview.decisions[0].id;
  await assert.rejects(
    sql.unsafe(
      `UPDATE asset_fit_decisions SET reason = 'rewritten'
       WHERE id = '${probeDecisionId}'`,
    ),
    /append-only/,
    "verdicts cannot be rewritten",
  );
  await assert.rejects(
    sql.unsafe(
      `DELETE FROM asset_fit_decisions WHERE id = '${probeDecisionId}'`,
    ),
    /append-only/,
    "verdicts cannot be deleted",
  );
  const [aLineage] = await sql.unsafe<{ assessment_id: string }[]>(
    `SELECT assessment_id FROM asset_candidates
     WHERE id = '${candidateOne.candidateId}'`,
  );
  const [bLineage] = await sql.unsafe<{ assessment_id: string }[]>(
    `SELECT assessment_id FROM asset_candidates
     WHERE id = '${rejectedOnB.candidateId}'`,
  );
  await assert.rejects(
    sql.unsafe(
      `INSERT INTO asset_fit_decisions
        (id, draft_id, candidate_id, assessment_id, decision, visitor_id, actor_id)
       VALUES ('${randomUUID()}', '${first.draftId}',
        '${candidateOne.candidateId}', '${aLineage.assessment_id}',
        'accepted', '${alice.visitorId}', '${alice.actorId}')`,
    ),
    /asset_fit_decisions_draft_ancestry_fk/,
    "a verdict cannot claim another draft's ancestry",
  );
  await assert.rejects(
    sql.unsafe(
      `INSERT INTO asset_fit_decisions
        (id, draft_id, candidate_id, assessment_id, decision, visitor_id, actor_id)
       VALUES ('${randomUUID()}', '${draft.draftId}',
        '${candidateOne.candidateId}', '${bLineage.assessment_id}',
        'accepted', '${alice.visitorId}', '${alice.actorId}')`,
    ),
    /asset_fit_decisions_candidate_ancestry_fk/,
    "a verdict cannot pair a candidate with another assessment",
  );

  // ── 6. Corpus drift with no replacement job reads stale, not current ─────
  await drainQueue();
  const d6Proposal = {
    ...proposal,
    title: `Drift check ${randomUUID().slice(0, 8)}`,
  };
  const d6 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Need for the drift check.",
  });
  const d6Intake = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: d6.draftId,
  });
  await runWorkerOnce({
    provider: providerOf(() =>
      JSON.stringify({ content: d6Proposal, questions: [], services: [] }),
    ),
  });
  await confirmIntake(alice, {
    draftId: d6.draftId,
    jobId: d6Intake.jobId,
    expectedRowVersion: (await getOwnDraft(alice, d6.draftId)).rowVersion,
    content: d6Proposal,
  });
  await runWorkerOnce({
    provider: providerOf(() =>
      assetOutput([{ id: itemOne.id, rationale: "the drift-check proposal" }]),
    ),
  });
  let d6Preview = await getAssetPreview(alice, d6.draftId);
  assert.equal(d6Preview.assetJob?.current, true);
  const [d6Candidate] = d6Preview.candidates;
  const [seededItem] = await sql.unsafe<{ name: string }[]>(
    `SELECT name FROM catalog_items WHERE id = '${itemOne.id}'`,
  );
  assert.equal(
    d6Candidate.name,
    seededItem.name,
    "the preview names the item, not its UUID",
  );
  const d6Accepted = await decideAssetFit(alice, {
    draftId: d6.draftId,
    candidateId: d6Candidate.candidateId,
    decision: "accepted",
    expectedRowVersion: d6Preview.rowVersion,
  });

  // The catalog corpus drifts; no replacement job is enqueued.
  await sql.unsafe(
    `UPDATE catalog_items SET current_version = current_version + 1
     WHERE id = '${itemOne.id}'`,
  );
  d6Preview = await getAssetPreview(alice, d6.draftId);
  assert.equal(d6Preview.assetJob?.status, "succeeded", "the old run remains");
  assert.equal(
    d6Preview.assetJob?.current,
    false,
    "a fallback success is not presented as current",
  );
  assert.deepEqual(
    d6Preview.candidates,
    [],
    "a drifted corpus offers no actionable recommendation",
  );
  assert.ok(
    d6Preview.decisions.length === 1 && !d6Preview.decisions[0].current,
    "the verdict stays visible as history",
  );
  await expectCode(
    "INVALID_STATE",
    () =>
      decideAssetFit(alice, {
        draftId: d6.draftId,
        candidateId: d6Candidate.candidateId,
        decision: "rejected",
        reason: "Trying to act on a stale result.",
        expectedRowVersion: d6Accepted.rowVersion,
      }),
    "the read and the action agree on staleness",
  );

  // The offering corpus drifts too: the intake surface reads stale alike.
  const [toggledOffering] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM service_offerings WHERE lifecycle = 'active'
     ORDER BY id LIMIT 1`,
  );
  await sql.unsafe(
    `UPDATE service_offerings SET lifecycle = 'retired'
     WHERE id = '${toggledOffering.id}'`,
  );
  const d6Intake2 = await getIntakeState(alice, d6.draftId);
  assert.equal(d6Intake2.intakeJob?.status, "succeeded");
  assert.equal(d6Intake2.intakeJob?.current, false);
  assert.equal(
    d6Intake2.intakeJob?.proposal,
    null,
    "a stale intake run offers no current proposal",
  );
  assert.deepEqual(d6Intake2.candidates, []);
  const d6Combined = await draftView(alice, d6.draftId);
  assert.equal(
    d6Combined.currentJobs.asset_match?.current,
    false,
    "the combined view flags the stale preparation for retry",
  );
  await sql.unsafe(
    `UPDATE service_offerings SET lifecycle = 'active'
     WHERE id = '${toggledOffering.id}'`,
  );
  await sql.unsafe(
    `UPDATE catalog_items SET current_version = current_version - 1
     WHERE id = '${itemOne.id}'`,
  );
  d6Preview = await getAssetPreview(alice, d6.draftId);
  assert.equal(d6Preview.assetJob?.current, true, "restoration revives A");
  assert.equal(d6Preview.candidates[0]?.fitDecision?.decision, "accepted");

  // A later catalog rename never rewrites what the requester saw.
  await sql.unsafe(
    `UPDATE catalog_items SET name = 'Renamed after the proposal'
     WHERE id = '${itemOne.id}'`,
  );
  d6Preview = await getAssetPreview(alice, d6.draftId);
  assert.equal(
    d6Preview.candidates[0].name,
    seededItem.name,
    "the preview keeps the proposal-time name",
  );
  assert.equal(
    d6Preview.decisions[0].name,
    seededItem.name,
    "history keeps the proposal-time name",
  );
  assert.equal(
    d6Preview.decisions[0].rationale,
    "the drift-check proposal",
    "history retains the original proposal text",
  );
  await sql.unsafe(
    `UPDATE catalog_items SET name = '${seededItem.name.replace(/'/g, "''")}'
     WHERE id = '${itemOne.id}'`,
  );

  console.log(
    "requester-fit checks passed: guarded current-result asset verdicts " +
      "separate from reviewer decisions, A->B->A verdict revival without " +
      "a new bill, verdicts current through unchanged submission and reset " +
      "and superseded by an answered clarification, replayable draft " +
      "creation that never duplicates or overwrites, a coherent combined " +
      "draft view reporting current logical jobs, and database-enforced " +
      "insert-only same-draft verdict history, stale reads on corpus drift before any replacement job, and retained proposal-time names and text.",
  );
  const beforeUndecided = await getAssetPreview(alice, d6.draftId);
  const cleared = await decideAssetFit(alice, {
    draftId: d6.draftId,
    candidateId: d6Candidate.candidateId,
    decision: "cleared",
    expectedRowVersion: beforeUndecided.rowVersion,
  });
  const afterUndecided = await getAssetPreview(alice, d6.draftId);
  assert.equal(afterUndecided.rowVersion, cleared.rowVersion);
  assert.equal(afterUndecided.candidates[0].fitDecision?.decision, "cleared");
  assert.ok(
    afterUndecided.decisions.some(
      (row) => row.decision === "accepted" && !row.current,
    ),
  );
  assert.equal(afterUndecided.decisions.filter((row) => row.current).length, 1);
  console.log(
    "Undecided fit is persisted without deleting earlier acceptance.",
  );
} finally {
  await sql.end();
}
