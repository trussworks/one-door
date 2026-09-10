// Run against an isolated, migrated and seeded DATABASE_URL. Submission enqueues
// normal preparation jobs; no worker or external model runs in this check.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { createDatabase } from "../src/db/client.ts";
import {
  drafts,
  modelJobs,
  organizations,
  requestContentRevisions,
  requests,
  taskCompletions,
} from "../src/db/schema.ts";
import { priorityContributions } from "../src/db/schema/priority.ts";
import type { PriorityProposalInput } from "../src/domain/priority.ts";
import { effectiveInput } from "../src/models/corpus.ts";
import { enrichedRequests } from "../src/server/read-model.ts";
import { requestView } from "../src/server/request-views.ts";
import { WorkflowError } from "../src/workflow/errors.ts";
import { submitIntake } from "../src/workflow/intake-workspace.ts";
import { readPriority, savePriority } from "../src/workflow/priority.ts";
import {
  answerReviewInput,
  askReviewInput,
} from "../src/workflow/review-inputs.ts";
import { submitAssessment } from "../src/workflow/review-submission.ts";
import {
  createVisitor,
  saveDraft,
  submitRequest,
} from "../src/workflow/requester.ts";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL must identify an isolated test database");
const { db, sql: client } = createDatabase();
const [organization] = await db.select().from(organizations).limit(1);
assert.ok(organization, "seeded organization is required");
type SubmissionPath = "submitRequest" | "submitIntake";
const paths: SubmissionPath[] = ["submitRequest", "submitIntake"];

function content(label: string) {
  return {
    title: `Requester priority ${label}`,
    problem: "Staff repeat the same information in separate systems.",
    affectedPeople: "Staff in the participating offices",
    acceptanceCriteria: ["Information is entered once"],
    requirements: ["Works with current accounts"],
    constraints: ["Keep the existing record system"],
    unknowns: [],
  };
}

async function prepare(path: SubmissionPath) {
  const owner = await createVisitor({ displayName: `Priority intake ${path}` });
  const words = content(randomUUID());
  const saved = await saveDraft(owner, {
    organizationId: organization.id,
    rawNeed: "We want to stop entering the same record twice.",
    content: words,
    state: path === "submitRequest" ? "ready" : "open",
  });
  const input = {
    draftId: saved.draftId,
    expectedRowVersion: saved.rowVersion,
    rating: 4,
    idempotencyKey: randomUUID(),
    content: words,
  };
  return { owner, words, input, path };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

function submit(
  prepared: Prepared,
  priorityProposals?: PriorityProposalInput[],
) {
  const input = { ...prepared.input, priorityProposals };
  return prepared.path === "submitRequest"
    ? submitRequest(prepared.owner, input)
    : submitIntake(prepared.owner, input);
}

function proposedValues(marker: string): PriorityProposalInput[] {
  return [
    {
      factor: "reach",
      estimate: {
        value: 60,
        unit: "staff",
        period: "quarter",
        basis: `${marker}: manual count of affected colleagues`,
      },
    },
    {
      factor: "impact",
      estimate: {
        value: 2,
        basis: `${marker}: removes the duplicate entry step`,
      },
    },
    {
      factor: "effort",
      estimate: {
        value: null,
        basis: `${marker}: no delivery estimate available`,
      },
    },
  ];
}

async function successfulContribution(path: SubmissionPath) {
  const prepared = await prepare(path);
  const marker = `PRIORITY-ONLY-${randomUUID()}`;
  const proposals = proposedValues(marker);
  const beforeInput = await effectiveInput(
    db,
    "asset_match",
    prepared.input.draftId,
  );
  const submitted = await submit(prepared, proposals);
  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, submitted.requestId));
  const saved = await db
    .select()
    .from(priorityContributions)
    .where(eq(priorityContributions.requestId, request.id));
  assert.equal(saved.length, 3);
  assert.ok(request.currentRevisionId);
  for (const row of saved) {
    assert.equal(
      row.revisionId,
      request.currentRevisionId,
      "submitted proposals belong to the revision created in the same transaction",
    );
    assert.equal(row.requestGeneration, request.fixtureGeneration);
    assert.equal(row.source, "requester");
    assert.equal(row.suppliedByActorId, prepared.owner.actorId);
    assert.equal(row.recordedByActorId, prepared.owner.actorId);
  }
  const priority = await db.transaction((tx) => readPriority(tx, request.id));
  assert.equal(priority.complete, false);
  assert.ok(
    priority.factors
      .flatMap((factor) => factor.proposals)
      .every((proposal) => proposal.current),
  );
  const reach = saved.find((proposal) => proposal.factor === "reach")!;
  await verifyInputIsolation(prepared, request.id, beforeInput.payload, marker);
  assert.deepEqual(
    await submit(prepared, proposals),
    submitted,
    "exact submission replay returns the same request",
  );
  assert.deepEqual(
    await db
      .select()
      .from(priorityContributions)
      .where(eq(priorityContributions.requestId, request.id)),
    saved,
    "replay creates no duplicate contributions",
  );
  await adoptImmediately(
    request.id,
    request.rowVersion,
    reach.id,
    prepared.owner.actorId,
  );
  await verifyInputIsolation(prepared, request.id, beforeInput.payload, marker);
}

