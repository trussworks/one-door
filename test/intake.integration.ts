// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { effectiveInput } from "../src/models/corpus.ts";
import {
  enqueueModelJob,
  runWorkerOnce,
  type ModelProvider,
} from "../src/models/index.ts";
import {
  answerClarification,
  answerIntake,
  askClarification,
  confirmIntake,
  createVisitor,
  decideService,
  getIntakeState,
  saveDraft,
  submitRequest,
  WorkflowError,
} from "../src/workflow/index.ts";
import { withDb, type ActorContext } from "../src/workflow/shared.ts";

const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at a fresh isolated database this check may write to.",
    );
  }
  return url;
}

async function runScript(name: string, url: string): Promise<void> {
  await run(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL(`scripts/${name}`, repoRoot)),
    ],
    {
      cwd: fileURLToPath(repoRoot),
      env: { ...process.env, DATABASE_URL: url },
    },
  );
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

const proposalContent = {
  title: "Deploy the grants tracker",
  problem: "Grant awards drift across spreadsheets.",
  affectedPeople: "Grants office staff",
  acceptanceCriteria: ["One tracked award list stays current"],
  requirements: ["State identity integration"],
  constraints: ["Data stays in Colorado systems"],
  unknowns: ["Expected launch quarter"],
};

function intakeOutput(args: {
  offeringId: string;
  questions: string[];
  content?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    content: args.content ?? proposalContent,
    questions: args.questions,
    services: [
      {
        offeringId: args.offeringId,
        fitBand: "possible",
        coverage: ["Application deployment path"],
        gaps: ["Grants workflow remains custom"],
        relatedOfferingKeys: [],
        rationale: "The offering hosts applications of this shape.",
      },
    ],
  });
}

const assetOutput = (catalogItemId: string) =>
  JSON.stringify({
    candidates: [
      {
        catalogItemId,
        fitBand: "possible",
        coverage: ["Tracks structured records"],
        gaps: ["No grants workflow"],
        dependencies: [],
        rationale: "The governed asset covers the tracking core.",
      },
    ],
  });

const riskOutput = (policyRuleId: string) =>
  JSON.stringify({
    findings: [
      {
        policyRuleId,
        kind: "supported_risk",
        evidence: "The request names state identity integration.",
        missingInformation: null,
        proposedSeverity: "moderate",
        rationale: "Identity integration falls under the cited rule.",
      },
    ],
  });

function providerOf(text: () => string): ModelProvider {
  return {
    async complete() {
      return { outputText: text(), inputTokens: 900, outputTokens: 400 };
    },
  };
}

