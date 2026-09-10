import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import {
  deliveryHandoffs,
  externalWorkItems,
  requestResolutions,
  requests,
  requestWorkItemLinks,
  taskCompletions,
  workSystems,
} from "../db/schema.ts";
import { WorkflowError } from "./errors.ts";
import {
  insertAudit,
  isUniqueViolation,
  lockRequest,
  newId,
  nowIso,
  parseInput,
  ratingSchema,
  requireVersion,
  requireUnresolved,
  uuidSchema,
  withDb,
  withReadSnapshot,
  type ActorContext,
  type Tx,
} from "./shared.ts";
import {
  approvalBlockers,
  ensureReviewTasks,
  resolveDeliveryOwner,
  type DeliveryOwnerFields,
} from "./review.ts";

const workEntry = z.object({
  title: z.string().trim().min(1).max(160),
  relationship: z.enum(["required", "supporting"]),
});

export const completeSchema = z.object({
  requestId: uuidSchema,
  rating: ratingSchema,
  idempotencyKey: z.string().trim().min(8).max(120),
  nextOwner: z.string().trim().min(1).max(160).optional(),
  deliveryOwnerActorId: z.string().uuid().optional(),
  nextTask: z.string().trim().min(1).max(2000).optional(),
  targetSystem: z.enum(["servicenow", "azure_devops"]),
  workPlan: z.array(workEntry).max(10).default([]),
  expectedRowVersion: z.number().int().positive().optional(),
});

async function existingCompletion(
  tx: Tx,
  request: { id: string; fixtureGeneration: number },
) {
  const [row] = await tx
    .select()
    .from(taskCompletions)
    .where(
      and(
        eq(taskCompletions.requestId, request.id),
        eq(taskCompletions.taskType, "contributor_first_review"),
        eq(taskCompletions.requestGeneration, request.fixtureGeneration),
      ),
    )
    .limit(1);
  return row;
}

/** The current generation's handoff; earlier generations are evidence. */
async function currentHandoff(
  tx: Tx,
  request: { id: string; fixtureGeneration: number },
) {
  const [row] = await tx
    .select()
    .from(deliveryHandoffs)
    .where(
      and(
        eq(deliveryHandoffs.requestId, request.id),
        eq(deliveryHandoffs.requestGeneration, request.fixtureGeneration),
      ),
    )
    .limit(1);
  return row;
}

function completionSummary(
  requestId: string,
  handoffId: string | null,
  rowVersion: number,
) {
  return {
    requestId,
    stage: "first_review_completed" as const,
    handoffId,
    rowVersion,
  };
}

type CompleteInput = z.infer<typeof completeSchema>;
type RequestRow = typeof requests.$inferSelect;

export async function completeFirstReviewInTx(
  tx: Tx,
  ctx: ActorContext,
  input: unknown,
) {
  const data = parseInput(completeSchema, input);
  if (!ctx.visitorId)
    throw new WorkflowError("VALIDATION_FAILED", "visitorId required");
  const request = await lockRequest(tx, data.requestId);
  if (request.stage === "first_review_completed") {
    const replay = await completedReplay(tx, request, data.idempotencyKey);
    if (replay) return replay;
    throw new WorkflowError("INVALID_STATE", "milestone already recorded");
  }
  requireVersion(data.expectedRowVersion, request.rowVersion);
  const owner = await requireApprovable(tx, request, data);
  return recordCompletion(tx, ctx, { request, data, owner });
}

/** The recorded result, when this idempotency key made the milestone. */
async function completedReplay(
  tx: Tx,
  request: RequestRow,
  idempotencyKey: string,
) {
  const existing = await existingCompletion(tx, request);
  if (existing?.idempotencyKey !== idempotencyKey) return null;
  const handoff = await currentHandoff(tx, request);
  return completionSummary(request.id, handoff?.id ?? null, request.rowVersion);
}

/** Approval gate: not resolved, no blockers, and a next owner on record. */
async function requireApprovable(
  tx: Tx,
  request: RequestRow,
  data: CompleteInput,
): Promise<DeliveryOwnerFields> {
  await requireUnresolved(tx, request);
  const blockers = await approvalBlockers(tx, request);
  // Input wins over the stored owner; a stored structured pair is reused
  // as-is so a bare completion keeps it.
  const owner = (await resolveDeliveryOwner(tx, data)) ?? storedOwner(request);
  if (!owner) blockers.push("NEXT_OWNER_MISSING");
  if (blockers.length > 0 || !owner)
    throw new WorkflowError("APPROVAL_BLOCKED", blockers.join(","));
  return owner;
}

