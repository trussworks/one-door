// This suite appends isolated test records to DATABASE_URL; it never starts model work.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { createDatabase } from "../src/db/client.ts";
import {
  actors,
  drafts,
  modelJobs,
  organizations,
  requestContentRevisions,
  requestResolutions,
  requests,
  reviewTasks,
  riceScores,
  visitors,
} from "../src/db/schema.ts";
import {
  priorityContributions,
  priorityDecisions,
} from "../src/db/schema/priority.ts";
import type {
  PriorityDecisionInput,
  PriorityFactor,
  PriorityProposalInput,
} from "../src/domain/priority.ts";
import { WorkflowError } from "../src/workflow/errors.ts";
import {
  applyPriorityDecisions,
  readPriority,
  savePriority,
  submitPriorityProposals,
} from "../src/workflow/priority.ts";
import {
  lockUnresolvedRequest,
  type ActorContext,
  type Tx,
} from "../src/workflow/shared.ts";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL must identify an isolated test database");
const { db, sql: client } = createDatabase();
const organizationId = randomUUID();
const requesterId = randomUUID();
const reviewerId = randomUUID();
const expertId = randomUUID();
const visitorId = randomUUID();
const reviewer: ActorContext = {
  actorId: reviewerId,
  actingView: "contributor",
};
const requester = {
  actorId: requesterId,
  visitorId,
  actingView: "requester" as const,
};
const estimates = {
  reach: {
    value: 120,
    basis: "Monthly affected population",
    unit: "people",
    period: "month",
  },
  impact: { value: 2, basis: "Eliminates duplicate data entry" },
  confidence: {
    value: 0.8,
    basis: "Supported by operations figures and a team estimate",
  },
  effort: { value: 2, basis: "Delivery team estimates forty working days" },
};

async function setupPeople() {
  await db.insert(organizations).values({
    id: organizationId,
    name: "Priority integration organization",
    kind: "team",
  });
  await db.insert(actors).values([
    {
      id: requesterId,
      kind: "visitor",
      displayName: "Priority requester",
      organizationId,
    },
    {
      id: reviewerId,
      kind: "visitor",
      displayName: "Priority reviewer",
      organizationId,
    },
    {
      id: expertId,
      kind: "visitor",
      displayName: "Priority estimator",
      organizationId,
    },
  ]);
  await db.insert(visitors).values({ id: visitorId, actorId: requesterId });
}

async function newRequest() {
  const draftId = randomUUID();
  const id = randomUUID();
  const revisionId = randomUUID();
  await db.insert(drafts).values({
    id: draftId,
    visitorId,
    requesterActorId: requesterId,
    requestingOrganizationId: organizationId,
    rawNeed: "A request for the priority integration check",
    structuredContent: {},
    fieldOrigins: {},
    state: "submitted",
    currentStep: "submitted",
  });
  await db.insert(requests).values({
    id,
    displayId: `PRIORITY-${id}`,
    ownerVisitorId: visitorId,
    requesterActorId: requesterId,
    requestingOrganizationId: organizationId,
    sourceDraftId: draftId,
    routingState: "routing_requested",
    title: "Priority contribution integration",
    problem: "Avoid repeating settled review work",
    affectedPeople: "Operations staff",
    acceptanceCriteria: [],
    requirements: [],
    constraints: [],
    unknowns: [],
    stage: "under_review",
  });
  await db.insert(requestContentRevisions).values({
    id: revisionId,
    requestId: id,
    revisionNumber: 1,
    content: {},
    source: "submission",
    authoredByActorId: requesterId,
  });
  await db
    .update(requests)
    .set({ currentRevisionId: revisionId })
    .where(eq(requests.id, id));
  return id;
}

async function currentRequest(requestId: string) {
  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, requestId));
  assert.ok(request);
  return request;
}

function view(requestId: string) {
  return db.transaction((tx) => readPriority(tx, requestId));
}

function proposal(
  factor: PriorityFactor,
  suppliedByActorId?: string,
): PriorityProposalInput {
  return { factor, estimate: estimates[factor], suppliedByActorId };
}

function propose(
  requestId: string,
  proposals: PriorityProposalInput[],
  source: "requester" | "contributor" = "requester",
) {
  return db.transaction(async (tx) => {
    const request = await lockUnresolvedRequest(tx, requestId);
    return submitPriorityProposals(
      tx,
      source === "requester" ? requester : reviewer,
      request,
      { source, proposals },
    );
  });
}