async function queuedJobs(): Promise<Array<{ id: string; purpose: string }>> {
  return sql.unsafe<Array<{ id: string; purpose: string }>>(
    `SELECT id, purpose::text AS purpose FROM model_jobs
     WHERE status = 'queued' ORDER BY created_at`,
  );
}

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [persona] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' LIMIT 1`,
  );
  const [offering] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM service_offerings WHERE lifecycle = 'active' LIMIT 1`,
  );
  const [catalogItem] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     LIMIT 1`,
  );
  const [rule] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`,
  );
  const alice = await createVisitor();
  const reviewer: ActorContext = {
    actorId: persona.id,
    actingView: "contributor",
    visitorId: alice.visitorId,
  };

  // ── 1. Questions persist, capped at three total; raw need intact ─────────
  const rawNeed = "We need to track grant awards  (exact words, two spaces).";
  const draftA = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed,
  });
  const intakeOne = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: draftA.draftId,
  });
  const runOne = await runWorkerOnce({
    provider: providerOf(() =>
      intakeOutput({
        offeringId: offering.id,
        questions: [
          "How many programs are in scope?",
          "Who owns the award data today?",
          "Is personal information included?",
        ],
      }),
    ),
  });
  assert.equal(runOne?.jobId, intakeOne.jobId);
  assert.equal(runOne?.outcome, "succeeded");

  let stateA = await getIntakeState(alice, draftA.draftId);
  assert.equal(stateA.rawNeed, rawNeed, "raw need preserved exactly");
  assert.equal(stateA.questions.length, 3, "three generated questions");
  assert.equal(stateA.candidates.length, 1, "service candidate persisted");
  assert.equal(stateA.intakeJob?.status, "succeeded");

  // ── 2. Answers: turns, next job, replay, conflicts, staleness ────────────
  const answered = await answerIntake(alice, {
    draftId: draftA.draftId,
    jobId: intakeOne.jobId,
    expectedRowVersion: stateA.rowVersion,
    answers: [{ questionIndex: 0, answer: "Two programs in the first year." }],
  });
  assert.equal(answered.answered, 1);
  assert.notEqual(
    answered.intakeJobId,
    intakeOne.jobId,
    "the next intake job enqueues atomically with the answer",
  );
  const turnsInput = await withDb((db) =>
    effectiveInput(db, "intake_interpret", draftA.draftId),
  );
  assert.deepEqual(
    turnsInput.payload.turns,
    [
      {
        question: "How many programs are in scope?",
        answer: "Two programs in the first year.",
      },
    ],
    "the answered exchange joins the effective input",
  );

  const replayAnswer = await answerIntake(alice, {
    draftId: draftA.draftId,
    jobId: intakeOne.jobId,
    answers: [{ questionIndex: 0, answer: "Two programs in the first year." }],
  });
  assert.equal(replayAnswer.answered, 0, "a full replay is a no-op");
  await expectCode(
    "INVALID_STATE",
    () =>
      answerIntake(alice, {
        draftId: draftA.draftId,
        jobId: answered.intakeJobId,
        expectedRowVersion: answered.rowVersion,
        answers: [{ questionIndex: 0, answer: "A different answer." }],
      }),
    "conflicting answer to an answered question",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      answerIntake(alice, {
        draftId: draftA.draftId,
        jobId: answered.intakeJobId,
        expectedRowVersion: answered.rowVersion,
        answers: [
          { questionIndex: 1, answer: "First." },
          { questionIndex: 1, answer: "Second." },
        ],
      }),
    "duplicate question indices in one batch",
  );
  await expectCode(
    "NOT_FOUND",
    () =>
      answerIntake(alice, {
        draftId: draftA.draftId,
        jobId: randomUUID(),
        answers: [
          { questionIndex: 0, answer: "Two programs in the first year." },
        ],
      }),
    "a replay may not launder an unknown job id",
  );

  const runTwo = await runWorkerOnce({
    provider: providerOf(() =>
      intakeOutput({
        offeringId: offering.id,
        questions: [
          "What is the retention requirement?",
          "Which teams need read access?",
          "Is there a mandated go-live date?",
        ],
      }),
    ),
  });
  assert.equal(runTwo?.jobId, answered.intakeJobId);
  assert.equal(runTwo?.outcome, "succeeded");
  stateA = await getIntakeState(alice, draftA.draftId);
  assert.equal(
    stateA.questions.length,
    3,
    "three questions TOTAL across runs; a refinement never widens",
  );

  const editedDraft = await saveDraft(alice, {
    draftId: draftA.draftId,
    expectedRowVersion: stateA.rowVersion,
    rawNeed: rawNeed + " Now with a changed need.",
  });
  await expectCode(
    "INVALID_STATE",
    () =>
      answerIntake(alice, {
        draftId: draftA.draftId,
        jobId: answered.intakeJobId,
        expectedRowVersion: editedDraft.rowVersion,
        answers: [{ questionIndex: 1, answer: "The data office owns it." }],
      }),
    "a changed need forbids answering against the stale result",
  );

  // ── 3. Confirmation under the two-attempt budget ─────────────────────────
  await expectCode(
    "INVALID_STATE",
    () =>
      confirmIntake(alice, {
        draftId: draftA.draftId,
        jobId: answered.intakeJobId,
        expectedRowVersion: editedDraft.rowVersion,
        content: proposalContent,
      }),
    "a changed need forbids adopting the stale result",
  );
  // Both intake attempts are spent: a third enqueue is refused up front,
  // and an edited confirmation is refused too because its rediscovery
  // would be a third call. The requester's words stay saved either way.
  await expectCode(
    "INVALID_STATE",
    () =>
      enqueueModelJob(alice, {
        purpose: "intake_interpret",
        draftId: draftA.draftId,
      }),
    "a third intake attempt for one draft",
  );
  stateA = await getIntakeState(alice, draftA.draftId);
  await expectCode(
    "INVALID_STATE",
    () =>
      confirmIntake(alice, {
        draftId: draftA.draftId,
        jobId: answered.intakeJobId,
        expectedRowVersion: stateA.rowVersion,
        content: { ...proposalContent, title: "Deploy the grants tracker now" },
      }),
    "an edited confirmation cannot buy a third discovery call",
  );

  // Restoring the words makes the second result current again (identity,
  // not order), and adopting it verbatim spends no further attempt.
  const restored = await saveDraft(alice, {
    draftId: draftA.draftId,
    expectedRowVersion: stateA.rowVersion,
    rawNeed,
  });
  stateA = await getIntakeState(alice, draftA.draftId);
  assert.equal(stateA.intakeJob?.jobId, answered.intakeJobId);
  assert.equal(stateA.intakeJob?.current, true, "the reverted input revives");
  const confirmed = await confirmIntake(alice, {
    draftId: draftA.draftId,
    jobId: answered.intakeJobId,
    expectedRowVersion: restored.rowVersion,
    content: proposalContent,
  });
  assert.equal(confirmed.state, "ready");
  assert.equal(confirmed.fieldOrigins.problem, "model");
  assert.equal(
    confirmed.confirmedIntakeJobId,
    answered.intakeJobId,
    "verbatim adoption records the job it adopted",
  );
  assert.ok(confirmed.assetJobId, "asset discovery starts with confirmation");
  const [stepRow] = await sql.unsafe<{ current_step: string }[]>(
    `SELECT current_step FROM drafts WHERE id = '${draftA.draftId}'`,
  );
  assert.equal(stepRow.current_step, "options", "confirmed draft moves on");
  const confirmReplayResult = await confirmIntake(alice, {
    draftId: draftA.draftId,
    jobId: answered.intakeJobId,
    content: proposalContent,
  });
  assert.equal(
    confirmReplayResult.rowVersion,
    confirmed.rowVersion,
    "a reload of the confirmation is a no-op",
  );
  assert.equal(
    confirmReplayResult.assetJobId,
    confirmed.assetJobId,
    "the reload reports the actual recorded asset job",
  );
  const assetRun = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(assetRun?.jobId, confirmed.assetJobId);
  assert.equal(assetRun?.outcome, "succeeded");

  // ── 4. Service decisions carry evidence ──────────────────────────────────
  stateA = await getIntakeState(alice, draftA.draftId);
  const currentCandidate = stateA.candidates[0];
  assert.ok(currentCandidate, "the adopted result's candidate is visible");
  const rejected = await decideService(alice, {
    draftId: draftA.draftId,
    candidateId: currentCandidate.candidateId,
    decision: "rejected",
    reason: "The office prefers the existing shared service.",
    expectedRowVersion: stateA.rowVersion,
  });
  assert.equal(rejected.decision, "rejected");
  const [staleCandidate] = await sql.unsafe<{ id: string }[]>(
    `SELECT sc.id FROM service_candidates sc
     JOIN model_jobs j ON j.current_model_call_id = sc.model_call_id
     WHERE sc.draft_id = '${draftA.draftId}' AND j.id = '${intakeOne.jobId}'
     LIMIT 1`,
  );
  assert.ok(staleCandidate, "an earlier run's candidate exists");
  assert.notEqual(
    staleCandidate.id,
    currentCandidate.candidateId,
    "the regression targets the pre-edit run, not the current candidate",
  );
  await expectCode(
    "INVALID_STATE",
    () =>
      decideService(alice, {
        draftId: draftA.draftId,
        candidateId: staleCandidate.id,
        decision: "accepted",
        expectedRowVersion: rejected.rowVersion,
      }),
    "a superseded run's candidate is not usable evidence",
  );

  // ── 5. Submission commits preparation jobs and reuses the asset result ───
  const [callsBeforeSubmit] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM model_calls WHERE origin = 'live'`,
  );
  const submitted = await submitRequest(alice, {
    draftId: draftA.draftId,
    expectedRowVersion: rejected.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  assert.equal(submitted.routingState, "routing_requested");
  const [callsAfterSubmit] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM model_calls WHERE origin = 'live'`,
  );
  assert.equal(
    callsAfterSubmit.total,
    callsBeforeSubmit.total,
    "submission itself dispatches no model call",
  );
  // The recorded rejection is service feedback, and feedback is part of the
  // asset input identity: the confirmed result is no longer reusable, so
  // the submission commits a real asset refresh alongside risk — the
  // reviewer-serving preparation outside the intake budget.
  let queue = await queuedJobs();
  assert.deepEqual(
    queue.map((job) => job.purpose).sort(),
    ["asset_match", "risk_assess"],
    "rejection feedback forces a fresh asset evaluation after submission",
  );
  const refreshRun = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(refreshRun?.outcome, "succeeded");
  const riskRun = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(riskRun?.outcome, "succeeded");
  const [attached] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM asset_assessments a
     JOIN requests r ON r.current_revision_id = a.revision_id
     WHERE r.id = '${submitted.requestId}' AND a.status = 'succeeded'`,
  );
  assert.equal(
    Number(attached.total),
    1,
    "the refreshed asset result binds to revision 1",
  );

  // A clarification answer commits reassessment jobs the same way.
  const asked = await askClarification(reviewer, {
    requestId: submitted.requestId,
    question: "Which retention rule applies to award records?",
    expectedRowVersion: await (async () =>
      (
        await sql.unsafe<{ v: number }[]>(
          `SELECT row_version AS v FROM requests WHERE id = '${submitted.requestId}'`,
        )
      )[0].v)(),
  });
  const [requestRow] = await sql.unsafe<{ row_version: number }[]>(
    `SELECT row_version FROM requests WHERE id = '${submitted.requestId}'`,
  );
  await answerClarification(alice, {
    requestId: submitted.requestId,
    expectedRowVersion: Number(requestRow.row_version),
    clarificationId: asked.clarificationId,
    answer: "Seven years, per the records schedule.",
  });
  queue = await queuedJobs();
  assert.deepEqual(
    queue.map((job) => job.purpose).sort(),
    ["asset_match", "risk_assess"],
    "the answer commits both reassessment jobs atomically",
  );
  const settleOne = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(settleOne?.outcome, "succeeded");
  const settleTwo = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(settleTwo?.outcome, "succeeded");

  // ── 6. Selection needs a confirmed adoption and current candidate ────────
  const bella = await createVisitor();
  const draftB = await saveDraft(bella, {
    organizationId: organization.id,
    rawNeed: "A second need for the selection journey.",
  });
  const intakeB = await enqueueModelJob(bella, {
    purpose: "intake_interpret",
    draftId: draftB.draftId,
  });
  const runB = await runWorkerOnce({
    provider: providerOf(() =>
      intakeOutput({
        offeringId: offering.id,
        questions: ["Only one question here?"],
      }),
    ),
  });
  assert.equal(runB?.jobId, intakeB.jobId);
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      answerIntake(bella, {
        draftId: draftB.draftId,
        jobId: intakeB.jobId,
        answers: [{ questionIndex: 2, answer: "No such question." }],
      }),
    "an index beyond the generated questions",
  );
  let stateB = await getIntakeState(bella, draftB.draftId);
  const confirmedB = await confirmIntake(bella, {
    draftId: draftB.draftId,
    jobId: intakeB.jobId,
    expectedRowVersion: stateB.rowVersion,
    content: proposalContent,
  });
  assert.ok(
    Object.values(confirmedB.fieldOrigins).every(
      (origin) => origin === "model",
    ),
    "adopting the model content exactly records model origin per field",
  );
  assert.equal(
    confirmedB.confirmedIntakeJobId,
    intakeB.jobId,
    "exact adoption records the cited run as evidence",
  );
  const settleAssetB = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(settleAssetB?.outcome, "succeeded");

  // Cross-draft candidates are never usable.
  stateB = await getIntakeState(bella, draftB.draftId);
  const candidateB = stateB.candidates[0];
  await expectCode(
    "NOT_FOUND",
    () =>
      decideService(bella, {
        draftId: draftB.draftId,
        candidateId: currentCandidate.candidateId,
        decision: "accepted",
        expectedRowVersion: stateB.rowVersion,
      }),
    "a candidate from another draft",
  );

  // Editing content clears the adoption; selection then refuses.
  const editedB = await saveDraft(bella, {
    draftId: draftB.draftId,
    expectedRowVersion: confirmedB.rowVersion,
    content: { title: "Edited after confirmation" },
    state: "ready",
  });
  const stateAfterEdit = await getIntakeState(bella, draftB.draftId);
  assert.equal(
    stateAfterEdit.confirmedIntakeJobId,
    null,
    "editing content clears the recorded adoption",
  );
  await expectCode(
    "INVALID_STATE",
    () =>
      submitRequest(bella, {
        draftId: draftB.draftId,
        expectedRowVersion: editedB.rowVersion,
        rating: 4,
        idempotencyKey: randomUUID(),
        selectedServiceCandidateId: candidateB.candidateId,
      }),
    "selection refuses when the evidence no longer matches the content",
  );

  const intakeB2 = await enqueueModelJob(bella, {
    purpose: "intake_interpret",
    draftId: draftB.draftId,
  });
  const runB2 = await runWorkerOnce({
    provider: providerOf(() =>
      intakeOutput({
        offeringId: offering.id,
        questions: [],
        content: { ...proposalContent, title: "Edited after confirmation" },
      }),
    ),
  });
  assert.equal(runB2?.jobId, intakeB2.jobId);
  stateB = await getIntakeState(bella, draftB.draftId);
  const confirmedB2 = await confirmIntake(bella, {
    draftId: draftB.draftId,
    jobId: intakeB2.jobId,
    expectedRowVersion: stateB.rowVersion,
    content: { ...proposalContent, title: "Edited after confirmation" },
  });
  const settleAssetB2 = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(settleAssetB2?.outcome, "succeeded");
  stateB = await getIntakeState(bella, draftB.draftId);
  const currentB = stateB.candidates[0];
  const submittedB = await submitRequest(bella, {
    draftId: draftB.draftId,
    expectedRowVersion: confirmedB2.rowVersion,
    rating: 4,
    idempotencyKey: randomUUID(),
    selectedServiceCandidateId: currentB.candidateId,
  });
  assert.equal(
    submittedB.routingState,
    "service_selected",
    "selection with a confirmed adoption and current candidate succeeds",
  );
  const [acceptedRow] = await sql.unsafe<
    { decision: string; decided_by_actor_id: string }[]
  >(
    `SELECT decision::text AS decision, decided_by_actor_id
     FROM service_candidates WHERE id = '${currentB.candidateId}'`,
  );
  assert.equal(acceptedRow.decision, "accepted");
  assert.equal(
    acceptedRow.decided_by_actor_id,
    bella.actorId,
    "the acceptance records the deciding requester",
  );
  const settleRiskB = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(settleRiskB?.outcome, "succeeded");

  // ── 7. Offering-corpus drift invalidates even an exact adoption ──────────
  const carol = await createVisitor();
  const contentC = { ...proposalContent, title: "Journey C exact adoption" };
  const draftC = await saveDraft(carol, {
    organizationId: organization.id,
    rawNeed: "A third need for the corpus-drift journey.",
  });
  const intakeC = await enqueueModelJob(carol, {
    purpose: "intake_interpret",
    draftId: draftC.draftId,
  });
  const runC = await runWorkerOnce({
    provider: providerOf(() =>
      intakeOutput({
        offeringId: offering.id,
        questions: [],
        content: contentC,
      }),
    ),
  });
  assert.equal(runC?.jobId, intakeC.jobId);
  let stateC = await getIntakeState(carol, draftC.draftId);
  const confirmedC = await confirmIntake(carol, {
    draftId: draftC.draftId,
    jobId: intakeC.jobId,
    expectedRowVersion: stateC.rowVersion,
    content: contentC,
  });
  assert.equal(confirmedC.confirmedIntakeJobId, intakeC.jobId);
  const settleAssetC = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(settleAssetC?.outcome, "succeeded");
  stateC = await getIntakeState(carol, draftC.draftId);
  const candidateC = stateC.candidates[0];
  const acceptedC = await decideService(carol, {
    draftId: draftC.draftId,
    candidateId: candidateC.candidateId,
    decision: "accepted",
    expectedRowVersion: stateC.rowVersion,
  });
  assert.equal(acceptedC.decision, "accepted", "adopted evidence accepts");

  await sql.unsafe(`
    INSERT INTO service_offerings
      (id, offering_key, version, lifecycle, name, description,
       owner_organization_id, capabilities, prerequisites, review_date,
       content_hash)
    VALUES ('${randomUUID()}', 'probe-offering-${randomUUID().slice(0, 8)}', 1,
      'active', 'Probe Offering', 'A probe offering that changes the corpus.',
      '${organization.id}', '{}', '{}', '2026-09-01', 'probe-hash')
  `);
  await expectCode(
    "INVALID_STATE",
    () =>
      decideService(carol, {
        draftId: draftC.draftId,
        candidateId: candidateC.candidateId,
        decision: "accepted",
        expectedRowVersion: acceptedC.rowVersion,
      }),
    "offering-corpus drift invalidates adopted fit decisions",
  );
  await expectCode(
    "INVALID_STATE",
    () =>
      submitRequest(carol, {
        draftId: draftC.draftId,
        expectedRowVersion: acceptedC.rowVersion,
        rating: 5,
        idempotencyKey: randomUUID(),
        selectedServiceCandidateId: candidateC.candidateId,
      }),
    "offering-corpus drift invalidates adopted selection at submission",
  );

  // Recovery: rediscovery against the current corpus, then re-adoption.
  const intakeC2 = await enqueueModelJob(carol, {
    purpose: "intake_interpret",
    draftId: draftC.draftId,
  });
  assert.notEqual(intakeC2.jobId, intakeC.jobId, "new corpus, new job");
  const runC2 = await runWorkerOnce({
    provider: providerOf(() =>
      intakeOutput({
        offeringId: offering.id,
        questions: [],
        content: contentC,
      }),
    ),
  });
  assert.equal(runC2?.jobId, intakeC2.jobId);
  stateC = await getIntakeState(carol, draftC.draftId);
  const confirmedC2 = await confirmIntake(carol, {
    draftId: draftC.draftId,
    jobId: intakeC2.jobId,
    expectedRowVersion: stateC.rowVersion,
    content: contentC,
  });
  assert.equal(
    confirmedC2.confirmedIntakeJobId,
    intakeC2.jobId,
    "citing a current run with the same content re-adopts for real",
  );
  stateC = await getIntakeState(carol, draftC.draftId);
  const candidateC2 = stateC.candidates[0];
  const submittedC = await submitRequest(carol, {
    draftId: draftC.draftId,
    expectedRowVersion: confirmedC2.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
    selectedServiceCandidateId: candidateC2.candidateId,
  });
  assert.equal(submittedC.routingState, "service_selected");
  const settleRiskC = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(settleRiskC?.outcome, "succeeded");

  console.log(
    [
      "Intake slice checks passed:",
      "  questions persist as turns, three total across runs; raw need byte-for-byte intact",
      "  answers reply to their questions, join the effective input, and enqueue the next job atomically; replays no-op; stale results refuse",
      "  confirmation adopts the cited current result with per-field provenance; reloads no-op; asset discovery starts in-transaction",
      "  service decisions require current same-draft evidence; submission records the acceptance",
      "  submission and clarification answers commit preparation jobs atomically, and the confirmed asset result is reused for revision 1",
      "  edited confirmations preserve edits and rerun service discovery; old candidates never count as current",
      "  offering-corpus drift invalidates even exact adoptions until rediscovery and re-adoption",
      "  replays verify ownership and report actual job state; duplicate answer indexes fail validation",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
