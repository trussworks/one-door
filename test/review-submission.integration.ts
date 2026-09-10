// This suite appends test records to an isolated, migrated and seeded DATABASE_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { createDatabase } from "../src/db/client.ts";
import {
  actors,
  assetAssessments,
  assetCandidateDecisions,
  assetCandidates,
  auditEvents,
  catalogItems,
  deliveryHandoffs,
  drafts,
  modelJobs,
  organizations,
  policyRules,
  requestContentRevisions,
  requests,
  reviewTasks,
  riceScores,
  riskAssessments,
  riskFindingDecisions,
  riskFindings,
  taskCompletions,
  visitors,
} from "../src/db/schema.ts";
import { reviewInputRequests } from "../src/db/schema/review-inputs.ts";
import { collectCorpus } from "../src/models/corpus.ts";
import { WorkflowError } from "../src/workflow/errors.ts";
import { savePriority } from "../src/workflow/priority.ts";
import {
  answerReviewInput,
  askReviewInput,
} from "../src/workflow/review-inputs.ts";
import { createVisitor } from "../src/workflow/requester.ts";
import {
  submitAssessment,
  type ReviewSubmissionInput,
} from "../src/workflow/review-submission.ts";
import {
  addReviewCandidate,
  getReviewState,
  recordRiskOutcome,
  saveRiskDecision,
} from "../src/workflow/review.ts";
import type { ActorContext } from "../src/workflow/shared.ts";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL must identify an isolated test database");
const { db, sql: client } = createDatabase();
const actorId = randomUUID();
const visitorId = randomUUID();
const actor: ActorContext = { actorId, visitorId, actingView: "contributor" };
const [organization] = await db.select().from(organizations).limit(1);
const eligibleItems = await db
  .select()
  .from(catalogItems)
  .where(
    and(
      eq(catalogItems.publicationState, "published"),
      eq(catalogItems.approvalStatus, "approved"),
    ),
  )
  .limit(2);
const [policy] = await db
  .select()
  .from(policyRules)
  .where(eq(policyRules.lifecycle, "active"))
  .limit(1);
assert.ok(
  organization && policy && eligibleItems.length === 2,
  "seeded organization, policy and catalogue records are required",
);

async function createPerson() {
  await db.insert(actors).values({
    id: actorId,
    kind: "visitor",
    displayName: "Assessment integration reviewer",
    organizationId: organization.id,
  });
  await db.insert(visitors).values({ id: visitorId, actorId });
}

async function requestWithEvidence() {
  const requestId = randomUUID();
  const draftId = randomUUID();
  const revisionId = randomUUID();
  await db.insert(drafts).values({
    id: draftId,
    visitorId,
    requesterActorId: actorId,
    requestingOrganizationId: organization.id,
    rawNeed: "Assess the prepared request as one submission",
    structuredContent: {},
    fieldOrigins: {},
    state: "submitted",
    currentStep: "submitted",
  });
  await db.insert(requests).values({
    id: requestId,
    displayId: `SUBMIT-${requestId}`,
    ownerVisitorId: visitorId,
    requesterActorId: actorId,
    requestingOrganizationId: organization.id,
    sourceDraftId: draftId,
    routingState: "routing_requested",
    title: "Atomic review submission",
    problem: "Keep the review coherent",
    affectedPeople: "Operations staff",
    acceptanceCriteria: [],
    requirements: [],
    constraints: [],
    unknowns: [],
    stage: "under_review",
  });
  await db.insert(requestContentRevisions).values({
    id: revisionId,
    requestId,
    revisionNumber: 1,
    content: {},
    source: "submission",
    authoredByActorId: actorId,
  });
  await db
    .update(requests)
    .set({ currentRevisionId: revisionId })
    .where(eq(requests.id, requestId));
  return addPreparedEvidence({ requestId, draftId, revisionId });
}