async function verifyInputIsolation(
  prepared: Prepared,
  requestId: string,
  expectedPayload: Record<string, unknown>,
  marker: string,
) {
  const [revision] = await db
    .select()
    .from(requestContentRevisions)
    .where(eq(requestContentRevisions.requestId, requestId));
  const [draft] = await db
    .select()
    .from(drafts)
    .where(eq(drafts.id, prepared.input.draftId));
  assert.deepEqual(revision.content, prepared.words);
  assert.deepEqual(draft.structuredContent, prepared.words);
  const jobs = await db
    .select()
    .from(modelJobs)
    .where(eq(modelJobs.requestId, requestId));
  assert.deepEqual(
    jobs.map((job) => job.purpose).sort(),
    ["asset_match", "risk_assess"],
    "only the usual preparation jobs are queued",
  );
  for (const job of jobs) {
    assert.deepEqual(job.inputSnapshot, expectedPayload);
    assert.equal(JSON.stringify(job.inputSnapshot).includes(marker), false);
    assert.equal(
      job.currentModelCallId,
      null,
      "no model was called by this flow",
    );
  }
  const liveInput = await effectiveInput(
    db,
    "risk_assess",
    prepared.input.draftId,
    requestId,
  );
  assert.deepEqual(
    liveInput.payload,
    expectedPayload,
    "later preparation also excludes dedicated priority evidence",
  );
  const ratings = await db
    .select()
    .from(taskCompletions)
    .where(eq(taskCompletions.requestId, requestId));
  assert.equal(ratings.length, 1);
  assert.equal(ratings[0].rating, 4);
}

async function adoptImmediately(
  requestId: string,
  rowVersion: number,
  proposalId: string,
  supplierId: string,
) {
  const reviewer = await createVisitor({
    displayName: "Priority intake adopting reviewer",
  });
  const result = await savePriority(
    { ...reviewer, actingView: "contributor" },
    {
      requestId,
      expectedRowVersion: rowVersion,
      decisions: [{ factor: "reach", action: "adopt", proposalId }],
    },
  );
  const reach = result.priority.factors.find(
    (factor) => factor.factor === "reach",
  )!.reviewed!;
  assert.equal(reach.proposalId, proposalId);
  assert.equal(reach.suppliedByActorId, supplierId);
  assert.equal(reach.recordedByActorId, supplierId);
  assert.equal(reach.reviewerActorId, reviewer.actorId);
  assert.equal(
    result.priority.score,
    null,
    "adopting one input does not manufacture a complete score",
  );
}

async function optionalContribution(path: SubmissionPath) {
  const missing = await prepare(path);
  const submitted = await submit(missing);
  const priority = await db.transaction((tx) =>
    readPriority(tx, submitted.requestId),
  );
  assert.ok(priority.factors.every((factor) => factor.status === "missing"));
  assert.equal(priority.scoreId, null);
  const unknown = await prepare(path);
  const withUnknown = await submit(unknown, [
    { factor: "effort", estimate: { value: null, basis: "" } },
  ]);
  const pending = await db.transaction((tx) =>
    readPriority(tx, withUnknown.requestId),
  );
  assert.equal(
    pending.factors.find((factor) => factor.factor === "effort")!.proposals[0]
      .estimate.value,
    null,
  );
  assert.equal(pending.complete, false);
}

