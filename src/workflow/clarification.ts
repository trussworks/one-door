import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  assetAssessments,
  clarificationRequests,
  requestContentRevisions,
  requests,
  reviewTasks,
  riskAssessments,
} from "../db/schema.ts";
import { enqueueJobInTx } from "../models/jobs.ts";
import { WorkflowError } from "./errors.ts";
import {
  contentFromRequestRow,
  insertAudit,
  isUniqueViolation,
  lockRequest,
  lockUnresolvedRequest,
  newId,
  nowIso,
  parseInput,
  partialContentSchema,
  requestContentSchema,
  requireActor,
  requireVisitor,
  requireUnresolved,
  requireVersion,
  uuidSchema,
  withDb,
  withReadSnapshot,
  type ActorContext,
  type Db,
  type Tx,
  type VisitorContext,
} from "./shared.ts";

async function nextRevisionNumber(tx: Tx, requestId: string): Promise<number> {
  const revisions = await tx
    .select({ revisionNumber: requestContentRevisions.revisionNumber })
    .from(requestContentRevisions)
    .where(eq(requestContentRevisions.requestId, requestId));
  return (
    revisions.reduce((max, row) => Math.max(max, row.revisionNumber), 0) + 1
  );
}

/**
 * Guarantee the request has an immutable content revision to cite. Fixture
 * requests predate revision tracking, and a fixture reset clears the
 * current-revision pointer while earlier revisions remain evidence, so the
 * snapshot always takes the next free revision number.
 */
async function ensureCurrentRevision(
  tx: Tx,
  request: typeof requests.$inferSelect,
): Promise<string> {
  if (request.currentRevisionId) return request.currentRevisionId;
  const revisionId = newId();
  await tx.insert(requestContentRevisions).values({
    id: revisionId,
    requestId: request.id,
    revisionNumber: await nextRevisionNumber(tx, request.id),
    content: contentFromRequestRow(request),
    source: "submission",
    authoredByActorId: request.requesterActorId,
    visitorId: request.ownerVisitorId,
  });
  await tx
    .update(requests)
    .set({ currentRevisionId: revisionId })
    .where(eq(requests.id, request.id));
  return revisionId;
}

const askSchema = z.object({
  requestId: uuidSchema,
  question: z.string().trim().min(1).max(2000),
  expectedRowVersion: z.number().int().positive().optional(),
});

/**
 * A reviewer asks the requester for more information. The unanswered row is
 * the waiting state; the partial unique index allows one open question per
 * request.
 */