function storedOwner(request: RequestRow): DeliveryOwnerFields | null {
  if (!request.nextOwner) return null;
  return {
    nextOwner: request.nextOwner,
    deliveryOwnerActorId: request.deliveryOwnerActorId ?? null,
    nextTask: request.nextTask ?? null,
  };
}

async function recordCompletion(
  tx: Tx,
  ctx: ActorContext,
  args: {
    request: RequestRow;
    data: CompleteInput;
    owner: DeliveryOwnerFields;
  },
) {
  const { request, data, owner } = args;
  const { nextOwner } = owner;
  const completedAt = nowIso();
  await tx.insert(taskCompletions).values({
    id: newId(),
    requestId: request.id,
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    taskType: "contributor_first_review",
    actingView: "contributor",
    rating: data.rating,
    origin: "live",
    idempotencyKey: data.idempotencyKey,
    requestGeneration: request.fixtureGeneration,
  });

  const handoffId = newId();
  await tx.insert(deliveryHandoffs).values({
    id: handoffId,
    requestId: request.id,
    targetSystem: data.targetSystem,
    nextOwner,
    workPlan: data.workPlan,
    retryKey: newId(),
    status: "intended",
    requestGeneration: request.fixtureGeneration,
  });

  await ensureReviewTasks(tx, request.id);
  await tx
    .update(requests)
    .set({
      stage: "first_review_completed",
      firstReviewCompletedAt: completedAt,
      nextOwner,
      deliveryOwnerActorId: owner.deliveryOwnerActorId,
      nextTask: owner.nextTask,
      rowVersion: request.rowVersion + 1,
      updatedAt: completedAt,
    })
    .where(eq(requests.id, request.id));

  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType: "first_review_completed",
    subjectId: request.id,
    payload: {
      handoffId,
      targetSystem: data.targetSystem,
      workPlanCount: data.workPlan.length,
    },
  });
  return completionSummary(request.id, handoffId, request.rowVersion + 1);
}

/**
 * Complete first review: approval, the required contributor rating, and the
 * delivery handoff intent commit together. The milestone is global per
 * request — a second completion attempt fails whoever attempts it.
 */
export async function completeFirstReview(ctx: ActorContext, input: unknown) {
  const data = parseInput(completeSchema, input);
  // Live completions must trace to a browser session (task_completions
  // requires visitor_id when origin = 'live').
  if (!ctx.visitorId)
    throw new WorkflowError("VALIDATION_FAILED", "visitorId required");
  return withDb(async (db) => {
    try {
      return await db.transaction((tx) =>
        completeFirstReviewInTx(tx, ctx, data),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent completion won the milestone. The same idempotency key
      // replays that result; a different caller gets a stable failure.
      const replay = await db.transaction(async (tx) => {
        const request = await lockRequest(tx, data.requestId);
        return completedReplay(tx, request, data.idempotencyKey);
      });
      if (replay) return replay;
      throw new WorkflowError("INVALID_STATE", "milestone already recorded");
    }
  });
}

const handoffSchema = z.object({
  requestId: uuidSchema,
  simulateFailure: z.boolean().default(false),
});

/**
 * Execute the simulated LOCAL delivery handoff: create or link local work
 * records and confirm them. Idempotent by retry key; a failure is durable and
 * retryable. Nothing here writes to a real tenant.
 */
export async function executeHandoff(ctx: ActorContext, input: unknown) {
  const data = parseInput(handoffSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockRequest(tx, data.requestId);
      const [handoff] = await tx
        .select()
        .from(deliveryHandoffs)
        .where(
          and(
            eq(deliveryHandoffs.requestId, request.id),
            eq(deliveryHandoffs.requestGeneration, request.fixtureGeneration),
          ),
        )
        .limit(1)
        .for("update");
      if (!handoff) throw new WorkflowError("NOT_FOUND", "handoff");
      if (handoff.status === "confirmed")
        return handoffResult(tx, request.id, handoff, "confirmed");
      await requireUnresolved(tx, request);

      if (data.simulateFailure)
        return markHandoffFailed(tx, ctx, request.id, handoff);

      await createPlanItems(tx, request.id, handoff);
      await tx
        .update(deliveryHandoffs)
        .set({
          status: "confirmed",
          confirmedAt: nowIso(),
          sanitizedError: null,
          rowVersion: handoff.rowVersion + 1,
        })
        .where(eq(deliveryHandoffs.id, handoff.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "handoff_confirmed",
        subjectId: request.id,
        payload: { handoffId: handoff.id, itemCount: handoff.workPlan.length },
      });
      return handoffResult(tx, request.id, handoff, "confirmed");
    }),
  );
}