async function addPreparedEvidence(request: {
  requestId: string;
  draftId: string;
  revisionId: string;
}) {
  const assetAssessmentId = randomUUID();
  const riskAssessmentId = randomUUID();
  const candidateId = randomUUID();
  const findingId = randomUUID();
  await db.insert(assetAssessments).values({
    id: assetAssessmentId,
    draftId: request.draftId,
    revisionId: request.revisionId,
    status: "succeeded",
    origin: "live",
    catalogCorpusHash: (await collectCorpus(db, "asset_match")).hash,
  });
  await db.insert(riskAssessments).values({
    id: riskAssessmentId,
    draftId: request.draftId,
    revisionId: request.revisionId,
    status: "succeeded",
    origin: "live",
    policyCorpusHash: (await collectCorpus(db, "risk_assess")).hash,
  });
  const item = eligibleItems[0];
  await db.insert(assetCandidates).values({
    id: candidateId,
    assessmentId: assetAssessmentId,
    catalogItemId: item.id,
    catalogVersion: item.currentVersion,
    name: item.name,
    rank: 1,
    fitBand: "possible",
    coverage: [],
    gaps: [],
    dependencies: [],
    rationale: "Test's prepared option",
  });
  await db.insert(riskFindings).values({
    id: findingId,
    assessmentId: riskAssessmentId,
    policyRuleId: policy.id,
    kind: "supported_risk",
    evidence: "Test request evidence",
    proposedSeverity: "high",
    rationale: "Test policy interpretation",
  });
  return {
    ...request,
    candidateId,
    findingId,
    assetAssessmentId,
    riskAssessmentId,
  };
}

type Evidence = Awaited<ReturnType<typeof requestWithEvidence>>;

async function currentRequest(requestId: string) {
  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, requestId));
  assert.ok(request);
  return request;
}

async function requestSnapshot(evidence: Evidence) {
  return {
    request: await currentRequest(evidence.requestId),
    candidates: await db
      .select()
      .from(assetCandidates)
      .where(eq(assetCandidates.assessmentId, evidence.assetAssessmentId)),
    decisions: await db
      .select()
      .from(assetCandidateDecisions)
      .where(eq(assetCandidateDecisions.candidateId, evidence.candidateId)),
    findings: await db
      .select()
      .from(riskFindings)
      .where(eq(riskFindings.assessmentId, evidence.riskAssessmentId)),
    riskDecisions: await db
      .select()
      .from(riskFindingDecisions)
      .where(eq(riskFindingDecisions.findingId, evidence.findingId)),
    tasks: await db
      .select()
      .from(reviewTasks)
      .where(eq(reviewTasks.requestId, evidence.requestId)),
    audit: await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, evidence.requestId)),
    completions: await db
      .select()
      .from(taskCompletions)
      .where(eq(taskCompletions.requestId, evidence.requestId)),
    handoffs: await db
      .select()
      .from(deliveryHandoffs)
      .where(eq(deliveryHandoffs.requestId, evidence.requestId)),
  };
}

async function submit(
  evidence: Evidence,
  changes: Partial<ReviewSubmissionInput>,
) {
  const request = await currentRequest(evidence.requestId);
  return submitAssessment(actor, {
    requestId: request.id,
    expectedRowVersion: request.rowVersion,
    idempotencyKey: randomUUID(),
    ...changes,
  });
}

async function expectCode(
  code: string,
  action: () => Promise<unknown>,
  detail?: string,
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof WorkflowError, "failure must be a domain error");
    assert.equal(error.code, code);
    if (detail)
      assert.ok(error.detail?.includes(detail), `failure must reach ${detail}`);
    return true;
  });
}

async function laterFailureRollsBack() {
  const evidence = await requestWithEvidence();
  const before = await requestSnapshot(evidence);
  await expectCode(
    "NOT_FOUND",
    () =>
      submit(evidence, {
        assetDecisions: [
          { candidateId: evidence.candidateId, decision: "accepted" },
        ],
        assetOutcome: "accepted",
        riskDecisions: [{ findingId: randomUUID(), decision: "confirmed" }],
      }),
    "finding in current assessment",
  );
  assert.deepEqual(
    await requestSnapshot(evidence),
    before,
    "late risk failure rolls back prior asset decision, outcome, row versions and audit",
  );
  await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      submit(evidence, {
        assetDecisions: [
          { candidateId: evidence.candidateId, decision: "accepted" },
        ],
        assetOutcome: "accepted",
        riskDecisions: [
          {
            findingId: evidence.findingId,
            decision: "follow_up_required",
            rationale: "Need an answer about the governing rule",
          },
        ],
        complete: completion(),
      }),
    "RISK_FOLLOW_UP_OPEN",
  );
  assert.deepEqual(
    await requestSnapshot(evidence),
    before,
    "completion failure also rolls back the entire review",
  );
}

