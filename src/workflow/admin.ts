import { eq } from "drizzle-orm";
import { z } from "zod";

import { actors, auditEvents, requests } from "../db/schema.ts";
import { administratorNoteEvent } from "../domain/constants.ts";
import { importArchitectureFixture } from "../seed/fixture-import.ts";
import { resetFixtureState } from "../seed/fixture-reset.ts";
import { WorkflowError } from "./errors.ts";
import {
  parseInput,
  requireActor,
  uuidSchema,
  withDb,
  type ActorContext,
  type Db,
  type Tx,
} from "./shared.ts";

/**
 * Restore the shared fixture-derived state. Same transaction logic as
 * scripts/db-reset-fixtures.ts; the trusted administrator context replaces
 * the CLI confirmation flag.
 */
export async function resetFixtures(ctx: ActorContext) {
  return withDb(async (db) => {
    await requireActor(db, ctx.actorId);
    return resetFixtureState(db, ctx);
  });
}

/**
 * Apply the architecture fixture import, the same run the CLI performs.
 * Returns whether anything changed; a matching prior import is a no-op.
 */
export async function importFixture(ctx: ActorContext) {
  return withDb(async (db) => {
    await requireActor(db, ctx.actorId);
    const imported = await importArchitectureFixture(db);
    return { imported };
  });
}

export interface AdministratorNote {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
}

const administratorNoteSchema = z.object({
  requestId: uuidSchema,
  noteId: uuidSchema,
  body: z.string().trim().min(1).max(2000),
});
type AdministratorNoteInput = z.infer<typeof administratorNoteSchema>;

// A note ID survives retries; conflicting content cannot replace the recorded note.
export async function addAdministratorNote(
  ctx: ActorContext,
  input: unknown,
): Promise<AdministratorNote> {
  const data = parseInput(administratorNoteSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const [request] = await tx
        .select({ id: requests.id })
        .from(requests)
        .where(eq(requests.id, data.requestId))
        .limit(1);
      if (!request) throw new WorkflowError("NOT_FOUND", "request");
      await tx
        .insert(auditEvents)
        .values({
          id: data.noteId,
          actorId: ctx.actorId,
          visitorId: ctx.visitorId ?? null,
          actingView: "administrator",
          eventType: administratorNoteEvent,
          subjectType: "request",
          subjectId: data.requestId,
          payload: { body: data.body },
          origin: "live",
        })
        .onConflictDoNothing({ target: auditEvents.id });
      const stored = await noteById(tx, data.noteId);
      if (!stored) throw new WorkflowError("NOT_FOUND", "note");
      return matchOrConflict(stored, ctx, data);
    }),
  );
}

interface StoredNote {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string | null;
  actorId: string | null;
  payload: Record<string, unknown>;
  authorName: string | null;
  createdAt: string;
}

async function noteById(db: Db | Tx, id: string): Promise<StoredNote | null> {
  const [row] = await db
    .select({
      id: auditEvents.id,
      eventType: auditEvents.eventType,
      subjectType: auditEvents.subjectType,
      subjectId: auditEvents.subjectId,
      actorId: auditEvents.actorId,
      payload: auditEvents.payload,
      authorName: actors.displayName,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .leftJoin(actors, eq(actors.id, auditEvents.actorId))
    .where(eq(auditEvents.id, id))
    .limit(1);
  return row ?? null;
}

function matchOrConflict(
  note: StoredNote,
  ctx: ActorContext,
  data: AdministratorNoteInput,
): AdministratorNote {
  const body = typeof note.payload.body === "string" ? note.payload.body : null;
  if (
    note.eventType !== administratorNoteEvent ||
    note.subjectType !== "request" ||
    note.subjectId !== data.requestId ||
    note.actorId !== ctx.actorId ||
    body !== data.body
  )
    throw new WorkflowError("VERSION_CONFLICT");
  return {
    id: note.id,
    authorName: note.authorName ?? "",
    body,
    createdAt: note.createdAt,
  };
}