type HandoffRow = typeof deliveryHandoffs.$inferSelect;

async function markHandoffFailed(
  tx: Tx,
  ctx: ActorContext,
  requestId: string,
  handoff: HandoffRow,
) {
  await tx
    .update(deliveryHandoffs)
    .set({
      status: "failed",
      sanitizedError: "simulated_delivery_failure",
      rowVersion: handoff.rowVersion + 1,
    })
    .where(eq(deliveryHandoffs.id, handoff.id));
  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType: "handoff_failed",
    subjectId: requestId,
    payload: { handoffId: handoff.id, simulated: true },
  });
  // The failed status must commit so a later attempt can retry it.
  return handoffResult(tx, requestId, handoff, "failed");
}

/**
 * Deterministic SIM- ids make item creation idempotent across retries. The
 * full retry key is the identity — a truncated key could collide and link
 * another handoff's work.
 */
async function createPlanItems(
  tx: Tx,
  requestId: string,
  handoff: HandoffRow,
): Promise<void> {
  for (const [index, entry] of handoff.workPlan.entries()) {
    const externalId = `SIM-${handoff.retryKey}-${index + 1}`;
    await tx
      .insert(externalWorkItems)
      .values({
        id: newId(),
        system: handoff.targetSystem,
        externalId,
        title: entry.title,
        sourceStatus: "open",
        sourceOwner: handoff.nextOwner,
        sourceUrl: `simulated:${handoff.targetSystem}/${externalId}`,
        sourceUpdatedAt: nowIso(),
        lastSynchronizedAt: nowIso(),
        syncHealth: "current",
      })
      .onConflictDoNothing();
    const [item] = await tx
      .select({ id: externalWorkItems.id })
      .from(externalWorkItems)
      .where(
        and(
          eq(externalWorkItems.system, handoff.targetSystem),
          eq(externalWorkItems.externalId, externalId),
        ),
      )
      .limit(1);
    await tx
      .insert(requestWorkItemLinks)
      .values({
        requestId,
        workItemId: item.id,
        relationship: entry.relationship,
        handoffId: handoff.id,
        requestGeneration: handoff.requestGeneration,
      })
      .onConflictDoNothing();
  }
}

/**
 * The single derived-health rule: a stored 'current' flag expires once the
 * item's last synchronization falls outside the system's freshness
 * interval. Failed and stale flags stand on their own.
 */
export function deriveWorkItemHealth(
  item: {
    syncHealth: "current" | "stale" | "failed";
    lastSynchronizedAt: string;
  },
  expectedFreshnessHours: number,
  nowMs: number,
): "current" | "stale" | "failed" {
  if (item.syncHealth !== "current") return item.syncHealth;
  const ageMs = nowMs - Date.parse(item.lastSynchronizedAt);
  return ageMs > expectedFreshnessHours * 3_600_000 ? "stale" : "current";
}

async function handoffResult(
  tx: Tx,
  requestId: string,
  handoff: HandoffRow,
  status: string,
) {
  const links = await linkedWork(tx, requestId, handoff.requestGeneration);
  return { requestId, handoffId: handoff.id, status, links };
}

/**
 * Links current for one generation, each with its derived source health.
 * Baseline fixture links are reference evidence like fixture assessments: a
 * reset that restores the scenario keeps them current at any generation,
 * while participant-created links stay bound to the generation that made
 * them.
 */
