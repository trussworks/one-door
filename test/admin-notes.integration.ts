// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import {
  addAdministratorNote,
  createVisitor,
  saveDraft,
  submitRequest,
  WorkflowError,
  type ActorContext,
} from "../src/workflow/index.ts";
import { dashboardView } from "../src/server/dashboard.ts";
import { requestView } from "../src/server/request-views.ts";

const runFile = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "DATABASE_URL is not set. Point it at an isolated database this check may write to.",
  );
if (!new URL(url).pathname.startsWith("/one_door_admin_notes"))
  throw new Error(
    "Admin-note checks commit records; point DATABASE_URL at a fresh one_door_admin_notes_* database.",
  );
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function runScript(name: string): Promise<void> {
  const script = fileURLToPath(new URL(`scripts/${name}`, repoRoot));
  await runFile(process.execPath, ["--experimental-strip-types", script], {
    cwd: fileURLToPath(repoRoot),
    env: { ...process.env, DATABASE_URL: url },
  });
}

function admin(visitor: { visitorId: string; actorId: string }): ActorContext {
  return {
    actorId: visitor.actorId,
    visitorId: visitor.visitorId,
    actingView: "administrator",
  };
}

async function rejectsWith(
  action: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof WorkflowError && error.code === code,
    message,
  );
}

async function noteCount(requestId: string): Promise<number> {
  const [row] = await sql.unsafe<{ count: string }[]>(
    `SELECT count(*)::text AS count FROM audit_events
     WHERE event_type = 'administrator_note' AND subject_id = '${requestId}'`,
  );
  return Number(row.count);
}

// The administrator list exposes a next owner and task on a completed review
// and leaves them blank before review.
async function checkAdminListOwners(): Promise<string> {
  const dashboard = await dashboardView();
  const approved = dashboard.requests.find(
    (row) => row.stage === "first_review_completed",
  );
  assert.ok(approved, "a seeded completed-review request exists");
  assert.ok(approved.deliveryOwnerActorId, "completed review names an owner");
  assert.ok(
    approved.deliveryOwnerName && approved.deliveryOwnerName.length > 0,
    "delivery owner resolves to a display name",
  );
  assert.ok(
    approved.nextTask?.startsWith("Verify: "),
    "next task derives from the first acceptance criterion",
  );
  assert.ok(
    approved.nextOwner?.includes(" — "),
    "legacy next-owner text pairs owner and task",
  );
  const preReview = dashboard.requests.find((row) => row.stage === "submitted");
  assert.ok(preReview, "a seeded pre-review request exists");
  assert.equal(preReview.deliveryOwnerActorId, null, "no owner before review");
  assert.equal(preReview.nextTask, null, "no task before review");
  assert.equal(preReview.nextOwner, null, "no owner text before review");
  return approved.requestId;
}

// A note is stored, attributed, retry-safe, and conflict-checked; validation
// rejects empty and over-long bodies; the reviewer view carries the note.
async function checkNoteWorkflow(requestId: string): Promise<void> {
  const adminVisitor = await createVisitor({ displayName: "Ada Admin" });
  const administrator = admin(adminVisitor);
  const noteId = randomUUID();
  const trimmed = "Confirm the delivery lead has the rosters.";
  const body = `  ${trimmed}  `;
  const created = await addAdministratorNote(administrator, {
    requestId,
    noteId,
    body,
  });
  assert.equal(created.id, noteId, "note keeps its client id");
  assert.equal(created.body, trimmed, "note body is trimmed");
  assert.equal(created.authorName, "Ada Admin", "note records its author");
  const retried = await addAdministratorNote(administrator, {
    requestId,
    noteId,
    body,
  });
  assert.equal(retried.id, noteId, "retry returns the same note");
  assert.equal(await noteCount(requestId), 1, "retry adds no duplicate");
  await rejectsWith(
    () =>
      addAdministratorNote(administrator, {
        requestId,
        noteId,
        body: "A different note under the same id.",
      }),
    "VERSION_CONFLICT",
    "a reused id with a new body conflicts",
  );
  await rejectsWith(
    () =>
      addAdministratorNote(administrator, {
        requestId,
        noteId: randomUUID(),
        body: "   ",
      }),
    "VALIDATION_FAILED",
    "an empty note is rejected",
  );
  await rejectsWith(
    () =>
      addAdministratorNote(administrator, {
        requestId,
        noteId: randomUUID(),
        body: "x".repeat(2001),
      }),
    "VALIDATION_FAILED",
    "an over-long note is rejected",
  );
  await rejectsWith(
    () =>
      addAdministratorNote(administrator, {
        requestId: randomUUID(),
        noteId: randomUUID(),
        body: "Note for a missing request.",
      }),
    "NOT_FOUND",
    "a note needs an existing request",
  );
  const reviewerView = await requestView(adminVisitor, requestId, false);
  assert.equal(
    reviewerView.administratorNotes.length,
    1,
    "the reviewer view shows the note",
  );
  assert.equal(
    reviewerView.administratorNotes[0].body,
    trimmed,
    "the reviewer view shows the note body",
  );
}

// The requester's own view never receives administrator notes; an internal
// viewer sees the same note on the same request.
async function checkNoteVisibility(): Promise<void> {
  const adminVisitor = await createVisitor({ displayName: "Otto Admin" });
  const administrator = admin(adminVisitor);
  const [org] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations LIMIT 1`,
  );
  const requester = await createVisitor({ displayName: "Rae Requester" });
  const draft = await saveDraft(requester, {
    organizationId: org.id,
    rawNeed: "Need for the note-visibility journey.",
    content: {
      title: "Note visibility " + randomUUID().slice(0, 8),
      problem: "The office needs visible request progress.",
      affectedPeople: "Office staff",
      acceptanceCriteria: ["Progress is visible"],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready",
  });
  const ownRequest = await submitRequest(requester, {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  await addAdministratorNote(administrator, {
    requestId: ownRequest.requestId,
    noteId: randomUUID(),
    body: "Internal only, never shown to the requester.",
  });
  const ownerView = await requestView(requester, ownRequest.requestId, true);
  assert.equal(
    ownerView.administratorNotes.length,
    0,
    "the requester's own view hides administrator notes",
  );
  const internalView = await requestView(
    adminVisitor,
    ownRequest.requestId,
    false,
  );
  assert.equal(
    internalView.administratorNotes.length,
    1,
    "an internal viewer sees the note on the same request",
  );
}

async function main(): Promise<void> {
  await runScript("db-migrate.ts");
  await runScript("db-seed.ts");
  const requestId = await checkAdminListOwners();
  await checkNoteWorkflow(requestId);
  await checkNoteVisibility();
  console.log("admin-notes integration checks passed");
}

await main();
await sql.end();