async function review(requestId: string, decisions: PriorityDecisionInput[]) {
  const request = await currentRequest(requestId);
  return savePriority(reviewer, {
    requestId,
    expectedRowVersion: request.rowVersion,
    decisions,
  });
}

async function expectCode(code: string, action: () => Promise<unknown>) {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof WorkflowError && error.code === code,
  );
}

async function partialThenComplete() {
  const requestId = await newRequest();
  const proposalIds = await propose(requestId, [
    proposal("reach"),
    proposal("impact"),
    {
      factor: "effort",
      estimate: { value: null, basis: "No delivery estimate yet" },
    },
  ]);
  const pending = await view(requestId);
  assert.equal(pending.score, null);
  assert.equal(pending.factors[0].status, "proposed");
  await review(requestId, [
    { factor: "reach", action: "adopt", proposalId: proposalIds[0] },
    { factor: "impact", action: "adopt", proposalId: proposalIds[1] },
    { factor: "confidence", action: "replace", estimate: estimates.confidence },
  ]);
  await expectCode("VALIDATION_FAILED", () =>
    review(requestId, [
      { factor: "effort", action: "adopt", proposalId: proposalIds[2] },
    ]),
  );
  assert.equal((await view(requestId)).complete, false);
  await completePendingPriority(requestId);
  return requestId;
}

async function completePendingPriority(requestId: string) {
  await db
    .update(requests)
    .set({
      stage: "first_review_completed",
      firstReviewCompletedAt: new Date().toISOString(),
    })
    .where(eq(requests.id, requestId));
  await db.insert(reviewTasks).values({
    id: randomUUID(),
    requestId,
    area: "risk",
    responsibleCapability: "review_risk",
    state: "completed",
  });
  const before = await db
    .select()
    .from(reviewTasks)
    .where(
      and(eq(reviewTasks.requestId, requestId), eq(reviewTasks.area, "risk")),
    );
  const [effortId] = await propose(
    requestId,
    [proposal("effort", expertId)],
    "contributor",
  );
  const completed = await review(requestId, [
    { factor: "effort", action: "adopt", proposalId: effortId },
  ]);
  assert.equal(completed.priority.score, 96);
  const reach = completed.priority.factors[0].reviewed!;
  assert.equal(reach.suppliedByActorId, requesterId);
  assert.equal(reach.recordedByActorId, requesterId);
  assert.equal(reach.reviewerActorId, reviewerId);
  const effort = completed.priority.factors[3].reviewed!;
  assert.equal(effort.suppliedByActorId, expertId);
  assert.equal(effort.recordedByActorId, reviewerId);
  assert.equal(effort.reviewerActorId, reviewerId);
  assert.deepEqual(
    await db
      .select()
      .from(reviewTasks)
      .where(
        and(eq(reviewTasks.requestId, requestId), eq(reviewTasks.area, "risk")),
      ),
    before,
  );
  assert.equal(
    (await currentRequest(requestId)).stage,
    "first_review_completed",
  );
  assert.equal(
    (
      await db
        .select()
        .from(modelJobs)
        .where(
          eq(
            modelJobs.draftId,
            (await currentRequest(requestId)).sourceDraftId,
          ),
        )
    ).length,
    0,
  );
}

async function rejectionAndReplacement(requestId: string) {
  const [alternative] = await propose(requestId, [
    { factor: "reach", estimate: { ...estimates.reach, value: 999 } },
  ]);
  assert.equal(
    (await view(requestId)).score,
    96,
    "pending proposal does not overwrite the reviewed score",
  );
  await review(requestId, [
    {
      factor: "reach",
      action: "reject",
      proposalId: alternative,
      reason: "Includes people outside the rollout",
    },
  ]);
  assert.equal(
    (await view(requestId)).score,
    96,
    "rejecting another proposal preserves the accepted factor",
  );
  const acceptedId = (await view(requestId)).factors[0].reviewed!.proposalId!;
  await review(requestId, [
    {
      factor: "reach",
      action: "reject",
      proposalId: acceptedId,
      reason: "Current scope reaches only half the population",
    },
  ]);
  const rejected = await view(requestId);
  assert.equal(rejected.scoreId, null);
  assert.equal(rejected.factors[0].reviewed, null);
  assert.equal(rejected.factors[3].reviewed!.suppliedByActorId, expertId);
  await review(requestId, [
    {
      factor: "reach",
      action: "replace",
      proposalId: acceptedId,
      estimate: { ...estimates.reach, value: 60 },
    },
  ]);
  const replaced = await view(requestId);
  assert.equal(replaced.score, 48);
  assert.equal(
    replaced.factors[0].proposals.find((item) => item.id === acceptedId)!
      .estimate.value,
    120,
  );
  assert.equal(replaced.factors[0].reviewed!.suppliedByActorId, reviewerId);
}