async function linkedWork(tx: Tx, requestId: string, generation: number) {
  const rows = await tx
    .select({
      workItemId: requestWorkItemLinks.workItemId,
      relationship: requestWorkItemLinks.relationship,
      handoffId: requestWorkItemLinks.handoffId,
      requestGeneration: requestWorkItemLinks.requestGeneration,
      fixtureKey: requestWorkItemLinks.fixtureKey,
      externalId: externalWorkItems.externalId,
      system: externalWorkItems.system,
      sourceStatus: externalWorkItems.sourceStatus,
      syncHealth: externalWorkItems.syncHealth,
      lastSynchronizedAt: externalWorkItems.lastSynchronizedAt,
      closedAt: externalWorkItems.closedAt,
      expectedFreshnessHours: workSystems.expectedFreshnessHours,
    })
    .from(requestWorkItemLinks)
    .innerJoin(
      externalWorkItems,
      eq(externalWorkItems.id, requestWorkItemLinks.workItemId),
    )
    .innerJoin(workSystems, eq(workSystems.system, externalWorkItems.system))
    .where(
      and(
        eq(requestWorkItemLinks.requestId, requestId),
        or(
          eq(requestWorkItemLinks.requestGeneration, generation),
          isNotNull(requestWorkItemLinks.fixtureKey),
        ),
      ),
    )
    .orderBy(asc(externalWorkItems.externalId));
  const nowMs = Date.now();
  return rows.map((row) => ({
    ...row,
    derivedHealth: deriveWorkItemHealth(row, row.expectedFreshnessHours, nowMs),
  }));
}

const linkSchema = z.object({
  requestId: uuidSchema,
  workItemId: uuidSchema,
  relationship: z.enum(["required", "supporting"]),
  expectedRowVersion: z.number().int().positive().optional(),
});

/**
 * Link an existing local work item to a request at its current generation.
 * The item is reused, never re-created; a required link joins the
 * fulfillment gate immediately.
 */
export async function linkWorkItem(ctx: ActorContext, input: unknown) {
  const data = parseInput(linkSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockRequest(tx, data.requestId);
      await requireUnresolved(tx, request);
      requireVersion(data.expectedRowVersion, request.rowVersion);
      const [item] = await tx
        .select({ id: externalWorkItems.id })
        .from(externalWorkItems)
        .where(eq(externalWorkItems.id, data.workItemId))
        .limit(1);
      if (!item) throw new WorkflowError("NOT_FOUND", "work item");
      const [existing] = await tx
        .select({ requestId: requestWorkItemLinks.requestId })
        .from(requestWorkItemLinks)
        .where(
          and(
            eq(requestWorkItemLinks.requestId, request.id),
            eq(requestWorkItemLinks.workItemId, item.id),
            eq(
              requestWorkItemLinks.requestGeneration,
              request.fixtureGeneration,
            ),
          ),
        )
        .limit(1);
      if (existing)
        throw new WorkflowError("INVALID_STATE", "work item already linked");
      await tx.insert(requestWorkItemLinks).values({
        requestId: request.id,
        workItemId: item.id,
        relationship: data.relationship,
        handoffId: null,
        requestGeneration: request.fixtureGeneration,
      });
      await tx
        .update(requests)
        .set({ rowVersion: request.rowVersion + 1, updatedAt: nowIso() })
        .where(eq(requests.id, request.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "work_item_linked",
        subjectId: request.id,
        payload: { workItemId: item.id, relationship: data.relationship },
      });
      return {
        requestId: request.id,
        workItemId: item.id,
        relationship: data.relationship,
        rowVersion: request.rowVersion + 1,
      };
    }),
  );
}

const statusSchema = z.object({
  workItemId: uuidSchema,
  sourceStatus: z.string().trim().min(1).max(80),
  closed: z.boolean().optional(),
  syncHealth: z.enum(["current", "stale", "failed"]).optional(),
});

/**
 * Advance a simulated delivery item through the shared status path. Only
 * locally simulated records may change; fixture and imported rows stay
 * untouched by this action.
 */