async function invalidContributionRollsBack(path: SubmissionPath) {
  const prepared = await prepare(path);
  const [before] = await db
    .select()
    .from(drafts)
    .where(eq(drafts.id, prepared.input.draftId));
  const reach = proposedValues("duplicated-factor")[0];
  await assert.rejects(
    () => submit(prepared, [reach, reach]),
    (error: unknown) =>
      error instanceof WorkflowError && error.code === "VALIDATION_FAILED",
  );
  assert.deepEqual(
    (await db.select().from(drafts).where(eq(drafts.id, before.id)))[0],
    before,
    "failed proposal persistence rolls back the draft state, content, version and submission timestamp",
  );
  assert.equal(
    (
      await db
        .select()
        .from(requests)
        .where(eq(requests.sourceDraftId, before.id))
    ).length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(taskCompletions)
        .where(eq(taskCompletions.visitorId, prepared.owner.visitorId))
    ).length,
    0,
  );
  assert.equal(
    (await db.select().from(modelJobs).where(eq(modelJobs.draftId, before.id)))
      .length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(priorityContributions)
        .where(
          eq(priorityContributions.recordedByActorId, prepared.owner.actorId),
        )
    ).length,
    0,
  );
  const fixed = await submit(prepared, [reach]);
  assert.ok(
    fixed.requestId,
    "the same unchanged draft and key can submit once the invalid inputs are fixed",
  );
}

async function prepareAudienceCheck() {
  const prepared = await prepare("submitIntake");
  const submitted = await submit(
    prepared,
    proposedValues("REQUESTER-SUPPLIED"),
  );
  const reviewer = {
    ...(await createVisitor({ displayName: "Audience reviewer" })),
    actingView: "contributor" as const,
  };
  const specialist = {
    ...(await createVisitor({ displayName: "Audience specialist" })),
    actingView: "contributor" as const,
  };
  const saved = await db
    .select()
    .from(priorityContributions)
    .where(eq(priorityContributions.requestId, submitted.requestId));
  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, submitted.requestId));
  const scored = await savePriority(reviewer, {
    requestId: request.id,
    expectedRowVersion: request.rowVersion,
    decisions: [
      {
        factor: "reach",
        action: "adopt",
        proposalId: saved.find((item) => item.factor === "reach")!.id,
      },
      {
        factor: "impact",
        action: "adopt",
        proposalId: saved.find((item) => item.factor === "impact")!.id,
      },
      {
        factor: "confidence",
        action: "replace",
        estimate: { value: 0.8, basis: "Operational evidence" },
      },
      {
        factor: "effort",
        action: "replace",
        estimate: { value: 2, basis: "Previously reviewed team estimate" },
      },
    ],
  });
  assert.equal(scored.priority.score, 48);
  return { prepared, reviewer, specialist, request, scored };
}

async function preparePrivateAnswer() {
  const { prepared, reviewer, specialist, request, scored } =
    await prepareAudienceCheck();
  const markers = {
    question: `INTERNAL-QUESTION-${randomUUID()}`,
    answer: `INTERNAL-ANSWER-${randomUUID()}`,
    estimate: `INTERNAL-ESTIMATE-${randomUUID()}`,
  };
  const asked = await askReviewInput(reviewer, {
    requestId: request.id,
    expectedRowVersion: scored.rowVersion,
    inputRequestId: randomUUID(),
    area: "rice",
    factor: "effort",
    audience: "internal",
    assigneeActorId: specialist.actorId,
    question: markers.question,
    scope: "Validate the complete deployment effort",
  });
  const answered = await answerReviewInput(specialist, {
    requestId: request.id,
    expectedRowVersion: asked.rowVersion,
    inputRequestId: asked.inputRequest.id,
    expectedInputVersion: asked.inputRequest.rowVersion,
    responseId: randomUUID(),
    answer: markers.answer,
    outcome: "provided",
    proposal: {
      factor: "effort",
      estimate: { value: 3, basis: markers.estimate },
    },
  });
  assert.ok(answered.response.contributionId);
  return { prepared, reviewer, request, markers, answered };
}

