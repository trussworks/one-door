import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { createDatabase } from "../db/client.ts";
import {
  auditEvents,
  requestResolutions,
  requests,
  visitors,
} from "../db/schema.ts";
import type { ActingView, DataOrigin } from "../domain/constants.ts";
import { WorkflowError } from "./errors.ts";

/** The identity a Next handler resolves from the signed visitor cookie. */
export interface VisitorContext {
  visitorId: string;
}

/** The identity behind an internal (contributor/administrator) action. */
export interface ActorContext {
  actorId: string;
  actingView: Extract<ActingView, "contributor" | "administrator">;
  visitorId?: string;
}

export type Db = ReturnType<typeof createDatabase>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, sql } = createDatabase();
  try {
    return await fn(db);
  } finally {
    await sql.end();
  }
}

// Nested readers share the caller's snapshot so one response cannot mix database states.
export function withReadSnapshot<T>(
  fn: (tx: Tx) => Promise<T>,
  reader?: Tx,
): Promise<T> {
  if (reader) return fn(reader);
  return withDb((db) =>
    db.transaction(fn, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    }),
  );
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new WorkflowError(
      "VALIDATION_FAILED",
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.code}`)
        .join("; "),
    );
  }
  return result.data;
}

const line = (max: number) => z.string().trim().min(1).max(max);
const lines = (max: number) => z.array(line(500)).max(max);

export const requestContentSchema = z.object({
  title: line(200),
  problem: line(5000),
  affectedPeople: line(2000),
  acceptanceCriteria: lines(20).default([]),
  requirements: lines(30).default([]),
  constraints: lines(30).default([]),
  unknowns: lines(30).default([]),
});
export type RequestContent = z.infer<typeof requestContentSchema>;
export const partialContentSchema = z.object({
  title: z.string().max(200).optional(),
  problem: z.string().max(5000).optional(),
  affectedPeople: z.string().max(2000).optional(),
  acceptanceCriteria: z.array(z.string().max(500)).max(20).optional(),
  requirements: z.array(z.string().max(500)).max(30).optional(),
  constraints: z.array(z.string().max(500)).max(30).optional(),
  unknowns: z.array(z.string().max(500)).max(30).optional(),
});

export const uuidSchema = z.string().uuid();
export const ratingSchema = z.number().int().min(1).max(5);

export function requireVersion(expected: number | undefined, actual: number) {
  if (expected === undefined)
    throw new WorkflowError("VALIDATION_FAILED", "expectedRowVersion required");
  if (expected !== actual) throw new WorkflowError("VERSION_CONFLICT");
}

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function requireVisitor(db: Db | Tx, visitorId: string) {
  const [visitor] = await db
    .select({ id: visitors.id, actorId: visitors.actorId })
    .from(visitors)
    .where(eq(visitors.id, visitorId))
    .limit(1);
  if (!visitor) throw new WorkflowError("NOT_FOUND", "visitor");
  return visitor;
}

export function contentFromRequestRow(row: {
  title: string;
  problem: string;
  affectedPeople: string;
  acceptanceCriteria: string[];
  requirements: string[];
  constraints: string[];
  unknowns: string[];
}): RequestContent {
  return {
    title: row.title,
    problem: row.problem,
    affectedPeople: row.affectedPeople,
    acceptanceCriteria: row.acceptanceCriteria,
    requirements: row.requirements,
    constraints: row.constraints,
    unknowns: row.unknowns,
  };
}

export async function insertAudit(
  tx: Tx,
  event: {
    actorId: string | null;
    visitorId: string | null;
    actingView: ActingView | null;
    eventType: string;
    subjectType?: string;
    subjectId: string;
    payload: Record<string, unknown>;
    origin?: DataOrigin;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: newId(),
    actorId: event.actorId,
    visitorId: event.visitorId,
    actingView: event.actingView,
    eventType: event.eventType,
    subjectType: event.subjectType ?? "request",
    subjectId: event.subjectId,
    payload: event.payload,
    origin: event.origin ?? "live",
  });
}

export async function lockRequest(tx: Tx, requestId: string) {
  const [request] = await tx
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1)
    .for("update");
  if (!request) throw new WorkflowError("NOT_FOUND", "request");
  return request;
}

/**
 * Resolution is terminal per fixture generation: a preserved resolution from
 * before a fixture reset does not bind the restored scenario.
 */
export async function requireUnresolved(
  tx: Tx,
  request: { id: string; fixtureGeneration: number },
) {
  const [resolution] = await tx
    .select({ id: requestResolutions.id })
    .from(requestResolutions)
    .where(
      and(
        eq(requestResolutions.requestId, request.id),
        eq(requestResolutions.requestGeneration, request.fixtureGeneration),
      ),
    )
    .limit(1);
  if (resolution)
    throw new WorkflowError("INVALID_STATE", "request is resolved");
}

export async function lockUnresolvedRequest(tx: Tx, requestId: string) {
  const request = await lockRequest(tx, requestId);
  await requireUnresolved(tx, request);
  return request;
}

interface PgErrorShape {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  cause?: unknown;
}

/** Drizzle wraps driver errors; the SQLSTATE lives on the cause chain. */
function pgError(error: unknown): PgErrorShape | undefined {
  let candidate = error as PgErrorShape | undefined;
  for (let depth = 0; candidate && depth < 4; depth += 1) {
    if (candidate.code) return candidate;
    candidate = candidate.cause as PgErrorShape | undefined;
  }
  return undefined;
}

export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  const candidate = pgError(error);
  if (candidate?.code !== "23505") return false;
  if (!constraint) return true;
  const name = candidate.constraint_name ?? candidate.constraint ?? "";
  return name.includes(constraint);
}