export async function updateWorkItemStatus(ctx: ActorContext, input: unknown) {
  const data = parseInput(statusSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(externalWorkItems)
        .where(eq(externalWorkItems.id, data.workItemId))
        .limit(1)
        .for("update");
      if (!item) throw new WorkflowError("NOT_FOUND", "work item");
      // Simulation stays local: handoff-created SIM records and seeded
      // fixture records may be progressed here; a record imported from a
      // real source is refused so no tenant state is ever shadowed.
      if (!item.externalId.startsWith("SIM-") && item.fixtureKey === null)
        throw new WorkflowError(
          "INVALID_STATE",
          "only simulated or fixture records accept demo status updates",
        );
      const values = simulatedStatusValues(item, data, nowIso());
      await tx
        .update(externalWorkItems)
        .set(values)
        .where(eq(externalWorkItems.id, item.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "work_item_status_updated",
        subjectType: "work_item",
        subjectId: data.workItemId,
        payload: {
          sourceStatus: values.sourceStatus,
          closed: values.closedAt !== null,
          syncHealth: values.syncHealth,
        },
      });
      return {
        workItemId: item.id,
        sourceStatus: values.sourceStatus,
        syncHealth: values.syncHealth,
      };
    }),
  );
}

export function simulatedClosure(
  previous: string | null,
  closed: boolean | undefined,
  now: string,
) {
  if (closed === false) return null;
  return closed === true ? (previous ?? now) : previous;
}

const resolveSchema = z.object({
  requestId: uuidSchema,
  outcome: z.enum([
    "fulfilled_reuse",
    "fulfilled_new",
    "fulfilled_mixed",
    "closed_without_fulfillment",
  ]),
  summary: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(2000).optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

type ResolutionBlocker =
  | "NOT_COMPLETED"
  | "HANDOFF_NOT_CONFIRMED"
  | "REQUIRED_WORK_OPEN"
  | "STALE_SOURCE";

async function resolutionBlockers(
  tx: Tx,
  request: typeof requests.$inferSelect,
  outcome: string,
): Promise<ResolutionBlocker[]> {
  // Closing without fulfillment is the withdrawal path; it stays available at
  // every stage. Fulfillment outcomes require the completed review milestone.
  if (outcome === "closed_without_fulfillment") return [];
  const blockers: ResolutionBlocker[] = [];
  if (request.stage !== "first_review_completed")
    blockers.push("NOT_COMPLETED");

  const handoff = await currentHandoff(tx, request);
  if (handoff?.status !== "confirmed") blockers.push("HANDOFF_NOT_CONFIRMED");

  // Only current-generation links are open work; earlier generations are
  // evidence. Health is derived, so a 'current' flag that outlived its
  // system's freshness interval still blocks fulfillment.
  const links = await linkedWork(tx, request.id, request.fixtureGeneration);
  const required = links.filter((link) => link.relationship === "required");
  if (required.some((link) => link.closedAt === null))
    blockers.push("REQUIRED_WORK_OPEN");
  if (required.some((link) => link.derivedHealth !== "current"))
    blockers.push("STALE_SOURCE");
  return blockers;
}

/**
 * The coordinator records the final human outcome. Fulfillment requires a
 * confirmed handoff and every required delivery item closed on current data;
 * closure without fulfillment requires a reason. Resolution happens once.
 */
export async function resolveRequest(ctx: ActorContext, input: unknown) {
  const data = parseInput(resolveSchema, input);
  if (data.outcome === "closed_without_fulfillment" && !data.reason)
    throw new WorkflowError("VALIDATION_FAILED", "closure needs a reason");

  return withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockRequest(tx, data.requestId);
      requireVersion(data.expectedRowVersion, request.rowVersion);
      const [existing] = await tx
        .select({ id: requestResolutions.id })
        .from(requestResolutions)
        .where(
          and(
            eq(requestResolutions.requestId, request.id),
            eq(requestResolutions.requestGeneration, request.fixtureGeneration),
          ),
        )
        .limit(1);
      if (existing)
        throw new WorkflowError("INVALID_STATE", "already resolved");

      const blockers = await resolutionBlockers(tx, request, data.outcome);
      if (blockers.length > 0)
        throw new WorkflowError("RESOLUTION_BLOCKED", blockers.join(","));

      const resolutionId = newId();
      await tx.insert(requestResolutions).values({
        id: resolutionId,
        requestId: request.id,
        outcome: data.outcome,
        summary: data.summary,
        reason: data.reason ?? null,
        resolvedByActorId: ctx.actorId,
        requestGeneration: request.fixtureGeneration,
      });
      await tx
        .update(requests)
        .set({ rowVersion: request.rowVersion + 1, updatedAt: nowIso() })
        .where(eq(requests.id, request.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "request_resolved",
        subjectId: request.id,
        payload: { outcome: data.outcome },
      });
      return {
        requestId: request.id,
        resolutionId,
        outcome: data.outcome,
        rowVersion: request.rowVersion + 1,
      };
    }),
  );
}

