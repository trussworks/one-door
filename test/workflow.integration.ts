// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import {
  answerClarification,
  askClarification,
  createVisitor,
  getOwnDraft,
  getOwnRequest,
  getRequestRecord,
  listOwnWork,
  saveDraft,
  submitRequest,
  WorkflowError,
} from "../src/workflow/index.ts";

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

async function runScript(name: string, url: string): Promise<string> {
  const script = fileURLToPath(new URL(`scripts/${name}`, repoRoot));
  const { stdout } = await run(
    process.execPath,
    ["--experimental-strip-types", script],
    {
      cwd: fileURLToPath(repoRoot),
      env: { ...process.env, DATABASE_URL: url },
    },
  );
  return stdout.trim();
}

async function expectCode(
  code: string,
  action: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert.ok(
      error instanceof WorkflowError,
      `${label}: expected WorkflowError, got ${String(error)}`,
    );
    assert.equal(error.code, code, `${label}: wrong code`);
    return;
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`);
}

const url = databaseUrl();
process.env.DATABASE_URL = url;
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [persona] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' LIMIT 1`,
  );

  // ── 1. Visitors ──────────────────────────────────────────────────────────
  const alice = await createVisitor();
  const bella = await createVisitor();
  assert.notEqual(alice.actorId, bella.actorId, "distinct actors per visitor");

  // ── 2. Drafts ────────────────────────────────────────────────────────────
  const draft = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "The Budget Office needs a path to deploy an application.",
  });
  assert.equal(draft.state, "open");
  assert.equal(draft.rowVersion, 1);

  await expectCode(
    "NOT_OWNER",
    () => saveDraft(bella, { draftId: draft.draftId, rawNeed: "mine now" }),
    "foreign draft update",
  );
  await expectCode(
    "VERSION_CONFLICT",
    () =>
      saveDraft(alice, {
        draftId: draft.draftId,
        expectedRowVersion: 99,
        currentStep: "questions",
      }),
    "stale draft version",
  );
  await expectCode(
    "NOT_FOUND",
    () => saveDraft(alice, { draftId: randomUUID(), rawNeed: "ghost" }),
    "missing draft",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () => saveDraft(alice, { organizationId: randomUUID(), rawNeed: "x" }),
    "unknown organization",
  );

  const readied = await saveDraft(alice, {
    draftId: draft.draftId,
    expectedRowVersion: 1,
    content: {
      title: "Deploy the Budget Office application",
      problem: "The application has no approved path to production.",
      affectedPeople: "Budget Office staff and their customers",
      acceptanceCriteria: ["A release reaches production through review"],
      requirements: ["State identity integration"],
      constraints: ["Data stays in Colorado systems"],
      unknowns: ["Expected launch date"],
    },
    state: "ready",
  });
  assert.equal(readied.state, "ready");
  assert.equal(readied.rowVersion, 2);

  const ownDraft = await getOwnDraft(alice, draft.draftId);
  assert.equal(ownDraft.draftId, draft.draftId);
  await expectCode(
    "NOT_OWNER",
    () => getOwnDraft(bella, draft.draftId),
    "foreign draft read",
  );

  // ── 3. Submission ────────────────────────────────────────────────────────
  const unreadyDraft = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Second unfinished need",
  });
  await expectCode(
    "INVALID_STATE",
    () =>
      submitRequest(alice, {
        draftId: unreadyDraft.draftId,
        rating: 5,
        idempotencyKey: randomUUID(),
      }),
    "submit before ready",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      submitRequest(alice, {
        draftId: draft.draftId,
        rating: 0,
        idempotencyKey: randomUUID(),
      }),
    "rating below one",
  );

  const idempotencyKey = randomUUID();
  const submitted = await submitRequest(alice, {
    draftId: draft.draftId,
    expectedRowVersion: readied.rowVersion,
    rating: 4,
    idempotencyKey,
  });
  assert.match(submitted.displayId, /^OD-2\d+$/, "live display id range");
  assert.equal(submitted.stage, "submitted");
  assert.equal(submitted.routingState, "routing_requested");

  const replay = await submitRequest(alice, {
    draftId: draft.draftId,
    rating: 1,
    idempotencyKey,
  });
  assert.equal(
    replay.requestId,
    submitted.requestId,
    "replay returns the same request",
  );

  const [rowShape] = await sql.unsafe<
    Array<{
      requests: string;
      revisions: string;
      ratings: string;
      audits: string;
    }>
  >(`
    SELECT
      (SELECT count(*) FROM requests WHERE source_draft_id = '${draft.draftId}')::text AS requests,
      (SELECT count(*) FROM request_content_revisions WHERE request_id = '${submitted.requestId}')::text AS revisions,
      (SELECT count(*) FROM task_completions WHERE request_id = '${submitted.requestId}')::text AS ratings,
      (SELECT count(*) FROM audit_events
        WHERE subject_id = '${submitted.requestId}' AND event_type = 'request_submitted')::text AS audits
  `);
  assert.deepEqual(
    rowShape,
    { requests: "1", revisions: "1", ratings: "1", audits: "1" },
    "submission side effects exist exactly once",
  );

  const work = await listOwnWork(alice);
  assert.ok(
    work.requests.some((row) => row.requestId === submitted.requestId),
    "own request listed",
  );
  assert.ok(
    work.drafts.every((row) => row.draftId !== draft.draftId),
    "submitted draft leaves the draft list",
  );
  const bellaWork = await listOwnWork(bella);
  assert.equal(bellaWork.requests.length, 0, "other visitors see nothing");
  await expectCode(
    "NOT_OWNER",
    () => getOwnRequest(bella, submitted.requestId),
    "foreign request read",
  );

  // ── 4. Clarification round trip ──────────────────────────────────────────
  const reviewer = { actorId: persona.id, actingView: "contributor" as const };

  await expectCode(
    "NOT_FOUND",
    () =>
      askClarification(reviewer, { requestId: randomUUID(), question: "?" }),
    "ask on missing request",
  );

  const preAsk = await getOwnRequest(alice, submitted.requestId);
  const asked = await askClarification(reviewer, {
    requestId: submitted.requestId,
    question: "Roughly how many people would use the application?",
    expectedRowVersion: preAsk.rowVersion,
  });
  await expectCode(
    "CLARIFICATION_PENDING",
    () =>
      askClarification(reviewer, {
        requestId: submitted.requestId,
        question: "Second question while one is open",
        expectedRowVersion: asked.rowVersion,
      }),
    "second open question",
  );

  const withQuestion = await getOwnRequest(alice, submitted.requestId);
  assert.equal(withQuestion.answerNeeded, true, "owner sees answer needed");
  assert.equal(
    withQuestion.openClarification?.clarificationId,
    asked.clarificationId,
  );

  // Simulate a saved score and a prepared assessment against revision 1, so
  // the answer can prove invalidation.
  const [revisionOne] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM request_content_revisions
     WHERE request_id = '${submitted.requestId}' AND revision_number = 1`,
  );
  const scoreId = randomUUID();
  await sql.unsafe(`
    INSERT INTO rice_scores
      (id, request_id, version, reach, reach_unit, reach_period, reach_rationale, reach_actor_id,
       impact, impact_rationale, impact_actor_id,
       confidence, confidence_rationale, confidence_actor_id,
       effort, effort_rationale, effort_actor_id,
       score, rubric_version, formula_version, created_by_actor_id, origin)
    VALUES
      ('${scoreId}', '${submitted.requestId}', 1,
       100, 'staff', 'first year', 'probe', '${persona.id}',
       2, 'probe', '${persona.id}',
       0.5, 'probe', '${persona.id}',
       4, 'probe', '${persona.id}',
       25, 'rubric-v1', 'rice-v1', '${persona.id}', 'live')
  `);
  await sql.unsafe(
    `UPDATE requests SET current_rice_score_id = '${scoreId}'
     WHERE id = '${submitted.requestId}'`,
  );
  const draftIdForAssessment = draft.draftId;
  const assessmentId = randomUUID();
  await sql.unsafe(`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin, revision_id)
    VALUES
      ('${assessmentId}', '${draftIdForAssessment}', 'succeeded', 'probe', 'live', '${revisionOne.id}')
  `);

  await expectCode(
    "NOT_OWNER",
    () =>
      answerClarification(bella, {
        requestId: submitted.requestId,
        clarificationId: asked.clarificationId,
        answer: "not mine",
      }),
    "foreign answer",
  );

  const answered = await answerClarification(alice, {
    requestId: submitted.requestId,
    expectedRowVersion: withQuestion.rowVersion,
    clarificationId: asked.clarificationId,
    answer: "About four hundred staff members in the first year.",
    contentChanges: {
      affectedPeople: "About 400 Budget Office staff in the first year",
    },
  });
  assert.equal(answered.revisionNumber, 2, "answer appends revision 2");
  assert.equal(
    answered.stage,
    "under_review",
    "answer returns the request to review",
  );

  const record = await getRequestRecord(submitted.requestId);
  assert.equal(record.waitingOnRequester, false, "no longer waiting");
  assert.equal(record.currentRiceScoreId, null, "current RICE invalidated");
  assert.equal(record.revisions.length, 2);
  assert.equal(
    record.content.affectedPeople,
    "About 400 Budget Office staff in the first year",
    "request content refreshed from the answer",
  );
  const assessment = record.assetAssessments.find(
    (row) => row.id === assessmentId,
  );
  assert.equal(
    assessment?.needsReassessment,
    true,
    "revision-1 assessment is historical after the answer",
  );
  const [scoreSurvives] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM rice_scores WHERE id = '${scoreId}'`,
  );
  assert.equal(Number(scoreSurvives.total), 1, "score history is preserved");

  await expectCode(
    "NO_OPEN_CLARIFICATION",
    () =>
      answerClarification(alice, {
        requestId: submitted.requestId,
        expectedRowVersion: answered.rowVersion,
        clarificationId: asked.clarificationId,
        answer: "answering twice",
      }),
    "answer after answered",
  );

  // Revisions are immutable at the database level.
  let revisionUpdate: string | undefined;
  try {
    await sql.unsafe(
      `UPDATE request_content_revisions SET content = '{}' WHERE id = '${revisionOne.id}'`,
    );
  } catch (error) {
    revisionUpdate = (error as { code?: string }).code;
  }
  assert.equal(revisionUpdate, "55000", "revision update rejected");

  // A fixture request without an owner can still be asked; the lazy first
  // revision snapshots its content.
  const [fixtureRequest] = await sql.unsafe<
    { id: string; row_version: number }[]
  >(
    `SELECT r.id, r.row_version FROM requests r
     WHERE r.fixture_key IS NOT NULL AND r.stage = 'under_review'
       AND NOT EXISTS (
         SELECT 1 FROM clarification_requests c
         WHERE c.request_id = r.id AND c.answered_at IS NULL
       )
     LIMIT 1`,
  );
  assert.ok(fixtureRequest, "an askable fixture request exists");
  const fixtureAsk = await askClarification(reviewer, {
    requestId: fixtureRequest.id,
    question: "Which office owns the data feed?",
    expectedRowVersion: Number(fixtureRequest.row_version),
  });
  assert.ok(fixtureAsk.clarificationId);
  const [fixtureRevisions] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM request_content_revisions
     WHERE request_id = '${fixtureRequest.id}'`,
  );
  assert.ok(
    Number(fixtureRevisions.total) >= 1,
    "lazy revision exists for the fixture request",
  );

  const [completedFixture] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM requests
     WHERE fixture_key IS NOT NULL AND stage = 'first_review_completed' LIMIT 1`,
  );
  await expectCode(
    "INVALID_STATE",
    () =>
      askClarification(reviewer, {
        requestId: completedFixture.id,
        question: "Too late to ask",
      }),
    "ask after first review completed",
  );

  console.log(
    [
      "Workflow slice checks passed:",
      "  visitors, drafts, ownership, and version conflicts behave",
      "  submission is atomic and idempotent with exactly-once side effects",
      "  clarification asks wait, answers revise, and invalidate assessments/RICE",
      "  stable error codes verified for every failure path",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