export async function askClarification(ctx: ActorContext, input: unknown) {
  const data = parseInput(askSchema, input);

  return withDb(async (db) => {
    try {
      return await db.transaction(async (tx) => {
        await requireActor(tx, ctx.actorId);

        const request = await lockUnresolvedRequest(tx, data.requestId);
        if (request.stage === "first_review_completed")
          throw new WorkflowError("INVALID_STATE", "first review is complete");
        // Asking moves the request to waiting-on-requester, so it takes the
        // same optimistic guard and version bump as every state change.
        requireVersion(data.expectedRowVersion, request.rowVersion);

        const revisionId = await ensureCurrentRevision(tx, request);
        const clarificationId = newId();
        const [created] = await tx
          .insert(clarificationRequests)
          .values({
            id: clarificationId,
            requestId: request.id,
            revisionId,
            question: data.question,
            askedByActorId: ctx.actorId,
            requestGeneration: request.fixtureGeneration,
            origin: "live",
          })
          .returning();

        await tx
          .update(requests)
          .set({ rowVersion: request.rowVersion + 1, updatedAt: nowIso() })
          .where(eq(requests.id, request.id));
        await insertAudit(tx, {
          actorId: ctx.actorId,
          visitorId: ctx.visitorId ?? null,
          actingView: ctx.actingView,
          eventType: "clarification_asked",
          subjectId: request.id,
          payload: { clarificationId },
        });

        return {
          clarificationId: created.id,
          requestId: created.requestId,
          question: created.question,
          askedAt: created.askedAt,
          rowVersion: request.rowVersion + 1,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, "clarification_requests_one_open")) {
        throw new WorkflowError(
          "CLARIFICATION_PENDING",
          "an open question already exists for this request",
        );
      }
      throw error;
    }
  });
}

async function appendAnswerRevision(
  tx: Tx,
  request: typeof requests.$inferSelect,
  visitor: { id: string; actorId: string },
  merged: ReturnType<typeof contentFromRequestRow>,
): Promise<{ revisionId: string; nextNumber: number }> {
  const nextNumber = await nextRevisionNumber(tx, request.id);
  const revisionId = newId();
  await tx.insert(requestContentRevisions).values({
    id: revisionId,
    requestId: request.id,
    revisionNumber: nextNumber,
    content: merged,
    source: "clarification_answer",
    authoredByActorId: visitor.actorId,
    visitorId: visitor.id,
  });
  return { revisionId, nextNumber };
}

async function refreshRequestContent(
  tx: Tx,
  request: typeof requests.$inferSelect,
  merged: ReturnType<typeof contentFromRequestRow>,
  revisionId: string,
): Promise<typeof requests.$inferSelect> {
  const [updated] = await tx
    .update(requests)
    .set({
      title: merged.title,
      problem: merged.problem,
      affectedPeople: merged.affectedPeople,
      acceptanceCriteria: merged.acceptanceCriteria,
      requirements: merged.requirements,
      constraints: merged.constraints,
      unknowns: merged.unknowns,
      currentRevisionId: revisionId,
      currentRiceScoreId: null,
      selectedServiceCandidateId: null,
      routingState: "routing_requested",
      stage: "under_review",
      rowVersion: request.rowVersion + 1,
      updatedAt: nowIso(),
    })
    .where(eq(requests.id, request.id))
    .returning();
  await tx
    .update(reviewTasks)
    .set({
      state: "pending",
      completedAt: null,
      updatedAt: nowIso(),
    })
    .where(eq(reviewTasks.requestId, request.id));
  return updated;
}

/** Reassessment jobs for the new revision commit with the answer. */
async function enqueueReassessment(
  tx: Tx,
  visitorId: string,
  request: typeof requests.$inferSelect,
): Promise<void> {
  await enqueueJobInTx(tx, visitorId, {
    purpose: "asset_match",
    draftId: request.sourceDraftId,
    requestId: request.id,
  });
  await enqueueJobInTx(tx, visitorId, {
    purpose: "risk_assess",
    draftId: request.sourceDraftId,
    requestId: request.id,
  });
}

const answerSchema = z.object({
  requestId: uuidSchema,
  clarificationId: uuidSchema,
  answer: z.string().trim().min(1).max(5000),
  contentChanges: partialContentSchema.optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

/**
 * The requester answers on the same request: a new immutable revision, the
 * answered question, refreshed request content, and invalidated current RICE
 * commit together. Prior assessments become historical by revision mismatch.
 */
export async function answerClarification(ctx: VisitorContext, input: unknown) {
  const data = parseInput(answerSchema, input);

  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);

    return db.transaction(async (tx) => {
      const request = await lockRequest(tx, data.requestId);
      if (request.ownerVisitorId !== visitor.id)
        throw new WorkflowError("NOT_OWNER", "request");
      await requireUnresolved(tx, request);
      if (
        request.firstReviewCompletedAt ||
        request.stage === "first_review_completed"
      )
        throw new WorkflowError("INVALID_STATE", "first review is complete");
      requireVersion(data.expectedRowVersion, request.rowVersion);

      const [clarification] = await tx
        .select()
        .from(clarificationRequests)
        .where(
          and(
            eq(clarificationRequests.id, data.clarificationId),
            eq(clarificationRequests.requestId, request.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!clarification) throw new WorkflowError("NOT_FOUND", "clarification");
      if (clarification.answeredAt)
        throw new WorkflowError(
          "NO_OPEN_CLARIFICATION",
          "the question is already answered",
        );

      const merged = parseInput(requestContentSchema, {
        ...contentFromRequestRow(request),
        ...(data.contentChanges ?? {}),
      });

      const { revisionId, nextNumber } = await appendAnswerRevision(
        tx,
        request,
        visitor,
        merged,
      );

      await tx
        .update(clarificationRequests)
        .set({
          answer: data.answer,
          answeredAt: nowIso(),
          answerRevisionId: revisionId,
        })
        .where(eq(clarificationRequests.id, clarification.id));

      const updated = await refreshRequestContent(
        tx,
        request,
        merged,
        revisionId,
      );
      await enqueueReassessment(tx, visitor.id, request);
      await insertAudit(tx, {
        actorId: visitor.actorId,
        visitorId: visitor.id,
        actingView: "requester",
        eventType: "clarification_answered",
        subjectId: request.id,
        payload: {
          clarificationId: clarification.id,
          revisionNumber: nextNumber,
        },
      });

      return {
        requestId: updated.id,
        stage: updated.stage,
        rowVersion: updated.rowVersion,
        revisionNumber: nextNumber,
        currentRevisionId: revisionId,
      };
    });
  });
}

async function loadClarifications(
  db: Db | Tx,
  request: typeof requests.$inferSelect,
) {
  const clarifications = await db
    .select({
      id: clarificationRequests.id,
      question: clarificationRequests.question,
      askedByActorId: clarificationRequests.askedByActorId,
      askedAt: clarificationRequests.askedAt,
      answer: clarificationRequests.answer,
      answeredAt: clarificationRequests.answeredAt,
      revisionId: clarificationRequests.revisionId,
      answerRevisionId: clarificationRequests.answerRevisionId,
      requestGeneration: clarificationRequests.requestGeneration,
    })
    .from(clarificationRequests)
    .where(eq(clarificationRequests.requestId, request.id))
    .orderBy(asc(clarificationRequests.askedAt));
  const open =
    clarifications.find(
      (row) =>
        row.answeredAt === null &&
        row.requestGeneration === request.fixtureGeneration,
    ) ?? null;
  return { clarifications, open };
}

/**
 * Internal read of a request's review-facing state: revisions, questions, and
 * which assessments still match the current content revision.
 */
export async function getRequestRecord(requestIdInput: unknown, reader?: Tx) {
  const requestId = parseInput(uuidSchema, requestIdInput);

  return withReadSnapshot(async (db) => {
    const [request] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .limit(1);
    if (!request) throw new WorkflowError("NOT_FOUND", "request");

    const revisions = await db
      .select({
        id: requestContentRevisions.id,
        revisionNumber: requestContentRevisions.revisionNumber,
        source: requestContentRevisions.source,
        createdAt: requestContentRevisions.createdAt,
      })
      .from(requestContentRevisions)
      .where(eq(requestContentRevisions.requestId, request.id))
      .orderBy(asc(requestContentRevisions.revisionNumber));

    const { clarifications, open } = await loadClarifications(db, request);

    // Strict equality (NULL matches only NULL), and a live assessment counts
    // only in the generation it was prepared for. Fixture-origin assessments
    // are reference evidence, current again whenever a reset restores their
    // content and clears the pointer.
    const currentFor = (row: {
      revisionId: string | null;
      origin: string;
      requestGeneration: number;
    }) =>
      row.revisionId === request.currentRevisionId &&
      (row.origin === "fixture" ||
        row.requestGeneration === request.fixtureGeneration);

    const assets = await db
      .select({
        id: assetAssessments.id,
        status: assetAssessments.status,
        revisionId: assetAssessments.revisionId,
        origin: assetAssessments.origin,
        requestGeneration: assetAssessments.requestGeneration,
      })
      .from(assetAssessments)
      .where(eq(assetAssessments.draftId, request.sourceDraftId));
    const risks = await db
      .select({
        id: riskAssessments.id,
        status: riskAssessments.status,
        revisionId: riskAssessments.revisionId,
        origin: riskAssessments.origin,
        requestGeneration: riskAssessments.requestGeneration,
      })
      .from(riskAssessments)
      .where(eq(riskAssessments.draftId, request.sourceDraftId));

    return {
      requestId: request.id,
      displayId: request.displayId,
      title: request.title,
      stage: request.stage,
      routingState: request.routingState,
      content: contentFromRequestRow(request),
      currentRevisionId: request.currentRevisionId,
      rowVersion: request.rowVersion,
      currentRiceScoreId: request.currentRiceScoreId,
      waitingOnRequester: open !== null,
      openClarificationId: open?.id ?? null,
      revisions,
      clarifications,
      assetAssessments: assets.map((row) => ({
        ...row,
        needsReassessment: !currentFor(row),
      })),
      riskAssessments: risks.map((row) => ({
        ...row,
        needsReassessment: !currentFor(row),
      })),
    };
  }, reader);
}