async function revisionAndConcurrency(requestId: string) {
  const request = await currentRequest(requestId);
  const input = {
    requestId,
    expectedRowVersion: request.rowVersion,
    decisions: [
      { factor: "impact", action: "replace", estimate: estimates.impact },
    ],
  };
  const results = await Promise.allSettled([
    savePriority(reviewer, input),
    savePriority(reviewer, input),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = results.find(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(failure.reason.code, "VERSION_CONFLICT");
  const revisionId = randomUUID();
  await db.insert(requestContentRevisions).values({
    id: revisionId,
    requestId,
    revisionNumber: 2,
    content: {},
    source: "clarification_answer",
    authoredByActorId: requesterId,
  });
  await db
    .update(requests)
    .set({ currentRevisionId: revisionId, currentRiceScoreId: null })
    .where(eq(requests.id, requestId));
  const stale = await view(requestId);
  assert.ok(stale.factors.every((factor) => factor.reviewed === null));
  assert.equal(stale.factors[0].proposals[0].current, false);
  await expectCode("VERSION_CONFLICT", () =>
    review(requestId, [
      {
        factor: "reach",
        action: "adopt",
        proposalId: stale.factors[0].proposals[0].id,
      },
    ]),
  );
}

async function rollbackAndBinding() {
  const requestId = await newRequest();
  const otherRequestId = await newRequest();
  const [foreignProposal] = await propose(otherRequestId, [proposal("reach")]);
  await expectCode("NOT_FOUND", () =>
    review(requestId, [
      { factor: "reach", action: "adopt", proposalId: foreignProposal },
    ]),
  );
  await assert.rejects(
    db.transaction(async (tx: Tx) => {
      const request = await lockUnresolvedRequest(tx, requestId);
      await applyPriorityDecisions(tx, reviewer, request, [
        { factor: "reach", action: "replace", estimate: estimates.reach },
      ]);
      throw new Error("Parent review failed after priority write");
    }),
    /Parent review failed/,
  );
  assert.equal(
    (
      await db
        .select()
        .from(priorityDecisions)
        .where(eq(priorityDecisions.requestId, requestId))
    ).length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(riceScores)
        .where(eq(riceScores.requestId, requestId))
    ).length,
    0,
  );
  await expectCode("VALIDATION_FAILED", () =>
    propose(requestId, [proposal("effort", expertId)]),
  );
  const [proposalId] = await propose(requestId, [proposal("reach")]);
  await db
    .update(requests)
    .set({ fixtureGeneration: 2 })
    .where(eq(requests.id, requestId));
  await expectCode("VERSION_CONFLICT", () =>
    review(requestId, [{ factor: "reach", action: "adopt", proposalId }]),
  );
  await db.insert(requestResolutions).values({
    id: randomUUID(),
    requestId,
    outcome: "closed_without_fulfillment",
    summary: "Closed test request",
    reason: "No further work",
    resolvedByActorId: reviewerId,
    requestGeneration: 2,
  });
  await expectCode("INVALID_STATE", () =>
    review(requestId, [
      { factor: "impact", action: "replace", estimate: estimates.impact },
    ]),
  );
}

async function legacySnapshot() {
  const requestId = await newRequest();
  const scoreId = randomUUID();
  await db.insert(riceScores).values({
    id: scoreId,
    requestId,
    version: 1,
    reach: "120",
    reachUnit: "people",
    reachPeriod: "month",
    reachRationale: estimates.reach.basis,
    reachActorId: requesterId,
    impact: "2",
    impactRationale: estimates.impact.basis,
    impactActorId: reviewerId,
    confidence: "0.8",
    confidenceRationale: estimates.confidence.basis,
    confidenceActorId: reviewerId,
    effort: "2",
    effortRationale: estimates.effort.basis,
    effortActorId: expertId,
    score: "96",
    rubricVersion: "rubric-v1",
    formulaVersion: "rice-v1",
    createdByActorId: reviewerId,
    origin: "live",
  });
  await db
    .update(requests)
    .set({ currentRiceScoreId: scoreId })
    .where(eq(requests.id, requestId));
  const original = await view(requestId);
  assert.equal(original.factors[0].reviewed!.source, "existing_score");
  assert.equal(original.factors[0].reviewed!.reviewerActorId, null);
  assert.equal(original.factors[0].proposals.length, 0);
  await review(requestId, [
    {
      factor: "effort",
      action: "reject",
      reason: "Estimate used a smaller deployment",
    },
  ]);
  const pending = await view(requestId);
  assert.equal(pending.score, null);
  assert.equal(pending.factors[0].reviewed!.scoreId, scoreId);
  assert.equal(pending.factors[0].reviewed!.suppliedByActorId, requesterId);
  await review(requestId, [
    {
      factor: "effort",
      action: "replace",
      estimate: { value: 4, basis: "Updated estimate for full deployment" },
      suppliedByActorId: expertId,
    },
  ]);
  const revised = await view(requestId);
  assert.equal(revised.score, 48);
  assert.equal(revised.factors[0].reviewed!.source, "existing_score");
  assert.equal(
    (
      await db
        .select()
        .from(priorityContributions)
        .where(eq(priorityContributions.requestId, requestId))
    ).length,
    0,
  );
  assert.equal(
    (await db.select().from(riceScores).where(eq(riceScores.id, scoreId)))[0]
      .effort,
    "2.00",
  );
}

async function systemActorsCannotSupplyHumanEstimates() {
  const requestId = await newRequest();
  const systemId = randomUUID();
  await db.insert(actors).values({
    id: systemId,
    kind: "system",
    displayName: "Priority test automation",
  });
  await expectCode("VALIDATION_FAILED", () =>
    propose(requestId, [proposal("effort", systemId)], "contributor"),
  );
  await expectCode("VALIDATION_FAILED", () =>
    review(requestId, [
      {
        factor: "effort",
        action: "replace",
        suppliedByActorId: systemId,
        estimate: estimates.effort,
      },
    ]),
  );
  const system: ActorContext = { actorId: systemId, actingView: "contributor" };
  const request = await currentRequest(requestId);
  await expectCode("VALIDATION_FAILED", () =>
    savePriority(system, {
      requestId,
      expectedRowVersion: request.rowVersion,
      decisions: [
        { factor: "effort", action: "replace", estimate: estimates.effort },
      ],
    }),
  );
  await expectCode("VALIDATION_FAILED", () =>
    db.transaction(async (tx) => {
      const locked = await lockUnresolvedRequest(tx, requestId);
      return submitPriorityProposals(tx, system, locked, {
        source: "contributor",
        proposals: [proposal("reach", requesterId)],
      });
    }),
  );
  const proposalId = randomUUID();
  await db.insert(priorityContributions).values({
    id: proposalId,
    requestId,
    revisionId: request.currentRevisionId,
    requestGeneration: request.fixtureGeneration,
    factor: "effort",
    estimate: estimates.effort,
    source: "contributor",
    suppliedByActorId: systemId,
    recordedByActorId: reviewerId,
  });
  await expectCode("VALIDATION_FAILED", () =>
    review(requestId, [{ factor: "effort", action: "adopt", proposalId }]),
  );
  assert.equal(
    (
      await db
        .select()
        .from(priorityDecisions)
        .where(eq(priorityDecisions.requestId, requestId))
    ).length,
    0,
  );
  await staffCanSupplyHumanEstimate(requestId);
}

async function staffCanSupplyHumanEstimate(requestId: string) {
  const staffId = randomUUID();
  await db.insert(actors).values({
    id: staffId,
    kind: "persona",
    displayName: "Priority test staff",
    capabilities: [],
  });
  const [humanProposal] = await propose(
    requestId,
    [proposal("effort", staffId)],
    "contributor",
  );
  const result = await review(requestId, [
    { factor: "effort", action: "adopt", proposalId: humanProposal },
  ]);
  assert.equal(
    result.priority.factors[3].reviewed!.suppliedByActorId,
    staffId,
    "a staff human needs no invented role qualification",
  );
}

try {
  await setupPeople();
  await systemActorsCannotSupplyHumanEstimates();
  const requestId = await partialThenComplete();
  await rejectionAndReplacement(requestId);
  await revisionAndConcurrency(requestId);
  await rollbackAndBinding();
  await legacySnapshot();
  console.log(
    "Priority integration checks passed: contributions, attribution, pending completion, rejection, concurrency, currency, rollback, legacy snapshots.",
  );
} finally {
  await client.end();
}
