// Use a fresh isolated DATABASE_URL: cap probes exhaust the test database's quota.
// All dispatches use an injected provider, never a billable one.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import {
  answerClarification,
  askClarification,
  createVisitor,
  saveDraft,
  submitRequest,
  WorkflowError,
} from "../src/workflow/index.ts";
import { withDb } from "../src/workflow/shared.ts";
import { providerOutputSchema } from "../src/models/contracts.ts";
import {
  enqueueModelJob,
  getModelJob,
  getQuotaStatus,
  modelCaps,
  modelPrompts,
  retryModelJob,
  runWorkerOnce,
  type ModelProvider,
} from "../src/models/index.ts";
import {
  buildProviderInput,
  collectCorpus,
  effectiveInput,
} from "../src/models/corpus.ts";
import {
  anthropicProvider,
  defaultModel,
  maxOutputTokens,
  reservationTokenBound,
  reservedCostMicros,
  resolveRates,
} from "../src/models/provider.ts";

const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at a NEW isolated database this check may write to.",
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

const fullContent = {
  title: "Deploy the grants tracking application",
  problem: "Grant awards are tracked in spreadsheets that drift apart.",
  affectedPeople: "Grants office staff across three programs",
  acceptanceCriteria: ["A single tracked award list stays current"],
  requirements: ["State identity integration"],
  constraints: ["Data stays in Colorado systems"],
  unknowns: ["Expected launch quarter"],
};

let organization: { id: string };

async function readyDraft(visitor: { visitorId: string }, title: string) {
  const draft = await saveDraft(visitor, {
    organizationId: organization.id,
    rawNeed: `We need ${title}.`,
    content: { ...fullContent, title },
    state: "ready",
  });
  return draft;
}

async function submitDraft(
  visitor: { visitorId: string },
  draftId: string,
  rowVersion: number,
) {
  return submitRequest(visitor, {
    draftId,
    expectedRowVersion: rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
    // Ignored unless current service suggestions exist without a selection;
    // then submission requires the recorded rejection.
    rejectionReason: "The office routes this need to OIT directly.",
  });
}

function providerOf(
  fn: () => Promise<string> | string,
  usage = { inputTokens: 1000, outputTokens: 500 },
): ModelProvider {
  return {
    async complete() {
      return { outputText: await fn(), ...usage };
    },
  };
}

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

const assetOutput = (catalogItemId: string) =>
  JSON.stringify({
    candidates: [
      {
        catalogItemId,
        fitBand: "possible",
        coverage: ["Tracks structured records"],
        gaps: ["No grants-specific workflow"],
        dependencies: ["State identity integration"],
        rationale: "The governed asset covers the tracking core.",
      },
    ],
  });

