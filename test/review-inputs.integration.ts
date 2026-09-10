// Writes only to an explicitly selected isolated review-input test database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import postgres from "postgres";

import { requests } from "../src/db/schema/requests.ts";
import { reviewInputRequests } from "../src/db/schema/review-inputs.ts";
import {
  createVisitor,
  saveDraft,
  submitRequest,
} from "../src/workflow/requester.ts";
import { WorkflowError } from "../src/workflow/errors.ts";
import { applyPriorityDecisions } from "../src/workflow/priority.ts";
import { collectCorpus } from "../src/models/corpus.ts";
import {
  getReviewState,
  recordAssetOutcome,
  saveAssetDecision,
  saveRiskDecision,
} from "../src/workflow/review.ts";
import { enrichedRequests } from "../src/server/read-model.ts";
import { queueView } from "../src/server/queue.ts";
import {
  answerReviewInput,
  assignReviewInput,
  askReviewInput,
  readReviewInputs,
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
    "Review-input checks require an isolated one_door_reviewer_* or one_door_review_inputs_* database.",
  );
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
const requester = await createVisitor({ displayName: "Input requester" });
const reviewer = await createVisitor({ displayName: "Input reviewer" });
const expert = await createVisitor({ displayName: "Input specialist" });
const outsider = await createVisitor({
  displayName: "Input other contributor",
});
const reviewerCtx: ActorContext = { ...reviewer, actingView: "contributor" };
const expertCtx: ActorContext = { ...expert, actingView: "contributor" };
const adminCtx: ActorContext = { ...reviewer, actingView: "administrator" };

async function rejects(code: string, action: () => Promise<unknown>) {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof WorkflowError && error.code === code,
  );
}