function completion() {
  return {
    rating: 4,
    deliveryOwnerActorId: actorId,
    nextTask: "Plan the agreed implementation",
    targetSystem: "azure_devops" as const,
    workPlan: [],
  };
}

async function replayAndConflict() {
  const evidence = await requestWithEvidence();
  const original = await currentRequest(evidence.requestId);
  const input = {
    requestId: evidence.requestId,
    expectedRowVersion: original.rowVersion,
    idempotencyKey: randomUUID(),
    assetDecisions: [
      { candidateId: evidence.candidateId, decision: "accepted" as const },
    ],
    assetOutcome: "accepted" as const,
  };
  const first = await submitAssessment(actor, input);
  const after = await requestSnapshot(evidence);
  assert.deepEqual(
    await submitAssessment(actor, input),
    first,
    "exact retry returns the first result despite its old row version",
  );
  assert.deepEqual(
    await requestSnapshot(evidence),
    after,
    "replay writes no additional decisions or events",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      submitAssessment(actor, {
        ...input,
        assetDecisions: [
          {
            candidateId: evidence.candidateId,
            decision: "rejected",
            reason: "Different proposed changes",
          },
        ],
      }),
    "different changes",
  );
  await expectCode("VERSION_CONFLICT", () =>
    submitAssessment(actor, { ...input, idempotencyKey: randomUUID() }),
  );
  assert.deepEqual(await requestSnapshot(evidence), after);
}

async function completeWithoutScore() {
  const evidence = await requestWithEvidence();
  const request = await currentRequest(evidence.requestId);
  const input = {
    requestId: request.id,
    expectedRowVersion: request.rowVersion,
    idempotencyKey: randomUUID(),
    assetDecisions: [
      { candidateId: evidence.candidateId, decision: "accepted" as const },
    ],
    assetOutcome: "accepted" as const,
    riskDecisions: [
      {
        findingId: evidence.findingId,
        decision: "cleared" as const,
        rationale: "The current request does not use the governed capability",
      },
    ],
    riskOutcome: true,
    complete: completion(),
  };
  const result = await submitAssessment(actor, input);
  assert.equal(result.completed, true);
  const completed = await requestSnapshot(evidence);
  assert.equal(completed.request.currentRiceScoreId, null);
  assert.equal(completed.request.stage, "first_review_completed");
  assert.equal(completed.completions.length, 1);
  assert.equal(completed.completions[0].rating, 4);
  assert.equal(completed.completions[0].actorId, actorId);
  assert.equal(completed.handoffs.length, 1);
  assert.deepEqual(await submitAssessment(actor, input), result);
  assert.deepEqual(await requestSnapshot(evidence), completed);
  await priorityAfterCompletion(evidence, completed);
}

async function priorityAfterCompletion(
  evidence: Evidence,
  completed: Awaited<ReturnType<typeof requestSnapshot>>,
) {
  const result = await savePriority(actor, {
    requestId: evidence.requestId,
    expectedRowVersion: completed.request.rowVersion,
    decisions: [
      {
        factor: "reach",
        action: "replace",
        estimate: {
          value: 100,
          unit: "staff",
          period: "quarter",
          basis: "Affected offices",
        },
      },
      {
        factor: "impact",
        action: "replace",
        estimate: { value: 2, basis: "Removes duplicate entry" },
      },
      {
        factor: "confidence",
        action: "replace",
        estimate: {
          value: 0.8,
          basis: "Supported by the implementation estimate",
        },
      },
      {
        factor: "effort",
        action: "replace",
        estimate: {
          value: 2,
          basis: "Forty working days for the delivery team",
        },
      },
    ],
  });
  assert.equal(result.priority.score, 80);
  const after = await requestSnapshot(evidence);
  assert.deepEqual(
    after.completions,
    completed.completions,
    "later priority does not repeat the rating",
  );
  assert.deepEqual(after.decisions, completed.decisions);
  assert.deepEqual(after.riskDecisions, completed.riskDecisions);
  assert.deepEqual(
    after.tasks.filter((task) => task.area !== "rice"),
    completed.tasks.filter((task) => task.area !== "rice"),
  );
  assert.equal(
    (
      await db
        .select()
        .from(riceScores)
        .where(eq(riceScores.requestId, evidence.requestId))
    ).length,
    1,
  );
}