async function internalPriorityAudience() {
  const { prepared, reviewer, request, markers, answered } =
    await preparePrivateAnswer();
  assert.ok(answered.response.contributionId);
  await assertPriorityAudience(prepared, request.id, {
    markers,
    proposalId: answered.response.contributionId,
    reviewed: false,
  });
  const rejected = await submitAssessment(reviewer, {
    requestId: request.id,
    expectedRowVersion: answered.rowVersion,
    idempotencyKey: randomUUID(),
    priorityDecisions: [
      {
        factor: "effort",
        action: "reject",
        proposalId: answered.response.contributionId,
        reason: "Internal proposal needs reconsideration",
      },
    ],
  });
  const hiddenDecision = await requestView(prepared.owner, request.id, true);
  assert.ok(
    hiddenDecision.priority.factors.every((factor) =>
      factor.decisions.every(
        (decision) => decision.proposalId !== answered.response.contributionId,
      ),
    ),
    "internal rejected proposal history is withheld",
  );
  await assertPriorityAudience(prepared, request.id, {
    markers,
    proposalId: answered.response.contributionId,
    reviewed: false,
  });
  await submitAssessment(reviewer, {
    requestId: request.id,
    expectedRowVersion: rejected.rowVersion,
    idempotencyKey: randomUUID(),
    priorityDecisions: [
      {
        factor: "effort",
        action: "adopt",
        proposalId: answered.response.contributionId,
      },
    ],
  });
  await assertPriorityAudience(prepared, request.id, {
    markers,
    proposalId: answered.response.contributionId,
    reviewed: true,
  });
}

async function assertPriorityAudience(
  prepared: Prepared,
  requestId: string,
  state: {
    markers: { question: string; answer: string; estimate: string };
    proposalId: string;
    reviewed: boolean;
  },
) {
  const requester = await requestView(prepared.owner, requestId, true);
  const contributor = await requestView(prepared.owner, requestId, false);
  const publicJson = JSON.stringify(requester);
  assert.equal(requester.inputRequests.length, 0);
  assert.equal(publicJson.includes(state.markers.question), false);
  assert.equal(publicJson.includes(state.markers.answer), false);
  assert.equal(
    publicJson.includes(state.markers.estimate),
    state.reviewed,
    "internal effort evidence appears only after explicit human adoption",
  );
  assert.equal(contributor.inputRequests.length, 1);
  assert.equal(contributor.inputRequests[0].question, state.markers.question);
  assert.equal(
    contributor.inputRequests[0].latestResponse!.answer,
    state.markers.answer,
  );
  assert.ok(
    contributor.priority.factors[3].proposals.some(
      (proposal) => proposal.id === state.proposalId,
    ),
  );
  const publicProposals = requester.priority.factors.flatMap(
    (factor) => factor.proposals,
  );
  assert.equal(publicProposals.length, 3);
  assert.ok(
    publicProposals.every(
      (proposal) =>
        proposal.source === "requester" &&
        proposal.suppliedByActorId === prepared.owner.actorId,
    ),
  );
  const expectedScore = state.reviewed ? 32 : null;
  assert.equal(requester.priority.score, expectedScore);
  assert.equal(contributor.priority.score, expectedScore);
  assert.equal(requester.priority.complete, state.reviewed);
  assert.equal(contributor.priority.complete, state.reviewed);
  const [queue] = await enrichedRequests(undefined, [requestId]);
  assert.equal(
    queue.score === null ? null : Number(queue.score),
    expectedScore,
    "requester, contributor and queue agree on ranking eligibility",
  );
  if (state.reviewed) {
    assert.equal(
      requester.priority.factors[3].reviewed!.proposalId,
      state.proposalId,
    );
    assert.equal(requester.priority.factors[3].reviewed!.estimate.value, 3);
    assert.equal(contributor.inputRequests[0].state, "resolved");
  }
}

try {
  for (const path of paths) {
    await successfulContribution(path);
    await optionalContribution(path);
    await invalidContributionRollsBack(path);
  }
  await internalPriorityAudience();
  console.log(
    "Requester priority integration passed through submitRequest and submitIntake: current attribution, immediate adoption, optional inputs, model isolation, replay and rollback.",
  );
} finally {
  await client.end();
}
