// This suite retains new records in an explicitly selected isolated database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import postgres from "postgres";

import { collectCorpus } from "../src/models/corpus.ts";
import { dashboardView } from "../src/server/dashboard.ts";
import { enrichedRequests } from "../src/server/read-model.ts";
import { queueView } from "../src/server/queue.ts";
import {
  createVisitor,
  saveDraft,
  submitRequest,
} from "../src/workflow/requester.ts";
import {
  applyPriorityDecisions,
  savePriority,
} from "../src/workflow/priority.ts";
import { ensureReviewTasks } from "../src/workflow/review.ts";
import {
  answerReviewInput,
  askReviewInput,
  assignReviewInput,
  resolveReviewInputInTx,
} from "../src/workflow/review-inputs.ts";
import {
  lockUnresolvedRequest,
  withDb,
  type ActorContext,
} from "../src/workflow/shared.ts";

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^\/one_door_(reviewer|review_inputs)_/.test(new URL(url).pathname)
) {
  throw new Error(
    "Queue checks require an isolated one_door_reviewer_* or one_door_review_inputs_* database.",
  );
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
const requester = await createVisitor({ displayName: "Queue input requester" });
const reviewer = await createVisitor({ displayName: "Queue input reviewer" });
const expert = await createVisitor({
  displayName: "Queue unassigned specialist",
});
const reviewerCtx: ActorContext = { ...reviewer, actingView: "contributor" };
const expertCtx: ActorContext = { ...expert, actingView: "contributor" };

async function makeRequest(title: string) {
  const [organization] = await sql<
    { id: string }[]
  >`SELECT id FROM organizations WHERE active LIMIT 1`;
  const draft = await saveDraft(requester, {
    organizationId: organization.id,
    rawNeed: title,
    content: {
      title,
      problem: "Estimate a scoped deployment",
      affectedPeople: "Office staff",
      acceptanceCriteria: ["Staff can use the tool"],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready",
  });
  return submitRequest(requester, {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
}

async function rowOf(requestId: string) {
  const [row] = await enrichedRequests(undefined, [requestId]);
  assert.ok(row);
  return row;
}

async function isMine(actorId: string, requestId: string) {
  const queue = await queueView({
    assigneeActorId: actorId,
    demoExamples: false,
  });
  return queue.rows.some((row) => row.requestId === requestId);
}

async function askEffort(requestId: string, assigneeActorId?: string) {
  const row = await rowOf(requestId);
  return askReviewInput(reviewerCtx, {
    requestId,
    inputRequestId: randomUUID(),
    expectedRowVersion: row.rowVersion,
    area: "rice",
    factor: "effort",
    audience: "internal",
    question: "Who can estimate this deployment?",
    scope: "Three offices",
    expertise: "Delivery estimation",
    assigneeActorId,
  });
}

async function checkAssignmentAndAnswerVisibility(requestId: string) {
  const asked = await askEffort(requestId);
  assert.equal(await isMine(expert.actorId, requestId), false);
  assert.equal(await isMine(reviewer.actorId, requestId), false);
  const dashboard = await dashboardView();
  const allocation = dashboard.inputRequestsNeedingAllocation.find(
    (input) => input.id === asked.inputRequest.id,
  );
  assert.equal(allocation?.requestId, requestId);
  assert.equal(allocation?.title, "Queue input visibility");
  assert.equal(allocation?.question, asked.inputRequest.question);
  assert.equal(
    allocation?.coordinatorActorId,
    null,
    "the question does not create standing ownership",
  );
  assert.equal((await rowOf(requestId)).needsAttention, true);
  const assigned = await assignReviewInput(
    { ...reviewerCtx, actingView: "administrator" },
    {
      requestId,
      inputRequestId: asked.inputRequest.id,
      expectedRowVersion: asked.rowVersion,
      expectedInputVersion: asked.inputRequest.rowVersion,
      assigneeActorId: expert.actorId,
    },
  );
  assert.equal(
    await isMine(expert.actorId, requestId),
    true,
    "addressee enters My assignments without a standing assignment",
  );
  assert.equal(
    (await dashboardView()).inputRequestsNeedingAllocation.some(
      (input) => input.id === asked.inputRequest.id,
    ),
    false,
  );
  const answered = await answerReviewInput(expertCtx, {
    requestId,
    inputRequestId: asked.inputRequest.id,
    expectedRowVersion: assigned.rowVersion,
    expectedInputVersion: assigned.inputRequest.rowVersion,
    responseId: randomUUID(),
    answer: "I cannot estimate the integration yet.",
    outcome: "unknown",
  });
  assert.equal(
    await isMine(reviewer.actorId, requestId),
    true,
    "the question asker can find an unknown reply to review",
  );
  const row = await rowOf(requestId);
  assert.equal(row.inputRequests[0].latestResponse?.id, answered.response.id);
  assert.equal(
    row.inputRequests[0].latestResponse?.respondentName,
    "Queue unassigned specialist",
  );
  assert.equal(row.inputRequests[0].latestResponse?.outcome, "unknown");
  assert.equal(row.priorityPending, true);
  assert.equal(row.coordinatorActorId, null);
  return asked.inputRequest.id;
}

async function readyForReview(requestId: string) {
  await withDb((db) =>
    db.transaction((tx) => ensureReviewTasks(tx, requestId)),
  );
  const [request] = await sql<
    {
      source_draft_id: string;
      current_revision_id: string;
      fixture_generation: number;
    }[]
  >`
    SELECT source_draft_id, current_revision_id, fixture_generation FROM requests WHERE id = ${requestId}`;
  const hashes = await withDb(async (db) => ({
    asset: (await collectCorpus(db, "asset_match")).hash,
    risk: (await collectCorpus(db, "risk_assess")).hash,
  }));
  const assetId = randomUUID();
  const riskId = randomUUID();
  await sql`INSERT INTO asset_assessments (id, draft_id, revision_id, request_generation, status, catalog_corpus_hash, origin)
    VALUES (${assetId}, ${request.source_draft_id}, ${request.current_revision_id}, ${request.fixture_generation}, 'succeeded', ${hashes.asset}, 'live')`;
  await sql`INSERT INTO risk_assessments (id, draft_id, revision_id, request_generation, status, policy_corpus_hash, origin)
    VALUES (${riskId}, ${request.source_draft_id}, ${request.current_revision_id}, ${request.fixture_generation}, 'succeeded', ${hashes.risk}, 'live')`;
  await sql`UPDATE review_tasks SET state = 'completed', completed_at = now(), completed_assessment_id =
    CASE WHEN area = 'assets' THEN ${assetId}::uuid ELSE ${riskId}::uuid END
    WHERE request_id = ${requestId} AND area IN ('assets', 'risk')`;
  await sql`UPDATE requests SET stage = 'under_review' WHERE id = ${requestId}`;
}

async function checkPriorityAfterReview(requestId: string) {
  await readyForReview(requestId);
  const ready = await rowOf(requestId);
  assert.equal(
    ready.actionNeeded,
    "complete_first_review",
    "a missing score no longer sits ahead of completion",
  );
  assert.equal(ready.priorityPending, true);
  await sql`UPDATE requests SET stage = 'first_review_completed', first_review_completed_at = now() WHERE id = ${requestId}`;
  const completed = await rowOf(requestId);
  assert.equal(
    completed.priorityPending,
    true,
    "priority stays reachable after first review",
  );
  assert.equal(completed.phase, "approved");
  assert.equal(
    completed.actionNeeded,
    "execute_handoff",
    "pending priority neither grants nor blocks delivery authorization",
  );
  assert.equal(completed.inputRequests.length, 1);
  assert.equal(await isMine(expert.actorId, requestId), true);
  assert.equal(await isMine(reviewer.actorId, requestId), true);
}

async function score(requestId: string, reach: number) {
  const row = await rowOf(requestId);
  return savePriority(reviewerCtx, {
    requestId,
    expectedRowVersion: row.rowVersion,
    decisions: [
      {
        factor: "reach",
        action: "replace",
        estimate: {
          value: reach,
          basis: "Rollout scope",
          unit: "staff",
          period: "first year",
        },
      },
      {
        factor: "impact",
        action: "replace",
        estimate: { value: 1, basis: "Expected improvement" },
      },
      {
        factor: "confidence",
        action: "replace",
        estimate: { value: 1, basis: "Confirmed scope and delivery estimate" },
      },
      {
        factor: "effort",
        action: "replace",
        estimate: { value: 1, basis: "Engineering estimate" },
        suppliedByActorId: expert.actorId,
      },
    ],
  });
}

async function checkQuestionedScore(requestId: string) {
  await score(requestId, 50);
  const scored = await rowOf(requestId);
  assert.equal(Number(scored.score), 50);
  const asked = await askEffort(requestId, expert.actorId);
  const questioned = await rowOf(requestId);
  assert.equal(
    questioned.score,
    null,
    "a question about a scored factor removes the score from ranking",
  );
  assert.equal(
    questioned.currentRiceScoreId,
    scored.currentRiceScoreId,
    "the stored score remains as history",
  );
  assert.equal(questioned.priorityPending, true);
  const answer = await answerReviewInput(expertCtx, {
    requestId,
    inputRequestId: asked.inputRequest.id,
    expectedRowVersion: asked.rowVersion,
    expectedInputVersion: asked.inputRequest.rowVersion,
    responseId: randomUUID(),
    answer: "The one person-month estimate includes all three offices.",
    outcome: "provided",
    proposal: {
      factor: "effort",
      estimate: { value: 1, basis: "Engineering checked the complete rollout" },
    },
  });
  assert.equal(
    (await rowOf(requestId)).score,
    null,
    "receipt of an estimate alone does not restore ranking",
  );
  await withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockUnresolvedRequest(tx, requestId);
      await applyPriorityDecisions(tx, reviewerCtx, request, [
        {
          factor: "effort",
          action: "adopt",
          proposalId: answer.response.contributionId,
        },
      ]);
      await resolveReviewInputInTx(tx, reviewerCtx, request, {
        inputRequestId: asked.inputRequest.id,
        expectedInputVersion: answer.inputRequest.rowVersion,
        responseId: answer.response.id,
        resolutionKind: "priority_contribution",
        resolutionId: answer.response.contributionId,
      });
    }),
  );
  const reviewed = await rowOf(requestId);
  assert.equal(Number(reviewed.score), 50);
  assert.equal(reviewed.priorityPending, false);
  assert.equal(reviewed.inputRequests.length, 0);
  assert.equal(
    await isMine(expert.actorId, requestId),
    false,
    "resolved question stops granting assignment admission",
  );
}

async function checkScoreSorting(pendingId: string, positiveId: string) {
  const zero = await makeRequest("Queue zero reach score");
  await score(zero.requestId, 0);
  const ids = [pendingId, positiveId, zero.requestId];
  await sql`UPDATE requests SET coordinating_actor_id = ${reviewer.actorId} WHERE id IN ${sql(ids)}`;
  for (const direction of ["asc", "desc"]) {
    const queue = await queueView({
      assigneeActorId: reviewer.actorId,
      heading: { key: "score", direction },
    });
    const ours = queue.rows.filter((row) => ids.includes(row.requestId));
    assert.deepEqual(
      ours.map((row) => row.requestId),
      direction === "asc"
        ? [zero.requestId, positiveId, pendingId]
        : [positiveId, zero.requestId, pendingId],
    );
  }
  const order = await queueView({
    assigneeActorId: reviewer.actorId,
    sort: "score",
  });
  assert.deepEqual(
    order.rows
      .filter((row) => ids.includes(row.requestId))
      .map((row) => row.requestId),
    [positiveId, zero.requestId, pendingId],
  );
  const scored = await queueView({
    assigneeActorId: reviewer.actorId,
    scored: true,
  });
  assert.equal(
    scored.rows.some((row) => row.requestId === pendingId),
    false,
  );
  assert.equal(
    scored.rows.some((row) => row.requestId === zero.requestId),
    true,
    "a real zero score remains a scored request",
  );
}

async function checkStaleAndOverdue(requestId: string) {
  const asked = await askEffort(requestId, expert.actorId);
  await sql`UPDATE review_input_requests SET created_at = now() - interval '30 days' WHERE id = ${asked.inputRequest.id}`;
  const overdue = await rowOf(requestId);
  assert.equal(overdue.inputOverdue, true);
  assert.equal(
    (await dashboardView()).overdueInputRequests.some(
      (input) => input.id === asked.inputRequest.id,
    ),
    true,
  );
  await sql`UPDATE requests SET fixture_generation = fixture_generation + 1 WHERE id = ${requestId}`;
  const stale = await rowOf(requestId);
  assert.equal(
    stale.inputRequests.length,
    0,
    "prior-generation asks never appear as current work",
  );
  assert.equal(stale.inputOverdue, false);
  assert.equal(await isMine(expert.actorId, requestId), false);
}

try {
  const pending = await makeRequest("Queue input visibility");
  await checkAssignmentAndAnswerVisibility(pending.requestId);
  await checkPriorityAfterReview(pending.requestId);
  const positive = await makeRequest("Queue reviewed score");
  await checkQuestionedScore(positive.requestId);
  await checkScoreSorting(pending.requestId, positive.requestId);
  const stale = await makeRequest("Queue stale input");
  await checkStaleAndOverdue(stale.requestId);
  console.log("Review-input queue checks passed; isolated records retained.");
} finally {
  await sql.end();
}