/** Links from other generations: preserved delivery evidence, not open work. */
async function historicalLinkRows(
  db: Tx,
  requestId: string,
  generation: number,
) {
  return db
    .select({
      workItemId: requestWorkItemLinks.workItemId,
      relationship: requestWorkItemLinks.relationship,
      handoffId: requestWorkItemLinks.handoffId,
      requestGeneration: requestWorkItemLinks.requestGeneration,
      externalId: externalWorkItems.externalId,
      system: externalWorkItems.system,
      sourceStatus: externalWorkItems.sourceStatus,
      closedAt: externalWorkItems.closedAt,
    })
    .from(requestWorkItemLinks)
    .innerJoin(
      externalWorkItems,
      eq(externalWorkItems.id, requestWorkItemLinks.workItemId),
    )
    .where(
      and(
        eq(requestWorkItemLinks.requestId, requestId),
        ne(requestWorkItemLinks.requestGeneration, generation),
        isNull(requestWorkItemLinks.fixtureKey),
      ),
    )
    .orderBy(
      asc(requestWorkItemLinks.requestGeneration),
      asc(externalWorkItems.externalId),
    );
}

/** Internal read: handoff, linked work with required flags, and resolution. */
export async function getDeliveryState(requestIdInput: unknown, reader?: Tx) {
  const requestId = parseInput(uuidSchema, requestIdInput);
  return withReadSnapshot(async (db) => {
    const [request] = await db
      .select({
        id: requests.id,
        stage: requests.stage,
        fixtureGeneration: requests.fixtureGeneration,
      })
      .from(requests)
      .where(eq(requests.id, requestId))
      .limit(1);
    if (!request) throw new WorkflowError("NOT_FOUND", "request");
    const [handoff] = await db
      .select()
      .from(deliveryHandoffs)
      .where(
        and(
          eq(deliveryHandoffs.requestId, requestId),
          eq(deliveryHandoffs.requestGeneration, request.fixtureGeneration),
        ),
      )
      .limit(1);
    const [resolution] = await db
      .select()
      .from(requestResolutions)
      .where(
        and(
          eq(requestResolutions.requestId, requestId),
          eq(requestResolutions.requestGeneration, request.fixtureGeneration),
        ),
      )
      .limit(1);
    const links = await linkedWork(db, requestId, request.fixtureGeneration);
    const historicalLinks = await historicalLinkRows(
      db,
      requestId,
      request.fixtureGeneration,
    );
    return {
      requestId,
      stage: request.stage,
      handoff: handoff
        ? {
            handoffId: handoff.id,
            status: handoff.status,
            targetSystem: handoff.targetSystem,
            nextOwner: handoff.nextOwner,
            workPlan: handoff.workPlan,
            sanitizedError: handoff.sanitizedError,
            confirmedAt: handoff.confirmedAt,
          }
        : null,
      links,
      historicalLinks,
      resolution: resolution
        ? {
            resolutionId: resolution.id,
            outcome: resolution.outcome,
            summary: resolution.summary,
            reason: resolution.reason,
            resolvedByActorId: resolution.resolvedByActorId,
            createdAt: resolution.createdAt,
          }
        : null,
    };
  }, reader);
}

export function simulatedStatusValues(
  item: typeof externalWorkItems.$inferSelect,
  data: z.infer<typeof statusSchema>,
  now: string,
) {
  const prior = {
    sourceStatus: item.sourceStatus,
    syncHealth: data.syncHealth ?? item.syncHealth,
    closedAt: item.closedAt,
    sourceUpdatedAt: item.sourceUpdatedAt,
    lastSynchronizedAt: item.lastSynchronizedAt,
  };
  if (prior.syncHealth !== "current") return prior;
  return {
    ...prior,
    sourceStatus: data.sourceStatus,
    closedAt: simulatedClosure(item.closedAt, data.closed, now),
    sourceUpdatedAt: now,
    lastSynchronizedAt: now,
  };
}