async function makeRequest() {
  const [organization] = await sql<
    { id: string }[]
  >`SELECT id FROM organizations WHERE active LIMIT 1`;
  assert.ok(organization);
  const draft = await saveDraft(requester, {
    organizationId: organization.id,
    rawNeed: "A deployment estimate is needed.",
    content: {
      title: "Review input integration",
      problem: "Need a deployment estimate for three offices.",
      affectedPeople: "Office staff",
      acceptanceCriteria: ["Office staff can use the tool"],
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

async function versionOf(requestId: string) {
  const [row] = await sql<
    { row_version: number }[]
  >`SELECT row_version FROM requests WHERE id = ${requestId}`;
  return row.row_version;
}

async function readInputs(requestId: string) {
  return withDb((db) => readReviewInputs(db, requestId));
}

async function snapshot(requestId: string) {
  const [row] =
    await sql`SELECT current_revision_id, current_rice_score_id, stage FROM requests WHERE id = ${requestId}`;
  const tasks =
    await sql`SELECT area, state, completed_assessment_id FROM review_tasks WHERE request_id = ${requestId} ORDER BY area`;
  const jobs =
    await sql`SELECT id FROM model_jobs WHERE request_id = ${requestId} ORDER BY id`;
  return { row, tasks: [...tasks], jobs: [...jobs] };
}

async function askEffort(requestId: string, assigneeActorId?: string) {
  const inputRequestId = randomUUID();
  const data = {
    requestId,
    inputRequestId,
    expectedRowVersion: await versionOf(requestId),
    area: "rice",
    audience: "internal",
    factor: "effort",
    question: "What is the deployment effort?",
    scope: "All three offices",
    expertise: "Delivery estimation",
    assigneeActorId,
  };
  const result = await askReviewInput(reviewerCtx, data);
  const replay = await askReviewInput(reviewerCtx, data);
  assert.equal(replay.inputRequest.id, inputRequestId);
  assert.equal(
    replay.rowVersion,
    result.rowVersion,
    "replayed question does not bump the request",
  );
  const refreshedRetry = await askReviewInput(reviewerCtx, {
    ...data,
    expectedRowVersion: result.rowVersion,
  });
  assert.equal(
    refreshedRetry.rowVersion,
    result.rowVersion,
    "refreshing before a retry still does not mutate the request",
  );
  return result;
}

async function checkAllocationAndUnknown(requestId: string) {
  const asked = await askEffort(requestId);
  const base = {
    requestId,
    inputRequestId: asked.inputRequest.id,
    expectedRowVersion: asked.rowVersion,
    expectedInputVersion: asked.inputRequest.rowVersion,
  };
  await rejects("NOT_OWNER", () =>
    assignReviewInput(reviewerCtx, {
      ...base,
      assigneeActorId: expert.actorId,
    }),
  );
  const assigned = await assignReviewInput(adminCtx, {
    ...base,
    assigneeActorId: expert.actorId,
  });
  const reply = {
    ...base,
    responseId: randomUUID(),
    expectedRowVersion: assigned.rowVersion,
    expectedInputVersion: assigned.inputRequest.rowVersion,
    answer: "I do not know the effort yet.",
    outcome: "unknown",
  };
  await rejects("NOT_OWNER", () =>
    answerReviewInput({ ...outsider, actingView: "contributor" }, reply),
  );
  await rejects("NOT_OWNER", () =>
    answerReviewInput({ ...requester, actingView: "requester" }, reply),
  );
  const before = await snapshot(requestId);
  const answered = await answerReviewInput(expertCtx, reply);
  assert.equal(
    answered.inputRequest.state,
    "answered",
    "unknown response remains unresolved",
  );
  assert.equal(answered.response.respondentActorId, expert.actorId);
  assert.equal(answered.response.recordedByActorId, expert.actorId);
  assert.deepEqual(
    await snapshot(requestId),
    before,
    "answer neither revises content nor resets tasks nor enqueues models",
  );
  const replay = await answerReviewInput(expertCtx, reply);
  assert.equal(replay.replayed, true);
  assert.equal(replay.rowVersion, answered.rowVersion);
  await rejects("VERSION_CONFLICT", () =>
    answerReviewInput(expertCtx, { ...reply, answer: "Changed content" }),
  );
  await rejects("APPROVAL_BLOCKED", () =>
    withDb((db) =>
      db.transaction(async (tx) => {
        const request = await lockUnresolvedRequest(tx, requestId);
        return resolveReviewInputInTx(tx, reviewerCtx, request, {
          inputRequestId: asked.inputRequest.id,
          expectedInputVersion: answered.inputRequest.rowVersion,
          responseId: answered.response.id,
          resolutionKind: "priority_contribution",
          resolutionId: randomUUID(),
        });
      }),
    ),
  );
  return answered;
}

async function provideEffort(
  requestId: string,
  unknown: Awaited<ReturnType<typeof answerReviewInput>>,
) {
  const reply = {
    requestId,
    inputRequestId: unknown.inputRequest.id,
    responseId: randomUUID(),
    expectedRowVersion: await versionOf(requestId),
    expectedInputVersion: unknown.inputRequest.rowVersion,
    answer: "Engineering reviewed a two person-month deployment estimate.",
    outcome: "provided",
    proposal: {
      factor: "effort",
      estimate: { value: 2, basis: "Engineering deployment estimate" },
    },
  };
  const answered = await answerReviewInput(expertCtx, reply);
  assert.ok(answered.response.contributionId);
  const replay = await answerReviewInput(expertCtx, {
    ...reply,
    proposal: {
      factor: "effort",
      estimate: { basis: "Engineering deployment estimate", value: 2 },
    },
  });
  assert.equal(
    replay.replayed,
    true,
    "JSON property order does not break safe reply retries",
  );
  return answered;
}

async function checkProposalResolution(
  requestId: string,
  unknown: Awaited<ReturnType<typeof answerReviewInput>>,
) {
  const answered = await provideEffort(requestId, unknown);
  const resolution = {
    inputRequestId: unknown.inputRequest.id,
    expectedInputVersion: answered.inputRequest.rowVersion,
    responseId: answered.response.id,
    resolutionKind: "priority_contribution",
    resolutionId: answered.response.contributionId,
  };
  await rejects("APPROVAL_BLOCKED", () =>
    withDb((db) =>
      db.transaction(async (tx) => {
        const request = await lockUnresolvedRequest(tx, requestId);
        return resolveReviewInputInTx(tx, reviewerCtx, request, resolution);
      }),
    ),
  );
  await rejects("APPROVAL_BLOCKED", () =>
    withDb((db) =>
      db.transaction(async (tx) => {
        const request = await lockUnresolvedRequest(tx, requestId);
        await applyPriorityDecisions(tx, reviewerCtx, request, [
          {
            factor: "effort",
            action: "adopt",
            proposalId: answered.response.contributionId,
          },
        ]);
        await resolveReviewInputInTx(tx, reviewerCtx, request, {
          ...resolution,
          responseId: unknown.response.id,
        });
      }),
    ),
  );
  const [count] = await sql<
    { count: string }[]
  >`SELECT count(*)::text AS count FROM priority_decisions WHERE request_id = ${requestId}`;
  assert.equal(
    count.count,
    "0",
    "failed resolution rolls back adoption in the same transaction",
  );
  await withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockUnresolvedRequest(tx, requestId);
      await applyPriorityDecisions(tx, reviewerCtx, request, [
        {
          factor: "effort",
          action: "adopt",
          proposalId: answered.response.contributionId,
        },
      ]);
      await resolveReviewInputInTx(tx, reviewerCtx, request, resolution);
      await tx
        .update(requests)
        .set({ rowVersion: request.rowVersion + 1 })
        .where(eq(requests.id, request.id));
    }),
  );
  const [view] = await readInputs(requestId);
  assert.equal(view.state, "resolved");
  assert.equal(
    view.responses.length,
    2,
    "unknown and useful replies remain in history",
  );
  assert.equal(view.latestResponse?.respondentName, "Input specialist");
  assert.equal(view.resolvedByName, "Input reviewer");
}

async function checkRequesterIsolation(requestId: string) {
  const asked = await askReviewInput(reviewerCtx, {
    requestId,
    inputRequestId: randomUUID(),
    expectedRowVersion: await versionOf(requestId),
    area: "rice",
    audience: "requester",
    factor: "reach",
    question: "How many offices would benefit?",
  });
  const data = {
    requestId,
    inputRequestId: asked.inputRequest.id,
    responseId: randomUUID(),
    expectedRowVersion: asked.rowVersion,
    expectedInputVersion: asked.inputRequest.rowVersion,
    answer: "Three offices this year.",
    outcome: "provided",
    proposal: {
      factor: "reach",
      estimate: {
        value: 3,
        basis: "The offices in the proposed rollout",
        unit: "offices",
        period: "this year",
      },
    },
  };
  await rejects("NOT_OWNER", () => answerReviewInput(expertCtx, data));
  await rejects("NOT_OWNER", () =>
    answerReviewInput({ ...outsider, actingView: "requester" }, data),
  );
  const response = await answerReviewInput(
    { ...requester, actingView: "requester" },
    data,
  );
  assert.equal(response.response.respondentActorId, requester.actorId);
  const visible = await withDb((db) =>
    readReviewInputs(db, requestId, { audience: "requester" }),
  );
  assert.equal(
    visible.length,
    1,
    "requester view never leaks internal questions or replies",
  );
  assert.equal(visible[0].id, asked.inputRequest.id);
}

async function checkStalenessAndCompletedReview(requestId: string) {
  const asked = await askEffort(requestId, expert.actorId);
  await sql`UPDATE requests SET fixture_generation = fixture_generation + 1, row_version = row_version + 1 WHERE id = ${requestId}`;
  await rejects("VERSION_CONFLICT", async () =>
    answerReviewInput(expertCtx, {
      requestId,
      inputRequestId: asked.inputRequest.id,
      responseId: randomUUID(),
      expectedRowVersion: await versionOf(requestId),
      expectedInputVersion: asked.inputRequest.rowVersion,
      answer: "An answer to the old question",
      outcome: "provided",
    }),
  );
  assert.equal(
    (await readInputs(requestId)).find(
      (input) => input.id === asked.inputRequest.id,
    )?.current,
    false,
  );
  await sql`UPDATE requests SET stage = 'first_review_completed', first_review_completed_at = now() WHERE id = ${requestId}`;
  const completedAsk = await askEffort(requestId, expert.actorId);
  await answerReviewInput(expertCtx, {
    requestId,
    inputRequestId: completedAsk.inputRequest.id,
    responseId: randomUUID(),
    expectedRowVersion: completedAsk.rowVersion,
    expectedInputVersion: completedAsk.inputRequest.rowVersion,
    answer: "Delivery work remains estimable after first review.",
    outcome: "provided",
  });
  await rejects("INVALID_STATE", async () =>
    askReviewInput(reviewerCtx, {
      requestId,
      inputRequestId: randomUUID(),
      expectedRowVersion: await versionOf(requestId),
      area: "risk",
      audience: "internal",
      question: "Reopen risk?",
      expertise: "Risk",
    }),
  );
  const [request] = await sql<
    { fixture_generation: number }[]
  >`SELECT fixture_generation FROM requests WHERE id = ${requestId}`;
  await sql`INSERT INTO request_resolutions (id, request_id, outcome, summary, reason, resolved_by_actor_id, request_generation)
    VALUES (${randomUUID()}, ${requestId}, 'closed_without_fulfillment', 'Integration-test closure', 'Exercise terminal state', ${reviewer.actorId}, ${request.fixture_generation})`;
  await rejects("INVALID_STATE", () => askEffort(requestId, expert.actorId));
}

async function checkAtomicAnswerRollback(requestId: string) {
  const asked = await askEffort(requestId, expert.actorId);
  await rejects("VALIDATION_FAILED", () =>
    answerReviewInput(expertCtx, {
      requestId,
      inputRequestId: asked.inputRequest.id,
      responseId: randomUUID(),
      expectedRowVersion: asked.rowVersion,
      expectedInputVersion: asked.inputRequest.rowVersion,
      answer: "The estimate belongs to another factor.",
      outcome: "provided",
      proposal: {
        factor: "impact",
        estimate: { value: 2, basis: "Wrong factor" },
      },
    }),
  );
  const [stored] = await withDb((db) =>
    db
      .select()
      .from(reviewInputRequests)
      .where(eq(reviewInputRequests.id, asked.inputRequest.id)),
  );
  assert.equal(stored.rowVersion, asked.inputRequest.rowVersion);
  assert.equal(stored.state, "open");
  assert.equal(await versionOf(requestId), asked.rowVersion);
}

async function createRiskAssessment(requestId: string, withFinding: boolean) {
  const [request] = await sql<
    {
      source_draft_id: string;
      current_revision_id: string;
      fixture_generation: number;
    }[]
  >`
    SELECT source_draft_id, current_revision_id, fixture_generation FROM requests WHERE id = ${requestId}`;
  const corpus = await withDb((db) => collectCorpus(db, "risk_assess"));
  const assessmentId = randomUUID();
  await sql`INSERT INTO risk_assessments (id, draft_id, revision_id, request_generation, status, policy_corpus_hash, origin)
    VALUES (${assessmentId}, ${request.source_draft_id}, ${request.current_revision_id}, ${request.fixture_generation}, 'succeeded', ${corpus.hash}, 'live')`;
  if (!withFinding) return { assessmentId, findingId: null };
  const [rule] = await sql<
    { id: string }[]
  >`SELECT id FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`;
  const findingId = randomUUID();
  await sql`INSERT INTO risk_findings (id, assessment_id, policy_rule_id, kind, evidence, proposed_severity, rationale)
    VALUES (${findingId}, ${assessmentId}, ${rule.id}, 'supported_risk', 'Synthetic request evidence', 'moderate', 'Synthetic finding for currency check')`;
  return { assessmentId, findingId };
}

async function changePolicyCorpus() {
  const suffix = randomUUID();
  await sql`INSERT INTO policy_rules (id, code, version, lifecycle, domain, title, rule, trigger_terms, default_severity, citation, content_hash)
    SELECT ${randomUUID()}, ${"INPUT-CURRENCY-" + suffix}, 1, 'active', domain, 'Synthetic additional rule', rule,
      trigger_terms, default_severity, 'Integration test only', ${suffix}
    FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`;
}

async function answeredRiskQuestion(requestId: string, findingId: string) {
  const asked = await askReviewInput(reviewerCtx, {
    requestId,
    inputRequestId: randomUUID(),
    expectedRowVersion: await versionOf(requestId),
    area: "risk",
    audience: "internal",
    findingId,
    question: "Does the proposed rule apply?",
    assigneeActorId: expert.actorId,
  });
  const answer = await answerReviewInput(expertCtx, {
    requestId,
    inputRequestId: asked.inputRequest.id,
    responseId: randomUUID(),
    expectedRowVersion: asked.rowVersion,
    expectedInputVersion: asked.inputRequest.rowVersion,
    answer: "The rule applies to this request.",
    outcome: "provided",
  });
  const reassigned = await assignReviewInput(adminCtx, {
    requestId,
    inputRequestId: asked.inputRequest.id,
    expectedRowVersion: answer.rowVersion,
    expectedInputVersion: answer.inputRequest.rowVersion,
    assigneeActorId: expert.actorId,
  });
  const [view] = await readInputs(requestId);
  assert.equal(view.current, true);
  assert.equal(
    view.state,
    "answered",
    "allocation does not silently resolve a question",
  );
  assert.equal(
    view.latestResponse?.id,
    answer.response.id,
    "allocation preserves the latest answer",
  );
  await saveRiskDecision(reviewerCtx, {
    requestId,
    findingId,
    decision: "confirmed",
    expectedRowVersion: reassigned.rowVersion,
  });
  const [finding] = await sql<
    { current_decision_id: string }[]
  >`SELECT current_decision_id FROM risk_findings WHERE id = ${findingId}`;
  return {
    inputRequest: reassigned.inputRequest,
    response: answer.response,
    decisionId: finding.current_decision_id,
  };
}

async function checkReplacedRiskTarget() {
  const request = await makeRequest();
  const original = await createRiskAssessment(request.requestId, true);
  assert.ok(original.findingId);
  const answered = await answeredRiskQuestion(
    request.requestId,
    original.findingId,
  );
  await changePolicyCorpus();
  const replacement = await createRiskAssessment(request.requestId, false);
  assert.notEqual(replacement.assessmentId, original.assessmentId);
  const [input] = await readInputs(request.requestId);
  assert.equal(
    input.current,
    false,
    "a same-revision replaced target is historical",
  );
  const [row] = await enrichedRequests(undefined, [request.requestId]);
  assert.equal(
    row.inputRequests.length,
    0,
    "queue and full view share target currency",
  );
  const mine = await queueView({ assigneeActorId: expert.actorId });
  assert.equal(
    mine.rows.some((item) => item.requestId === request.requestId),
    false,
  );
  assert.equal(
    (await getReviewState(request.requestId)).blockers.includes(
      "RISK_FOLLOW_UP_OPEN",
    ),
    false,
    "historical questions do not block the replacement assessment",
  );
  await rejects("VERSION_CONFLICT", () =>
    answerReviewInput(expertCtx, {
      requestId: request.requestId,
      inputRequestId: input.id,
      responseId: randomUUID(),
      expectedRowVersion: row.rowVersion,
      expectedInputVersion: input.rowVersion,
      answer: "A later answer about the old finding",
      outcome: "provided",
    }),
  );
  await rejects("VERSION_CONFLICT", () =>
    withDb((db) =>
      db.transaction(async (tx) => {
        const locked = await lockUnresolvedRequest(tx, request.requestId);
        await resolveReviewInputInTx(tx, reviewerCtx, locked, {
          inputRequestId: input.id,
          expectedInputVersion: input.rowVersion,
          responseId: answered.response.id,
          resolutionKind: "risk_decision",
          resolutionId: answered.decisionId,
        });
      }),
    ),
  );
}

async function createAssetAssessment(
  requestId: string,
  withCandidate: boolean,
) {
  const [request] = await sql<
    {
      source_draft_id: string;
      current_revision_id: string;
      fixture_generation: number;
    }[]
  >`
    SELECT source_draft_id, current_revision_id, fixture_generation FROM requests WHERE id = ${requestId}`;
  const corpus = await withDb((db) => collectCorpus(db, "asset_match"));
  const assessmentId = randomUUID();
  await sql`INSERT INTO asset_assessments (id, draft_id, revision_id, request_generation, status, catalog_corpus_hash, origin)
    VALUES (${assessmentId}, ${request.source_draft_id}, ${request.current_revision_id}, ${request.fixture_generation}, 'succeeded', ${corpus.hash}, 'live')`;
  if (!withCandidate) return { assessmentId, candidateId: null };
  const [item] = await sql<{ id: string; current_version: number }[]>`
    SELECT id, current_version FROM catalog_items WHERE approval_status = 'approved' AND publication_state = 'published' LIMIT 1`;
  const candidateId = randomUUID();
  await sql`INSERT INTO asset_candidates (id, assessment_id, catalog_item_id, catalog_version, rank, fit_band, coverage, gaps, dependencies, rationale)
    VALUES (${candidateId}, ${assessmentId}, ${item.id}, ${item.current_version}, 1, 'possible', '{}', '{}', '{}', 'Synthetic candidate for currency check')`;
  return { assessmentId, candidateId };
}

async function checkReplacedCandidateTarget() {
  const request = await makeRequest();
  const original = await createAssetAssessment(request.requestId, true);
  assert.ok(original.candidateId);
  const asked = await askReviewInput(reviewerCtx, {
    requestId: request.requestId,
    inputRequestId: randomUUID(),
    expectedRowVersion: await versionOf(request.requestId),
    area: "assets",
    audience: "internal",
    candidateId: original.candidateId,
    question: "Can this option meet the need?",
    assigneeActorId: expert.actorId,
  });
  const answer = await answerReviewInput(expertCtx, {
    requestId: request.requestId,
    inputRequestId: asked.inputRequest.id,
    responseId: randomUUID(),
    expectedRowVersion: asked.rowVersion,
    expectedInputVersion: asked.inputRequest.rowVersion,
    answer: "The option meets the need.",
    outcome: "provided",
  });
  await saveAssetDecision(reviewerCtx, {
    requestId: request.requestId,
    candidateId: original.candidateId,
    decision: "accepted",
    expectedRowVersion: answer.rowVersion,
  });
  const [oldCandidate] = await sql<
    { current_decision_id: string }[]
  >`SELECT current_decision_id FROM asset_candidates WHERE id = ${original.candidateId}`;
  const replacement = await createAssetAssessment(request.requestId, false);
  assert.notEqual(replacement.assessmentId, original.assessmentId);
  await recordAssetOutcome(reviewerCtx, {
    requestId: request.requestId,
    outcome: "no_match",
    expectedRowVersion: await versionOf(request.requestId),
  });
  const [input] = await readInputs(request.requestId);
  assert.equal(
    input.current,
    false,
    "a replaced same-revision candidate question is historical",
  );
  const [row] = await enrichedRequests(undefined, [request.requestId]);
  assert.equal(row.inputRequests.length, 0);
  assert.equal(
    (await getReviewState(request.requestId)).blockers.includes(
      "ASSET_OUTCOME_PENDING",
    ),
    false,
  );
  await rejects("VERSION_CONFLICT", () =>
    answerReviewInput(expertCtx, {
      requestId: request.requestId,
      inputRequestId: input.id,
      responseId: randomUUID(),
      expectedRowVersion: row.rowVersion,
      expectedInputVersion: input.rowVersion,
      answer: "Another answer for the former candidate",
      outcome: "provided",
    }),
  );
  await rejects("VERSION_CONFLICT", () =>
    withDb((db) =>
      db.transaction(async (tx) => {
        const locked = await lockUnresolvedRequest(tx, request.requestId);
        await resolveReviewInputInTx(tx, reviewerCtx, locked, {
          inputRequestId: input.id,
          expectedInputVersion: input.rowVersion,
          responseId: answer.response.id,
          resolutionKind: "candidate_decision",
          resolutionId: oldCandidate.current_decision_id,
        });
      }),
    ),
  );
}

try {
  const request = await makeRequest();
  const unknown = await checkAllocationAndUnknown(request.requestId);
  await checkProposalResolution(request.requestId, unknown);
  await checkRequesterIsolation(request.requestId);
  await checkAtomicAnswerRollback(request.requestId);
  await checkStalenessAndCompletedReview(request.requestId);
  await checkReplacedRiskTarget();
  await checkReplacedCandidateTarget();
  console.log(
    "Review-input integration checks passed; isolated records retained.",
  );
} finally {
  await sql.end();
}