async function manualCandidateInvalidatesNoMatch() {
  const evidence = await requestWithEvidence();
  await submit(evidence, {
    assetDecisions: [
      {
        candidateId: evidence.candidateId,
        decision: "rejected",
        reason: "Does not cover the requirement",
      },
    ],
    assetOutcome: "no_match",
  });
  const original = await currentRequest(evidence.requestId);
  const item = eligibleItems[1];
  const added = await addReviewCandidate(actor, {
    requestId: original.id,
    expectedRowVersion: original.rowVersion,
    catalogItemId: item.id,
  });
  const [candidate] = await db
    .select()
    .from(assetCandidates)
    .where(eq(assetCandidates.id, added.candidateId));
  assert.equal(candidate.proposedByActorId, actorId);
  assert.equal(candidate.fitBand, null);
  assert.equal(candidate.currentDecisionId, null);
  assert.equal(candidate.catalogVersion, item.currentVersion);
  assert.equal(candidate.name, item.name);
  assert.ok(
    (await getReviewState(original.id)).blockers.includes(
      "ASSET_OUTCOME_PENDING",
    ),
  );
  await expectCode(
    "INVALID_STATE",
    () => submit(evidence, { assetOutcome: "no_match" }),
    "without a rejected decision",
  );
  const duplicate = await addReviewCandidate(actor, {
    requestId: original.id,
    expectedRowVersion: added.rowVersion,
    catalogItemId: item.id,
  });
  assert.equal(duplicate.candidateId, candidate.id);
  assert.equal(duplicate.rowVersion, added.rowVersion);
  await submit(evidence, {
    assetDecisions: [
      {
        candidateId: candidate.id,
        decision: "rejected",
        reason: "The manually found option also misses the requirement",
      },
    ],
    assetOutcome: "no_match",
  });
  assert.ok(
    !(await getReviewState(original.id)).blockers.includes(
      "ASSET_OUTCOME_PENDING",
    ),
  );
}

async function clearedRiskOutcome() {
  const evidence = await requestWithEvidence();
  const request = await currentRequest(evidence.requestId);
  const saved = await saveRiskDecision(actor, {
    requestId: request.id,
    expectedRowVersion: request.rowVersion,
    findingId: evidence.findingId,
    decision: "cleared",
    rationale: "The documented condition does not apply to the requested scope",
  });
  const outcome = await recordRiskOutcome(actor, {
    requestId: request.id,
    expectedRowVersion: saved.rowVersion,
  });
  assert.equal(outcome.findingCount, 1);
  const state = await getReviewState(request.id);
  assert.ok(!state.blockers.includes("RISK_OUTCOME_PENDING"));
  assert.ok(!state.blockers.includes("RISK_FINDINGS_UNDECIDED"));
  assert.equal(
    state.tasks.find((task) => task.area === "risk")!.state,
    "completed",
  );
}

async function askNamedContributor(evidence: Evidence, area: "rice" | "risk") {
  const visitor = await createVisitor({
    displayName: "Submission input specialist",
  });
  const contributor: ActorContext = { ...visitor, actingView: "contributor" };
  const request = await currentRequest(evidence.requestId);
  const result = await askReviewInput(actor, {
    requestId: request.id,
    expectedRowVersion: request.rowVersion,
    inputRequestId: randomUUID(),
    area,
    audience: "internal",
    assigneeActorId: contributor.actorId,
    question:
      area === "rice"
        ? "What effort does the agreed rollout need?"
        : "Does this rule apply to the current scope?",
    scope: "The entire proposed rollout",
    ...(area === "rice"
      ? { factor: "effort" }
      : { findingId: evidence.findingId }),
  });
  return { contributor, inputId: result.inputRequest.id };
}

async function currentInput(inputId: string) {
  const [input] = await db
    .select()
    .from(reviewInputRequests)
    .where(eq(reviewInputRequests.id, inputId));
  assert.ok(input);
  return input;
}

