import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  createVisitor,
  saveDraft,
  getOwnDraft,
  submitRequest,
  askClarification,
  answerClarification,
  getOwnRequest,
  WorkflowError,
} from "../src/workflow/index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("An isolated DATABASE_URL is required");
const sql = postgres(databaseUrl, { max: 1 });
const failure = (code: string) => (error: unknown) =>
  error instanceof WorkflowError && error.code === code;

try {
  const organizations = await sql`SELECT id FROM organizations LIMIT 2`;
  const visitor = await createVisitor();
  const draft = await saveDraft(visitor, {
    organizationId: organizations[0].id,
    rawNeed: "  Preserve my original words.  ",
  });
  assert.equal(draft.rawNeed, "  Preserve my original words.  ");
  await assert.rejects(
    saveDraft(visitor, {
      draftId: draft.draftId,
      content: { title: "Unversioned overwrite" },
    }),
    failure("VALIDATION_FAILED"),
  );
  const incomplete = await saveDraft(visitor, {
    draftId: draft.draftId,
    expectedRowVersion: 1,
    organizationId: organizations[1].id,
    rawNeed: "",
    content: { title: "", problem: "", affectedPeople: "" },
  });
  assert.equal(incomplete.organizationId, organizations[1].id);
  assert.equal((await getOwnDraft(visitor, draft.draftId)).content.title, "");
  const ready = await saveDraft(visitor, {
    draftId: draft.draftId,
    expectedRowVersion: incomplete.rowVersion,
    rawNeed: "Keep a request through a clarification round trip.",
    state: "ready",
    content: {
      title: "Clarification safety",
      problem: "Keep revised evidence together.",
      affectedPeople: "A fictional office",
      acceptanceCriteria: ["The same request returns"],
    },
  });
  await assert.rejects(
    submitRequest(visitor, {
      draftId: draft.draftId,
      rating: 5,
      idempotencyKey: randomUUID(),
      expectedRowVersion: 1,
    }),
    failure("VERSION_CONFLICT"),
  );
  const submitted = await submitRequest(visitor, {
    draftId: draft.draftId,
    rating: 5,
    idempotencyKey: randomUUID(),
    expectedRowVersion: ready.rowVersion,
  });
  const preAsk = await getOwnRequest(visitor, submitted.requestId);
  await assert.rejects(
    askClarification(
      { ...visitor, actorId: randomUUID(), actingView: "contributor" },
      {
        requestId: submitted.requestId,
        question: "An unknown actor cannot ask this.",
        expectedRowVersion: preAsk.rowVersion,
      },
    ),
    failure("NOT_FOUND"),
  );
  assert.equal(
    (await getOwnRequest(visitor, submitted.requestId)).rowVersion,
    preAsk.rowVersion,
    "a rejected actor must not change the request",
  );
  const question = await askClarification(
    { ...visitor, actingView: "contributor" },
    {
      requestId: submitted.requestId,
      question: "What must remain unchanged?",
      expectedRowVersion: preAsk.rowVersion,
    },
  );
  const owned = await getOwnRequest(visitor, submitted.requestId);
  await assert.rejects(
    answerClarification(visitor, {
      requestId: submitted.requestId,
      clarificationId: question.clarificationId,
      answer: "Do not accept an unversioned answer.",
    }),
    failure("VALIDATION_FAILED"),
  );
  await answerClarification(visitor, {
    requestId: submitted.requestId,
    clarificationId: question.clarificationId,
    expectedRowVersion: owned.rowVersion,
    answer: "Keep the identity and prior evidence.",
  });
  const [foreignDraft] =
    await sql`SELECT id FROM drafts WHERE id <> ${draft.draftId} LIMIT 1`;
  await assert.rejects(
    sql`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin, revision_id)
    VALUES (${randomUUID()}, ${foreignDraft.id}, 'succeeded', 'test', 'live', ${owned.currentRevisionId})
  `,
    (error: unknown) => (error as { code: string }).code === "23503",
  );
  console.log(
    "Workflow safety passed: incomplete WIP, original words, office updates, required versions, same-request assessment evidence.",
  );
} finally {
  await sql.end();
}