const intakeOutput = (offeringId: string) =>
  JSON.stringify({
    content: fullContent,
    questions: ["Which programs adopt the tracker first?"],
    services: [
      {
        offeringId,
        fitBand: "possible",
        coverage: ["Application deployment path"],
        gaps: ["Grants workflow remains custom"],
        relatedOfferingKeys: [],
        rationale: "The offering hosts applications of this shape.",
      },
    ],
  });

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [persona] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' LIMIT 1`,
  );
  const [catalogItem] = await sql.unsafe<{ id: string; version: number }[]>(
    `SELECT id, current_version AS version FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     LIMIT 1`,
  );
  const [offering] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM service_offerings WHERE lifecycle = 'active' LIMIT 1`,
  );
  const [rule] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`,
  );
  const reviewer = { actorId: persona.id, actingView: "contributor" as const };

  // The cap scenarios spend most of the monthly budget, so a rerun on the
  // same database this month cannot work; fail here with a clear message.
  const startQuota = await getQuotaStatus();
  assert.ok(
    startQuota.monthlySpend.used + 1_000_000 < modelCaps.monthlySpendMicros,
    "monthly budget already consumed; supply a fresh database",
  );

  // ── 1. Logical job identity ──────────────────────────────────────────────
  const alice = await createVisitor();
  const draftA = await readyDraft(alice, "journey A");
  const jobA = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: draftA.draftId,
  });
  assert.equal(jobA.status, "queued");
  const jobADuplicate = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: draftA.draftId,
  });
  assert.equal(jobADuplicate.jobId, jobA.jobId, "duplicate enqueue reuses");
  await expectCode(
    "NOT_FOUND",
    () =>
      enqueueModelJob(alice, {
        purpose: "intake_interpret",
        draftId: randomUUID(),
      }),
    "enqueue for a missing draft",
  );

  // ── 2. Successful dispatch persists ledger and proposals ─────────────────
  const intakeRun = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id)),
  });
  assert.equal(intakeRun?.jobId, jobA.jobId, "oldest job first");
  assert.equal(intakeRun?.outcome, "succeeded");

  const submittedA = await submitDraft(
    alice,
    draftA.draftId,
    draftA.rowVersion,
  );
  const jobB = await enqueueModelJob(alice, {
    purpose: "asset_match",
    draftId: draftA.draftId,
    requestId: submittedA.requestId,
  });
  const assetRun = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(assetRun?.jobId, jobB.jobId);
  const settledB = await getModelJob(jobB.jobId);
  assert.equal(settledB.status, "succeeded", "asset job succeeded");
  assert.equal(settledB.currentCall?.status, "succeeded");
  assert.ok(
    (settledB.currentCall?.actualCostMicros ?? 0) > 0,
    "actual cost recorded from usage",
  );
  const [assessmentB] = await sql.unsafe<
    { id: string; revision_id: string | null; origin: string }[]
  >(
    `SELECT a.id, a.revision_id, a.origin FROM asset_assessments a
     WHERE a.model_call_id = '${settledB.currentCall?.id}'
       AND a.status = 'succeeded'`,
  );
  assert.ok(assessmentB, "succeeded assessment persisted");
  assert.equal(assessmentB.origin, "live");
  assert.ok(assessmentB.revision_id, "assessment references the revision");
  const [candidateB] = await sql.unsafe<
    { catalog_item_id: string; catalog_version: number }[]
  >(
    `SELECT catalog_item_id, catalog_version FROM asset_candidates
     WHERE assessment_id = '${assessmentB.id}'`,
  );
  assert.equal(candidateB.catalog_item_id, catalogItem.id);
  assert.equal(
    Number(candidateB.catalog_version),
    Number(catalogItem.version),
    "candidate carries the corpus version source reference",
  );

  // ── 3. Bad output, one auto-retry, durable failure, manual retry ─────────
  const jobC = await enqueueModelJob(alice, {
    purpose: "risk_assess",
    draftId: draftA.draftId,
    requestId: submittedA.requestId,
  });
  const badId = await runWorkerOnce({
    provider: providerOf(() => riskOutput(randomUUID())),
  });
  assert.equal(badId?.jobId, jobC.jobId);
  assert.equal(badId?.outcome, "retry_queued", "unknown id queues one retry");
  let stateC = await getModelJob(jobC.jobId);
  assert.equal(stateC.attemptCount, 1);
  assert.equal(stateC.currentCall?.sanitizedError, "unknown_identifier");

  const malformed = await runWorkerOnce({
    provider: providerOf(() => "not json at all"),
  });
  assert.equal(malformed?.outcome, "failed", "second failure is durable");
  stateC = await getModelJob(jobC.jobId);
  assert.equal(stateC.status, "failed");
  assert.equal(stateC.attemptCount, 2);
  const [failedRisk] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM risk_assessments
     WHERE draft_id = '${draftA.draftId}' AND status = 'failed'`,
  );
  assert.equal(Number(failedRisk.total), 1, "honest failed assessment exists");

  await retryModelJob(alice, { jobId: jobC.jobId });
  const retried = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(retried?.outcome, "succeeded", "manual retry can succeed");
  const [findingRow] = await sql.unsafe<{ policy_rule_id: string }[]>(
    `SELECT f.policy_rule_id FROM risk_findings f
     JOIN risk_assessments a ON a.id = f.assessment_id
     WHERE a.draft_id = '${draftA.draftId}' AND a.status = 'succeeded'`,
  );
  assert.equal(findingRow.policy_rule_id, rule.id, "finding cites the rule");
  await expectCode(
    "INVALID_STATE",
    () => retryModelJob(alice, { jobId: jobC.jobId }),
    "retry of a succeeded job",
  );

  // ── 4. Expired lease recovery keeps the reservation ──────────────────────
  const bella = await createVisitor();
  const draftE = await readyDraft(bella, "journey E");
  const jobE = await enqueueModelJob(bella, {
    purpose: "intake_interpret",
    draftId: draftE.draftId,
  });
  const orphanCallId = randomUUID();
  await sql.unsafe(`
    INSERT INTO model_calls
      (id, draft_id, visitor_id, purpose, provider, model, prompt_version,
       input_hash, corpus_versions, status, attempt_count,
       reserved_cost_micros, idempotency_key, origin)
    SELECT '${orphanCallId}', '${draftE.draftId}', visitor_id, 'intake_interpret',
       'anthropic', '${defaultModel}', 'intake-v1', input_hash, '{}', 'reserved',
       1, 1000, '${randomUUID()}', 'live'
    FROM model_jobs WHERE id = '${jobE.jobId}'
  `);
  await sql.unsafe(`
    UPDATE model_jobs SET status = 'leased', lease_owner = 'crashed-worker',
      lease_token = '${randomUUID()}',
      lease_expires_at = now() - interval '1 minute', attempt_count = 1,
      current_model_call_id = '${orphanCallId}'
    WHERE id = '${jobE.jobId}'
  `);
  const recovered = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id)),
  });
  assert.equal(recovered?.jobId, jobE.jobId);
  assert.equal(recovered?.outcome, "succeeded", "reclaimed lease completes");
  const [orphan] = await sql.unsafe<
    {
      status: string;
      sanitized_error: string;
      reserved_cost_micros: number;
      actual_cost_micros: number | null;
    }[]
  >(
    `SELECT status, sanitized_error, reserved_cost_micros, actual_cost_micros
     FROM model_calls WHERE id = '${orphanCallId}'`,
  );
  assert.equal(orphan.status, "failed", "interrupted call reconciled");
  assert.equal(orphan.sanitized_error, "lease_expired");
  assert.equal(Number(orphan.reserved_cost_micros), 1000);
  assert.equal(orphan.actual_cost_micros, null, "reservation stays charged");
  const [candidateCount] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM service_candidates
     WHERE draft_id = '${draftE.draftId}'`,
  );
  assert.ok(Number(candidateCount.total) >= 1, "intake proposals persisted");

  // ── 5. Superseded revisions and answers in the effective input ───────────
  const carol = await createVisitor();
  const draftF = await readyDraft(carol, "journey F");
  const submittedF = await submitDraft(
    carol,
    draftF.draftId,
    draftF.rowVersion,
  );
  const jobF = await enqueueModelJob(carol, {
    purpose: "risk_assess",
    draftId: draftF.draftId,
    requestId: submittedF.requestId,
  });
  const beforeAnswer = await withDb((db) =>
    effectiveInput(db, "risk_assess", draftF.draftId, submittedF.requestId),
  );
  const askedF = await askClarification(reviewer, {
    requestId: submittedF.requestId,
    question: "Which programs are in scope for year one?",
    expectedRowVersion: await (async () =>
      (
        await sql.unsafe<{ v: number }[]>(
          `SELECT row_version AS v FROM requests WHERE id = '${submittedF.requestId}'`,
        )
      )[0].v)(),
  });
  const [requestFRow] = await sql.unsafe<{ row_version: number }[]>(
    `SELECT row_version FROM requests WHERE id = '${submittedF.requestId}'`,
  );
  await answerClarification(carol, {
    requestId: submittedF.requestId,
    expectedRowVersion: Number(requestFRow.row_version),
    clarificationId: askedF.clarificationId,
    answer: "Only the two largest programs join in year one.",
  });
  const afterAnswer = await withDb((db) =>
    effectiveInput(db, "risk_assess", draftF.draftId, submittedF.requestId),
  );
  assert.notEqual(
    beforeAnswer.hash,
    afterAnswer.hash,
    "an answer changes the effective input even without content changes",
  );

  // The answer superseded the pre-answer job atomically, with zero spend.
  const supersededF = await getModelJob(jobF.jobId);
  assert.equal(
    supersededF.status,
    "superseded",
    "the answer supersedes the stale job in its own transaction",
  );
  assert.equal(supersededF.currentCall, null, "no spend for a superseded job");
  // Settle the answer's asset reassessment so only the risk job stays queued.
  const settleAssetF = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(settleAssetF?.outcome, "succeeded");

  // A result that finishes after the revision moved is provenance only.
  const jobF2 = await enqueueModelJob(carol, {
    purpose: "risk_assess",
    draftId: draftF.draftId,
    requestId: submittedF.requestId,
  });
  assert.equal(jobF2.status, "queued");
  const askedF2 = await askClarification(reviewer, {
    requestId: submittedF.requestId,
    question: "Does the data include personal information?",
    expectedRowVersion: await (async () =>
      (
        await sql.unsafe<{ v: number }[]>(
          `SELECT row_version AS v FROM requests WHERE id = '${submittedF.requestId}'`,
        )
      )[0].v)(),
  });
  const lateAnswerProvider: ModelProvider = {
    async complete() {
      const [rowF] = await sql.unsafe<{ row_version: number }[]>(
        `SELECT row_version FROM requests WHERE id = '${submittedF.requestId}'`,
      );
      await answerClarification(carol, {
        requestId: submittedF.requestId,
        expectedRowVersion: Number(rowF.row_version),
        clarificationId: askedF2.clarificationId,
        answer: "Yes, award records include applicant names.",
      });
      return {
        outputText: riskOutput(rule.id),
        inputTokens: 1000,
        outputTokens: 500,
      };
    },
  };
  const lateRun = await runWorkerOnce({ provider: lateAnswerProvider });
  assert.equal(lateRun?.jobId, jobF2.jobId);
  assert.equal(lateRun?.outcome, "superseded", "late result never current");
  const lateState = await getModelJob(jobF2.jobId);
  assert.equal(
    lateState.currentCall?.status,
    "succeeded",
    "the paid result stays on the ledger as provenance",
  );
  const [lateProposals] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM risk_assessments
     WHERE model_call_id = '${lateState.currentCall?.id}'`,
  );
  assert.equal(Number(lateProposals.total), 0, "no proposals from stale run");
  // Settle the late answer's reassessment jobs before the next journey.
  const settleF3a = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(settleF3a?.outcome, "succeeded");
  const settleF3b = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(settleF3b?.outcome, "succeeded");

  // ── 6. Unchanged asset result attaches to the submitted revision ─────────
  const dana = await createVisitor();
  const draftG = await readyDraft(dana, "journey G");
  const jobG = await enqueueModelJob(dana, {
    purpose: "asset_match",
    draftId: draftG.draftId,
  });
  const intakeAsset = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(intakeAsset?.outcome, "succeeded");
  const submittedG = await submitDraft(dana, draftG.draftId, draftG.rowVersion);
  const [callsBeforeG] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM model_calls WHERE origin = 'live'`,
  );
  const reuse = await enqueueModelJob(dana, {
    purpose: "asset_match",
    draftId: draftG.draftId,
    requestId: submittedG.requestId,
  });
  assert.equal(reuse.jobId, jobG.jobId, "same logical job");
  // The submission already attached the stored result to revision 1 inside
  // its own transaction, so this later enqueue finds nothing left to do.
  assert.equal(reuse.reused, false, "the attach happened at submission");
  const [callsAfterG] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM model_calls WHERE origin = 'live'`,
  );
  assert.equal(callsAfterG.total, callsBeforeG.total, "reuse is free");
  const [attachedG] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM asset_assessments a
     JOIN requests r ON r.current_revision_id = a.revision_id
     WHERE a.draft_id = '${draftG.draftId}' AND r.id = '${submittedG.requestId}'
       AND a.status = 'succeeded'`,
  );
  assert.equal(Number(attachedG.total), 1, "assessment attached to revision");
  // Settle the submission's risk job so the caps race sees only its own jobs.
  const settleRiskG = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(settleRiskG?.outcome, "succeeded");

  // ── 6b. A delayed old worker after lease reclaim cannot settle state ─────
  const henry = await createVisitor();
  const draftL = await readyDraft(henry, "journey L lease race");
  const jobL = await enqueueModelJob(henry, {
    purpose: "risk_assess",
    draftId: draftL.draftId,
  });
  let releaseL!: () => void;
  const gateL = new Promise<void>((resolve) => {
    releaseL = resolve;
  });
  let signalCalledL!: () => void;
  const calledL = new Promise<void>((resolve) => {
    signalCalledL = resolve;
  });
  const slowRiskProvider: ModelProvider = {
    async complete() {
      signalCalledL();
      await gateL;
      return {
        outputText: riskOutput(rule.id),
        inputTokens: 800,
        outputTokens: 300,
      };
    },
  };
  const staleRun = runWorkerOnce({
    provider: slowRiskProvider,
    workerId: "stale-worker",
    leaseSeconds: 0,
  });
  await calledL;
  const reclaimRun = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
    workerId: "fresh-worker",
  });
  assert.equal(reclaimRun?.jobId, jobL.jobId);
  assert.equal(reclaimRun?.outcome, "succeeded", "reclaimed worker finishes");
  releaseL();
  const staleOutcome = await staleRun;
  assert.equal(
    staleOutcome?.outcome,
    "lease_lost",
    "the delayed original worker cannot settle after reclaim",
  );
  const lState = await getModelJob(jobL.jobId);
  assert.equal(lState.status, "succeeded");
  assert.equal(lState.attemptCount, 2);
  const [staleCall] = await sql.unsafe<
    { status: string; sanitized_error: string; actual_cost_micros: number }[]
  >(
    `SELECT status, sanitized_error, actual_cost_micros FROM model_calls
     WHERE draft_id = '${draftL.draftId}' AND attempt_count = 1`,
  );
  assert.equal(staleCall.status, "failed", "reclaim reconciled the old call");
  assert.equal(staleCall.sanitized_error, "lease_expired");
  assert.equal(
    Number(staleCall.actual_cost_micros),
    800 * 2 + 300 * 10,
    "late cost evidence recorded without changing the settled status",
  );
  const [lProposals] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM risk_assessments
     WHERE draft_id = '${draftL.draftId}' AND status = 'succeeded'`,
  );
  assert.equal(Number(lProposals.total), 1, "one proposal set, not two");

  // ── 6c. Submission while a draft job is in flight attaches the revision ──
  const iris = await createVisitor();
  const draftM = await readyDraft(iris, "journey M midflight");
  const jobM = await enqueueModelJob(iris, {
    purpose: "asset_match",
    draftId: draftM.draftId,
  });
  let releaseM!: () => void;
  const gateM = new Promise<void>((resolve) => {
    releaseM = resolve;
  });
  let signalCalledM!: () => void;
  const calledM = new Promise<void>((resolve) => {
    signalCalledM = resolve;
  });
  const slowAssetProvider: ModelProvider = {
    async complete() {
      signalCalledM();
      await gateM;
      return {
        outputText: assetOutput(catalogItem.id),
        inputTokens: 900,
        outputTokens: 400,
      };
    },
  };
  const midflightRun = runWorkerOnce({
    provider: slowAssetProvider,
    workerId: "midflight-worker",
  });
  await calledM;
  const submittedM = await submitDraft(iris, draftM.draftId, draftM.rowVersion);
  const midAttach = await enqueueModelJob(iris, {
    purpose: "asset_match",
    draftId: draftM.draftId,
    requestId: submittedM.requestId,
  });
  assert.equal(midAttach.jobId, jobM.jobId, "same logical job while leased");
  releaseM();
  const midflightOutcome = await midflightRun;
  assert.equal(midflightOutcome?.outcome, "succeeded");
  const [midAssessment] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM asset_assessments a
     JOIN requests r ON r.current_revision_id = a.revision_id
     WHERE a.draft_id = '${draftM.draftId}' AND r.id = '${submittedM.requestId}'
       AND a.status = 'succeeded'`,
  );
  assert.equal(
    Number(midAssessment.total),
    1,
    "the in-flight result lands on the submitted revision, not on none",
  );
  // Settle the submission's risk job before the next section's worker runs.
  const settleRiskM = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(settleRiskM?.outcome, "succeeded");

  // ── 6d. A changed prompt version is a new logical job ────────────────────
  await sql.unsafe(
    `UPDATE model_jobs SET prompt_version = 'intake-v0'
     WHERE id = '${jobA.jobId}'`,
  );
  const freshPromptJob = await enqueueModelJob(alice, {
    purpose: "intake_interpret",
    draftId: draftA.draftId,
  });
  assert.notEqual(
    freshPromptJob.jobId,
    jobA.jobId,
    "an old-prompt succeeded job is not silently reused",
  );
  assert.equal(freshPromptJob.status, "queued");
  const freshPromptRun = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id)),
  });
  assert.equal(freshPromptRun?.jobId, freshPromptJob.jobId);
  assert.equal(freshPromptRun?.outcome, "succeeded");

  // ── 6e. Snapshots are immutable evidence ─────────────────────────────────
  let snapshotUpdate: string | undefined;
  try {
    await sql.unsafe(
      `UPDATE model_jobs SET input_snapshot = '{"edited":true}'
       WHERE id = '${jobA.jobId}'`,
    );
  } catch (error) {
    snapshotUpdate = (error as { code?: string }).code;
  }
  assert.equal(snapshotUpdate, "55000", "input snapshot update rejected");
  const jobASnapshot = await getModelJob(jobA.jobId);
  assert.ok(
    jobASnapshot.inputSnapshot &&
      Object.keys(jobASnapshot.inputSnapshot).length > 0,
    "the job carries its inspectable input snapshot",
  );

  // ── 6f. relatedOfferingKeys are validated like every identifier ──────────
  const kate = await createVisitor();
  const draftK = await readyDraft(kate, "journey K keys");
  const jobK = await enqueueModelJob(kate, {
    purpose: "intake_interpret",
    draftId: draftK.draftId,
  });
  const badKeyOutput = JSON.stringify({
    ...JSON.parse(intakeOutput(offering.id)),
    services: [
      {
        ...JSON.parse(intakeOutput(offering.id)).services[0],
        relatedOfferingKeys: ["no-such-offering-key"],
      },
    ],
  });
  const badKeyRun = await runWorkerOnce({
    provider: providerOf(() => badKeyOutput),
  });
  assert.equal(badKeyRun?.jobId, jobK.jobId);
  assert.equal(badKeyRun?.outcome, "retry_queued");
  const kState = await getModelJob(jobK.jobId);
  assert.equal(kState.currentCall?.sanitizedError, "unknown_identifier");
  const kSettle = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id)),
  });
  assert.equal(kSettle?.outcome, "succeeded");

  // ── 6g. Unreported or invalid usage never releases the reservation ───────
  const uma = await createVisitor();
  const draftU = await readyDraft(uma, "journey U usage");
  const jobU = await enqueueModelJob(uma, {
    purpose: "intake_interpret",
    draftId: draftU.draftId,
  });
  const badUsageRun = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id), {
      inputTokens: -5,
      outputTokens: 400,
    }),
  });
  assert.equal(badUsageRun?.jobId, jobU.jobId);
  assert.equal(badUsageRun?.outcome, "succeeded");
  const uState = await getModelJob(jobU.jobId);
  assert.equal(uState.currentCall?.status, "succeeded");
  assert.equal(
    uState.currentCall?.actualCostMicros,
    null,
    "invalid usage keeps the conservative reservation charged",
  );
  assert.ok((uState.currentCall?.reservedCostMicros ?? 0) > 0);

  // ── 6h. A retry charges the retrying visitor, not the requester ──────────
  const lena = await createVisitor();
  const draftN = await readyDraft(kate, "journey N retry charge");
  const jobN = await enqueueModelJob(kate, {
    purpose: "risk_assess",
    draftId: draftN.draftId,
  });
  await runWorkerOnce({ provider: providerOf(() => "broken") });
  await runWorkerOnce({ provider: providerOf(() => "still broken") });
  const nFailed = await getModelJob(jobN.jobId);
  assert.equal(nFailed.status, "failed");
  await retryModelJob(lena, { jobId: jobN.jobId });
  const nRetryRun = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(nRetryRun?.outcome, "succeeded");
  const [chargedVisitor] = await sql.unsafe<{ visitor_id: string }[]>(
    `SELECT c.visitor_id FROM model_calls c
     JOIN model_jobs j ON j.current_model_call_id = c.id
     WHERE j.id = '${jobN.jobId}'`,
  );
  assert.equal(
    chargedVisitor.visitor_id,
    lena.visitorId,
    "the retry attempt bills the retrying reviewer",
  );
  assert.notEqual(chargedVisitor.visitor_id, kate.visitorId);

  // ── 6i. Transport hardening: safe codes, no redirects, bounded time ──────
  process.env.ANTHROPIC_API_KEY = randomBytes(24).toString("hex");
  let seenInit: RequestInit | undefined;
  const fake429: typeof fetch = async (_input, init) => {
    seenInit = init;
    return new Response("limited", { status: 429 });
  };
  await assert.rejects(
    () =>
      anthropicProvider(fake429).complete({
        model: defaultModel,
        system: "s",
        input: "i",
        maxOutputTokens: 16,
        outputSchema: providerOutputSchema("risk_assess"),
      }),
    /provider_http_429/,
    "http failures reduce to a status-only code",
  );
  assert.equal(seenInit?.redirect, "error", "redirects are rejected");
  assert.ok(seenInit?.signal instanceof AbortSignal, "the call is bounded");
  const fakeTimeout: typeof fetch = async () => {
    const error = new Error("took too long near some secret");
    error.name = "TimeoutError";
    throw error;
  };
  await assert.rejects(
    () =>
      anthropicProvider(fakeTimeout).complete({
        model: defaultModel,
        system: "s",
        input: "i",
        maxOutputTokens: 16,
        outputSchema: providerOutputSchema("risk_assess"),
      }),
    /provider_timeout/,
  );
  const fakeNetwork: typeof fetch = async () => {
    throw new TypeError("fetch failed: redirect with credentials");
  };
  await assert.rejects(
    () =>
      anthropicProvider(fakeNetwork).complete({
        model: defaultModel,
        system: "s",
        input: "i",
        maxOutputTokens: 16,
        outputSchema: providerOutputSchema("risk_assess"),
      }),
    /provider_network_error/,
    "network failures never leak detail",
  );
  delete process.env.ANTHROPIC_API_KEY;

  // ── 6j. Reservation bound covers token-dense multilingual input ──────────
  const dense = "需要一个新的应用程序来跟踪补助金"; // 3 bytes per character
  assert.ok(
    reservationTokenBound(dense) >= Buffer.byteLength(dense, "utf8"),
    "the bound is at least one token per UTF-8 byte",
  );
  const denseReserve = reservedCostMicros(
    resolveRates(defaultModel),
    dense,
    {},
  );
  const naiveReserve = Math.ceil(dense.length / 4) * 2 + maxOutputTokens * 10;
  assert.ok(
    denseReserve > naiveReserve,
    "byte-based reservation exceeds the old length/4 estimate",
  );

  // ── 7. Caps: per-browser daily, 80% signal, concurrent monthly budget ────
  const erin = await createVisitor();
  const draftH = await readyDraft(erin, "journey H");
  const [erinVisitor] = await sql.unsafe<{ visitor_id: string }[]>(
    `SELECT visitor_id FROM drafts WHERE id = '${draftH.draftId}'`,
  );
  for (let index = 0; index < modelCaps.visitorDailyCalls; index += 1) {
    await sql.unsafe(`
      INSERT INTO model_calls
        (id, draft_id, visitor_id, purpose, provider, model, prompt_version,
         input_hash, corpus_versions, status, attempt_count,
         reserved_cost_micros, actual_cost_micros, validated_output,
         idempotency_key, origin, completed_at)
      VALUES ('${randomUUID()}', '${draftH.draftId}', '${erinVisitor.visitor_id}',
         'risk_assess', 'anthropic', '${defaultModel}', 'risk-v1',
         'scaffold', '{}', 'succeeded', 1, 0, 0, '{}', '${randomUUID()}',
         'live', now())
    `);
  }
  const erinQuota = await getQuotaStatus(erinVisitor.visitor_id);
  assert.equal(erinQuota.visitorDaily.exceeded, true);
  const jobH = await enqueueModelJob(erin, {
    purpose: "intake_interpret",
    draftId: draftH.draftId,
  });
  const capped = await runWorkerOnce({
    provider: providerOf(() => intakeOutput(offering.id)),
  });
  assert.equal(capped?.jobId, jobH.jobId);
  assert.equal(capped?.outcome, "capped", "visitor daily cap denies dispatch");
  const cappedState = await getModelJob(jobH.jobId);
  assert.equal(cappedState.status, "capped");
  assert.equal(cappedState.sanitizedError, "quota_visitor_daily");
  assert.equal(cappedState.currentCall?.status, "denied");

  const frank = await createVisitor();
  const draftW = await readyDraft(frank, "journey W warn");
  const [frankVisitor] = await sql.unsafe<{ visitor_id: string }[]>(
    `SELECT visitor_id FROM drafts WHERE id = '${draftW.draftId}'`,
  );
  const warnCount = Math.ceil(modelCaps.visitorDailyCalls * 0.8);
  for (let index = 0; index < warnCount; index += 1) {
    await sql.unsafe(`
      INSERT INTO model_calls
        (id, draft_id, visitor_id, purpose, provider, model, prompt_version,
         input_hash, corpus_versions, status, attempt_count,
         reserved_cost_micros, actual_cost_micros, validated_output,
         idempotency_key, origin, completed_at)
      VALUES ('${randomUUID()}', '${draftW.draftId}', '${frankVisitor.visitor_id}',
         'risk_assess', 'anthropic', '${defaultModel}', 'risk-v1',
         'scaffold', '{}', 'succeeded', 1, 0, 0, '{}', '${randomUUID()}',
         'live', now())
    `);
  }
  const warnQuota = await getQuotaStatus(frankVisitor.visitor_id);
  assert.equal(warnQuota.visitorDaily.warn, true, "80% signal reports");
  assert.equal(warnQuota.visitorDaily.exceeded, false);

  // Concurrent monthly-budget race: leave room for exactly one reservation.
  const gina = await createVisitor();
  const hana = await createVisitor();
  const draftR1 = await readyDraft(gina, "journey R race");
  const draftR2 = await readyDraft(hana, "journey R race");
  const jobR1 = await enqueueModelJob(gina, {
    purpose: "intake_interpret",
    draftId: draftR1.draftId,
  });
  const jobR2 = await enqueueModelJob(hana, {
    purpose: "intake_interpret",
    draftId: draftR2.draftId,
  });
  const reservation = await withDb(async (db) => {
    const effective = await effectiveInput(
      db,
      "intake_interpret",
      draftR1.draftId,
    );
    const corpus = await collectCorpus(db, "intake_interpret");
    const input = buildProviderInput(effective.payload, corpus);
    return reservedCostMicros(
      resolveRates(defaultModel),
      modelPrompts.intake_interpret.system + input,
      providerOutputSchema("intake_interpret", corpus),
    );
  });
  const currentQuota = await getQuotaStatus();
  const target = modelCaps.monthlySpendMicros - reservation - 1;
  assert.ok(
    currentQuota.monthlySpend.used <= target,
    "precondition: fresh database leaves monthly budget room",
  );
  await sql.unsafe(`
    INSERT INTO model_calls
      (id, draft_id, purpose, provider, model, prompt_version, input_hash,
       corpus_versions, status, attempt_count, reserved_cost_micros,
       actual_cost_micros, validated_output, idempotency_key, origin,
       completed_at)
    VALUES ('${randomUUID()}', '${draftR1.draftId}', 'intake_interpret',
       'anthropic', '${defaultModel}', 'intake-v1', 'scaffold-filler', '{}',
       'succeeded', 1, 0, ${target - currentQuota.monthlySpend.used}, '{}',
       '${randomUUID()}', 'live', now())
  `);
  const raceProvider = providerOf(() => intakeOutput(offering.id));
  const race = await Promise.all([
    runWorkerOnce({ provider: raceProvider, workerId: "race-1" }),
    runWorkerOnce({ provider: raceProvider, workerId: "race-2" }),
  ]);
  const raceOutcomes = race
    .map((entry) => entry?.outcome)
    .sort((a, b) => String(a).localeCompare(String(b)));
  assert.deepEqual(
    raceOutcomes,
    ["capped", "succeeded"],
    "exactly one concurrent dispatch fits the remaining budget",
  );
  const raceJobs = [
    await getModelJob(jobR1.jobId),
    await getModelJob(jobR2.jobId),
  ];
  const cappedJob = raceJobs.find((entry) => entry.status === "capped");
  assert.equal(cappedJob?.sanitizedError, "quota_monthly_spend");

  console.log(
    [
      "Model-jobs slice checks passed:",
      "  logical job identity, duplicate reuse, and bad-id rejection behave",
      "  success persists ledger, proposals, source refs, and live origin",
      "  bad output auto-retries once, fails durably, and manual retry recovers",
      "  expired leases reclaim with the interrupted reservation still charged",
      "  superseded revisions never dispatch or become current; answers change the input",
      "  unchanged intake asset results attach to the submitted revision for free",
      "  a delayed pre-reclaim worker loses the lease but keeps its cost evidence",
      "  submission during an in-flight draft job attaches the result to the new revision",
      "  a changed prompt version is a new logical job; snapshots are immutable evidence",
      "  relatedOfferingKeys validate like ids; invalid usage keeps the reservation; transport uses safe codes, no redirects, bounded time",
      "  a manual retry bills the retrying visitor, not the requester",
      "  caps deny durably with the 80% signal, and one of two concurrent dispatches wins the last budget slot",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