async function answerInput(
  evidence: Evidence,
  addressed: Awaited<ReturnType<typeof askNamedContributor>>,
  outcome: "provided" | "unknown",
) {
  const request = await currentRequest(evidence.requestId);
  const input = await currentInput(addressed.inputId);
  return answerReviewInput(addressed.contributor, {
    requestId: request.id,
    expectedRowVersion: request.rowVersion,
    inputRequestId: input.id,
    expectedInputVersion: input.rowVersion,
    responseId: randomUUID(),
    answer:
      outcome === "unknown"
        ? "I do not have the required evidence."
        : "Reviewed the actual scope and can supply the requested information.",
    outcome,
    ...(input.area === "rice" && outcome === "provided"
      ? {
          proposal: {
            factor: "effort",
            estimate: {
              value: 2,
              basis: "Delivery team's forty-day estimate for the full rollout",
            },
          },
        }
      : {}),
  });
}

function settledReview(evidence: Evidence): Partial<ReviewSubmissionInput> {
  return {
    assetDecisions: [
      { candidateId: evidence.candidateId, decision: "accepted" },
    ],
    assetOutcome: "accepted",
    riskDecisions: [
      {
        findingId: evidence.findingId,
        decision: "cleared",
        rationale: "The governing condition does not apply to this scope",
      },
    ],
    riskOutcome: true,
  };
}

const priorityWithoutEffort: ReviewSubmissionInput["priorityDecisions"] = [
  {
    factor: "reach",
    action: "replace",
    estimate: {
      value: 100,
      unit: "staff",
      period: "quarter",
      basis: "Affected offices",
    },
  },
  {
    factor: "impact",
    action: "replace",
    estimate: { value: 2, basis: "Removes duplicate entry" },
  },
  {
    factor: "confidence",
    action: "replace",
    estimate: {
      value: 0.8,
      basis: "Operational measurements support the assumptions",
    },
  },
];

async function effortAnswerAfterCompletion() {
  const evidence = await requestWithEvidence();
  const addressed = await askNamedContributor(evidence, "rice");
  const initial = await submit(evidence, {
    ...settledReview(evidence),
    complete: completion(),
    priorityDecisions: priorityWithoutEffort,
  });
  assert.equal(initial.completed, true);
  assert.equal((await currentInput(addressed.inputId)).state, "open");
  const completed = await requestSnapshot(evidence);
  assert.equal(completed.request.currentRiceScoreId, null);
  const jobs = await db
    .select()
    .from(modelJobs)
    .where(eq(modelJobs.draftId, evidence.draftId));
  const answered = await answerInput(evidence, addressed, "provided");
  assert.ok(answered.response.contributionId);
  assert.equal(
    answered.response.respondentActorId,
    addressed.contributor.actorId,
  );
  assert.equal((await currentInput(addressed.inputId)).state, "answered");
  const beforeAdoption = await requestSnapshot(evidence);
  const decision = {
    factor: "effort" as const,
    action: "adopt" as const,
    proposalId: answered.response.contributionId,
  };
  await expectCode(
    "INVALID_STATE",
    () =>
      submit(evidence, {
        priorityDecisions: [decision],
        complete: completion(),
      }),
    "milestone already recorded",
  );
  assert.deepEqual(
    await requestSnapshot(evidence),
    beforeAdoption,
    "failed submission rolls back the accepted score and attempted input resolution",
  );
  assert.equal((await currentInput(addressed.inputId)).state, "answered");
  await submit(evidence, { priorityDecisions: [decision] });
  const resolved = await currentInput(addressed.inputId);
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.resolutionId, answered.response.contributionId);
  assert.equal(resolved.resolutionKind, "priority_contribution");
  const score = await assertFitRiskUnchanged(evidence, completed, jobs);
  assert.equal(Number(score.score), 80);
  assert.equal(score.effortActorId, addressed.contributor.actorId);
  await assertResolutionTransaction(
    evidence.requestId,
    addressed.inputId,
    score.id,
  );
}

async function assertFitRiskUnchanged(
  evidence: Evidence,
  completed: Awaited<ReturnType<typeof requestSnapshot>>,
  jobs: Array<typeof modelJobs.$inferSelect>,
) {
  const after = await requestSnapshot(evidence);
  assert.deepEqual(after.decisions, completed.decisions);
  assert.deepEqual(after.riskDecisions, completed.riskDecisions);
  assert.deepEqual(after.completions, completed.completions);
  assert.deepEqual(
    after.tasks.filter((task) => task.area !== "rice"),
    completed.tasks.filter((task) => task.area !== "rice"),
  );
  assert.deepEqual(
    await db
      .select()
      .from(modelJobs)
      .where(eq(modelJobs.draftId, evidence.draftId)),
    jobs,
  );
  const [score] = await db
    .select()
    .from(riceScores)
    .where(eq(riceScores.id, after.request.currentRiceScoreId!));
  return score;
}

async function assertResolutionTransaction(
  requestId: string,
  inputId: string,
  scoreId?: string,
) {
  const [input] =
    await client`SELECT xmin::text AS transaction FROM review_input_requests WHERE id = ${inputId}`;
  const [resolved] =
    await client`SELECT xmin::text AS transaction FROM audit_events WHERE subject_id = ${requestId} AND event_type = 'review_input_resolved' AND payload->>'inputRequestId' = ${inputId} ORDER BY created_at DESC LIMIT 1`;
  const [submitted] =
    await client`SELECT xmin::text AS transaction FROM audit_events WHERE subject_id = ${requestId} AND event_type = 'review_submitted' ORDER BY created_at DESC LIMIT 1`;
  assert.equal(input.transaction, resolved.transaction);
  assert.equal(
    input.transaction,
    submitted.transaction,
    "question resolution and submission are one database transaction",
  );
  if (scoreId) {
    const [score] =
      await client`SELECT xmin::text AS transaction FROM rice_scores WHERE id = ${scoreId}`;
    assert.equal(
      input.transaction,
      score.transaction,
      "new score shares the same transaction",
    );
  }
}

async function riskAnswerRequiresNewJudgment() {
  const evidence = await requestWithEvidence();
  await submit(evidence, settledReview(evidence));
  const addressed = await askNamedContributor(evidence, "risk");
  const before = await requestSnapshot(evidence);
  assert.equal(
    before.tasks.find((task) => task.area === "risk")!.state,
    "completed",
    "the previous risk area was already settled",
  );
  await expectCode(
    "APPROVAL_BLOCKED",
    () => submit(evidence, { complete: completion() }),
    "RISK_FOLLOW_UP_OPEN",
  );
  assert.deepEqual(await requestSnapshot(evidence), before);
  await answerInput(evidence, addressed, "unknown");
  const unknown = await requestSnapshot(evidence);
  await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      submit(evidence, {
        riskDecisions: [
          {
            findingId: evidence.findingId,
            decision: "cleared",
            rationale:
              "Repeating a conclusion cannot supply the missing evidence",
          },
        ],
        riskOutcome: true,
        complete: completion(),
      }),
    "RISK_FOLLOW_UP_OPEN",
  );
  assert.deepEqual(await requestSnapshot(evidence), unknown);
  assert.equal((await currentInput(addressed.inputId)).state, "answered");
  await answerInput(evidence, addressed, "provided");
  await expectCode(
    "APPROVAL_BLOCKED",
    () => submit(evidence, { complete: completion() }),
    "RISK_FOLLOW_UP_OPEN",
  );
  const result = await submit(evidence, {
    riskDecisions: [
      {
        findingId: evidence.findingId,
        decision: "cleared",
        rationale:
          "The specialist's current evidence establishes the rule does not apply",
      },
    ],
    riskOutcome: true,
    complete: completion(),
  });
  assert.equal(result.completed, true);
  const input = await currentInput(addressed.inputId);
  const [finding] = await db
    .select()
    .from(riskFindings)
    .where(eq(riskFindings.id, evidence.findingId));
  assert.equal(input.state, "resolved");
  assert.equal(input.resolutionKind, "risk_decision");
  assert.equal(input.resolutionId, finding.currentDecisionId);
  assert.notEqual(input.resolutionId, before.findings[0].currentDecisionId);
  await assertResolutionTransaction(evidence.requestId, addressed.inputId);
}

try {
  await createPerson();
  await laterFailureRollsBack();
  await replayAndConflict();
  await completeWithoutScore();
  await manualCandidateInvalidatesNoMatch();
  await clearedRiskOutcome();
  await effortAnswerAfterCompletion();
  await riskAnswerRequiresNewJudgment();
  console.log(
    "Review submission integration passed: atomic rollback, replay/conflict, pending priority, catalogue provenance, and automatic input resolution after current human judgments.",
  );
} finally {
  await client.end();
}
