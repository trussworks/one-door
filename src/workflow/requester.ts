import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  actors,
  clarificationRequests,
  drafts,
  requestResolutions,
  organizations,
  requestContentRevisions,
  requests,
  serviceCandidates,
  serviceOfferings,
  taskCompletions,
  visitors,
} from "../db/schema.ts";
import { canonicalJson, sha256Hex } from "../models/contracts.ts";
import {
  priorityProposalSchema,
  type PriorityProposalInput,
} from "../domain/priority.ts";
import { submitPriorityProposals } from "./priority.ts";
import { enqueueJobInTx } from "../models/jobs.ts";
import {
  currentServiceSuggestions,
  requireSelectableCandidate,
} from "./intake.ts";
import { WorkflowError } from "./errors.ts";
import {
  contentFromRequestRow,
  insertAudit,
  isUniqueViolation,
  newId,
  nowIso,
  parseInput,
  partialContentSchema,
  ratingSchema,
  requestContentSchema,
  requireVisitor,
  requireVersion,
  uuidSchema,
  withDb,
  withReadSnapshot,
  type Db,
  type RequestContent,
  type Tx,
  type VisitorContext,
} from "./shared.ts";

/**
 * Create a new anonymous visitor with its own actor row. Every browser gets a
 * real actor; no shared fictional person stands in for live people.
 */
export async function createVisitor(input?: { displayName?: string }) {
  const displayNameInput = parseInput(
    z.object({ displayName: z.string().trim().min(1).max(80).optional() }),
    input ?? {},
  );
  const actorId = newId();
  const visitorId = newId();
  // Placeholder technical label; the interface may present visitors differently.
  const displayName =
    displayNameInput.displayName ?? `Visitor ${actorId.slice(0, 6)}`;

  return withDb(async (db) => {
    await db.transaction(async (tx) => {
      await tx.insert(actors).values({
        id: actorId,
        kind: "visitor",
        displayName,
      });
      await tx.insert(visitors).values({ id: visitorId, actorId });
    });
    return { visitorId, actorId, displayName };
  });
}

const saveDraftSchema = z.object({
  draftId: uuidSchema.optional(),
  creationKey: z.string().trim().min(8).max(120).optional(),
  parentRequestId: uuidSchema.optional(),
  organizationId: uuidSchema.optional(),
  rawNeed: z.string().max(5000).optional(),
  content: partialContentSchema.optional(),
  state: z.enum(["open", "ready"]).optional(),
  currentStep: z.string().trim().min(1).max(60).optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

function draftDto(row: typeof drafts.$inferSelect) {
  return {
    draftId: row.id,
    parentRequestId: row.parentRequestId,
    state: row.state,
    rowVersion: row.rowVersion,
    rawNeed: row.rawNeed,
    content: row.structuredContent,
    currentStep: row.currentStep,
    organizationId: row.requestingOrganizationId,
    updatedAt: row.updatedAt,
  };
}

type SaveDraftData = z.infer<typeof saveDraftSchema>;

async function requireOrganization(tx: Tx, organizationId: string) {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization)
    throw new WorkflowError("VALIDATION_FAILED", "unknown organization");
}

/** The creation input a retry must repeat exactly to replay, hashed. */
function creationInputHash(data: SaveDraftData): string {
  return sha256Hex(
    canonicalJson({
      organizationId: data.organizationId,
      rawNeed: data.rawNeed,
      content: data.content ?? {},
      state: data.state ?? "open",
      currentStep: data.currentStep ?? "describe",
      ...(data.parentRequestId
        ? { parentRequestId: data.parentRequestId }
        : {}),
    }),
  );
}

/**
 * A follow-up may hang off the visitor's own completed work only: the parent
 * must be past first review, or resolved at its current generation. The
 * parent row is read, never written — a follow-up cannot reopen it.
 */
async function requireEligibleParent(
  tx: Tx,
  visitorId: string,
  parentRequestId: string,
) {
  const [parent] = await tx
    .select({
      id: requests.id,
      ownerVisitorId: requests.ownerVisitorId,
      stage: requests.stage,
      fixtureGeneration: requests.fixtureGeneration,
    })
    .from(requests)
    .where(eq(requests.id, parentRequestId))
    .limit(1);
  if (!parent) throw new WorkflowError("NOT_FOUND", "parent request");
  if (parent.ownerVisitorId !== visitorId)
    throw new WorkflowError("NOT_OWNER", "parent request");
  if (parent.stage === "first_review_completed") return;
  const [resolved] = await tx
    .select({ id: requestResolutions.id })
    .from(requestResolutions)
    .where(
      and(
        eq(requestResolutions.requestId, parent.id),
        eq(requestResolutions.requestGeneration, parent.fixtureGeneration),
      ),
    )
    .limit(1);
  if (!resolved)
    throw new WorkflowError(
      "INVALID_STATE",
      "parent request is not past first review or resolved",
    );
}

/**
 * The existing draft made under this creation key, verified as a true
 * replay: same owner, same creation input. A replay reads the draft as it
 * stands now — a retry or stale back-navigation never writes, so it cannot
 * overwrite a progressed or submitted draft.
 */
async function replayedCreation(
  tx: Tx,
  visitor: { id: string },
  data: SaveDraftData & { creationKey: string },
) {
  const [existing] = await tx
    .select()
    .from(drafts)
    .where(eq(drafts.creationKey, data.creationKey))
    .limit(1);
  if (!existing) return null;
  if (existing.visitorId !== visitor.id)
    throw new WorkflowError("NOT_OWNER", "creation key");
  if (existing.creationInputHash !== creationInputHash(data))
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "creation key reused with different content",
    );
  return draftDto(existing);
}

async function createDraft(
  tx: Tx,
  visitor: { id: string; actorId: string },
  data: SaveDraftData,
) {
  if (!data.organizationId || !data.rawNeed?.trim()) {
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "a new draft needs organizationId and rawNeed",
    );
  }
  if (data.creationKey) {
    const replayed = await replayedCreation(tx, visitor, {
      ...data,
      creationKey: data.creationKey,
    });
    if (replayed) return replayed;
  }
  await requireOrganization(tx, data.organizationId);
  if (data.parentRequestId)
    await requireEligibleParent(tx, visitor.id, data.parentRequestId);

  const [created] = await tx
    .insert(drafts)
    .values(newDraftValues(visitor, data, data.organizationId, data.rawNeed))
    .returning();
  return draftDto(created);
}

function newDraftValues(
  visitor: { id: string; actorId: string },
  data: SaveDraftData,
  organizationId: string,
  rawNeed: string,
) {
  return {
    id: newId(),
    visitorId: visitor.id,
    requesterActorId: visitor.actorId,
    requestingOrganizationId: organizationId,
    rawNeed,
    structuredContent: data.content ?? {},
    fieldOrigins: {},
    state: data.state ?? "open",
    currentStep: data.currentStep ?? "describe",
    parentRequestId: data.parentRequestId ?? null,
    creationKey: data.creationKey ?? null,
    creationInputHash: data.creationKey ? creationInputHash(data) : null,
  };
}

async function updateDraft(
  tx: Tx,
  visitor: { id: string },
  data: SaveDraftData & { draftId: string },
) {
  const [draft] = await tx
    .select()
    .from(drafts)
    .where(eq(drafts.id, data.draftId))
    .limit(1)
    .for("update");
  if (!draft) throw new WorkflowError("NOT_FOUND", "draft");
  if (draft.visitorId !== visitor.id)
    throw new WorkflowError("NOT_OWNER", "draft");
  if (draft.state === "submitted")
    throw new WorkflowError("INVALID_STATE", "draft already submitted");
  requireVersion(data.expectedRowVersion, draft.rowVersion);
  if (data.parentRequestId !== undefined)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "the parent relation is set at creation only",
    );
  if (data.organizationId) await requireOrganization(tx, data.organizationId);

  const [updated] = await tx
    .update(drafts)
    .set(draftUpdateValues(draft, data))
    .where(eq(drafts.id, draft.id))
    .returning();
  return draftDto(updated);
}

function draftUpdateValues(
  draft: typeof drafts.$inferSelect,
  data: SaveDraftData,
) {
  // Editing the need or content invalidates the recorded intake adoption;
  // stale acceptance is forbidden.
  const invalidatesAdoption =
    data.rawNeed !== undefined || data.content !== undefined;
  return {
    rawNeed: data.rawNeed ?? draft.rawNeed,
    requestingOrganizationId:
      data.organizationId ?? draft.requestingOrganizationId,
    structuredContent: data.content
      ? { ...draft.structuredContent, ...data.content }
      : draft.structuredContent,
    state: data.state ?? draft.state,
    currentStep: data.currentStep ?? draft.currentStep,
    confirmedIntakeJobId: invalidatesAdoption
      ? null
      : draft.confirmedIntakeJobId,
    rowVersion: draft.rowVersion + 1,
    updatedAt: nowIso(),
  };
}

/** Create or update a visitor-owned draft with optimistic version checking. */
export async function saveDraft(ctx: VisitorContext, input: unknown) {
  const data = parseInput(saveDraftSchema, input);

  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    try {
      return await db.transaction(async (tx) =>
        data.draftId
          ? updateDraft(tx, visitor, { ...data, draftId: data.draftId })
          : createDraft(tx, visitor, data),
      );
    } catch (error) {
      // A concurrent create with the same creation key won the insert; the
      // winner's draft is the result both callers asked for.
      if (!data.draftId && data.creationKey && isUniqueViolation(error)) {
        const replayed = await db.transaction((tx) =>
          replayedCreation(tx, visitor, {
            ...data,
            creationKey: data.creationKey as string,
          }),
        );
        if (replayed) return replayed;
      }
      throw error;
    }
  });
}

export async function getOwnDraft(
  ctx: VisitorContext,
  draftIdInput: unknown,
  reader?: Tx,
) {
  const draftId = parseInput(uuidSchema, draftIdInput);
  return withReadSnapshot(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    const [draft] = await db
      .select()
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .limit(1);
    if (!draft) throw new WorkflowError("NOT_FOUND", "draft");
    if (draft.visitorId !== visitor.id)
      throw new WorkflowError("NOT_OWNER", "draft");
    return draftDto(draft);
  }, reader);
}

/** The visitor's own drafts and submitted requests, for My requests. */
export async function listOwnWork(ctx: VisitorContext, reader?: Tx) {
  return withReadSnapshot(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);

    const ownDrafts = await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.visitorId, visitor.id), isNull(drafts.submittedAt)))
      .orderBy(desc(drafts.updatedAt));

    const ownRequests = await db
      .select({
        requestId: requests.id,
        displayId: requests.displayId,
        title: requests.title,
        stage: requests.stage,
        routingState: requests.routingState,
        updatedAt: requests.updatedAt,
        openQuestionId: clarificationRequests.id,
      })
      .from(requests)
      .leftJoin(
        clarificationRequests,
        and(
          eq(clarificationRequests.requestId, requests.id),
          eq(
            clarificationRequests.requestGeneration,
            requests.fixtureGeneration,
          ),
          isNull(clarificationRequests.answeredAt),
        ),
      )
      .where(eq(requests.ownerVisitorId, visitor.id))
      .orderBy(desc(requests.updatedAt));

    return {
      drafts: ownDrafts.map(draftDto),
      requests: ownRequests.map((row) => ({
        requestId: row.requestId,
        displayId: row.displayId,
        title: row.title,
        stage: row.stage,
        routingState: row.routingState,
        updatedAt: row.updatedAt,
        answerNeeded: row.openQuestionId !== null,
      })),
    };
  }, reader);
}

const submitSchema = z.object({
  draftId: uuidSchema,
  rating: ratingSchema,
  idempotencyKey: z.string().trim().min(8).max(120),
  priorityProposals: z.array(priorityProposalSchema).max(4).optional(),
  selectedServiceCandidateId: uuidSchema.optional(),
  rejectionReason: z.string().trim().min(1).max(2000).optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

/**
 * Submitting past current service suggestions is an explicit customer
 * decision: it needs a reason, recorded as a rejection on every current
 * candidate not already rejected. Stale suggestions, a current run that
 * proposed no services, and drafts without model output stay honest
 * human-routing paths with nothing to reject.
 */
async function recordSuggestionRejections(
  tx: Tx,
  draft: typeof drafts.$inferSelect,
  visitorActorId: string,
  reason: string | undefined,
): Promise<string[]> {
  const suggestions = await currentServiceSuggestions(tx, draft);
  const toReject = suggestions.filter((row) => row.decision !== "rejected");
  if (toReject.length === 0) return [];
  if (!reason)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "submitting without a service needs a rejection reason for the current suggestions",
    );
  const decidedAt = nowIso();
  for (const candidate of toReject) {
    await tx
      .update(serviceCandidates)
      .set({
        decision: "rejected",
        decidedByActorId: visitorActorId,
        decisionReason: reason,
        decidedAt,
      })
      .where(eq(serviceCandidates.id, candidate.id));
  }
  return toReject.map((row) => row.id);
}

export function requestSummary(row: typeof requests.$inferSelect) {
  return {
    requestId: row.id,
    displayId: row.displayId,
    stage: row.stage,
    routingState: row.routingState,
    title: row.title,
    createdAt: row.createdAt,
  };
}

export async function existingRequestForDraft(db: Db | Tx, draftId: string) {
  const [existing] = await db
    .select()
    .from(requests)
    .where(eq(requests.sourceDraftId, draftId))
    .limit(1);
  return existing;
}

/**
 * A selected service must carry real evidence: the candidate comes from this
 * draft's adopted intake result and its offering is still active. The
 * acceptance is recorded on the candidate with its author and time.
 */
async function resolveRouting(
  tx: Tx,
  draft: typeof drafts.$inferSelect,
  visitorActorId: string,
  candidateId: string | undefined,
): Promise<"service_selected" | "routing_requested"> {
  if (!candidateId) return "routing_requested";
  const [candidate] = await tx
    .select()
    .from(serviceCandidates)
    .where(
      and(
        eq(serviceCandidates.id, candidateId),
        eq(serviceCandidates.draftId, draft.id),
      ),
    )
    .limit(1)
    .for("update");
  if (!candidate)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "candidate does not belong to this draft",
    );
  // The selection revalidates the full evidence: effective content, raw
  // need, answered conversation, offering corpus, and prompt version.
  await requireSelectableCandidate(tx, draft, candidate);
  const [offering] = await tx
    .select({ lifecycle: serviceOfferings.lifecycle })
    .from(serviceOfferings)
    .where(eq(serviceOfferings.id, candidate.offeringId))
    .limit(1);
  if (offering?.lifecycle !== "active")
    throw new WorkflowError(
      "INVALID_STATE",
      "the selected offering is no longer active",
    );
  if (candidate.decision !== "accepted") {
    await tx
      .update(serviceCandidates)
      .set({
        decision: "accepted",
        decidedByActorId: visitorActorId,
        decisionReason: null,
        decidedAt: nowIso(),
      })
      .where(eq(serviceCandidates.id, candidate.id));
  }
  return "service_selected";
}

interface SubmissionParts {
  draft: typeof drafts.$inferSelect;
  visitor: { id: string; actorId: string };
  content: RequestContent;
  routingState: "service_selected" | "routing_requested";
  selectedServiceCandidateId: string | null;
  rating: number;
  idempotencyKey: string;
  priorityProposals?: PriorityProposalInput[];
}

async function recordRequesterTask(
  tx: Tx,
  parts: SubmissionParts,
  requestId: string,
) {
  const { visitor } = parts;
  await tx.insert(taskCompletions).values({
    id: newId(),
    requestId,
    actorId: visitor.actorId,
    visitorId: visitor.id,
    taskType: "requester_submission",
    actingView: "requester",
    rating: parts.rating,
    origin: "live",
    idempotencyKey: parts.idempotencyKey,
  });
}

/** Request, revision 1, required rating, draft close, and audit in one step. */
export async function insertSubmission(tx: Tx, parts: SubmissionParts) {
  const { draft, visitor, content } = parts;
  const displayRows = await tx.execute(
    sql`SELECT nextval('request_display_id_seq')::text AS value`,
  );
  const [displayRow] = displayRows as unknown as Array<{ value: string }>;
  const displayId = `OD-${displayRow.value}`;

  const requestId = newId();
  const revisionId = newId();
  const [created] = await tx
    .insert(requests)
    .values({
      id: requestId,
      displayId,
      ownerVisitorId: visitor.id,
      requesterActorId: draft.requesterActorId,
      requestingOrganizationId: draft.requestingOrganizationId,
      sourceDraftId: draft.id,
      selectedServiceCandidateId: parts.selectedServiceCandidateId,
      routingState: parts.routingState,
      title: content.title,
      problem: content.problem,
      affectedPeople: content.affectedPeople,
      acceptanceCriteria: content.acceptanceCriteria,
      requirements: content.requirements,
      constraints: content.constraints,
      unknowns: content.unknowns,
      stage: "submitted",
    })
    .returning();

  await tx.insert(requestContentRevisions).values({
    id: revisionId,
    requestId,
    revisionNumber: 1,
    content,
    source: "submission",
    authoredByActorId: draft.requesterActorId,
    visitorId: visitor.id,
  });
  await tx
    .update(requests)
    .set({ currentRevisionId: revisionId })
    .where(eq(requests.id, requestId));

  await recordRequesterTask(tx, parts, requestId);

  await tx
    .update(drafts)
    .set({
      state: "submitted",
      submittedAt: nowIso(),
      rowVersion: draft.rowVersion + 1,
      updatedAt: nowIso(),
    })
    .where(eq(drafts.id, draft.id));

  await insertAudit(tx, {
    actorId: visitor.actorId,
    visitorId: visitor.id,
    actingView: "requester",
    eventType: "request_submitted",
    subjectId: requestId,
    payload: { displayId, routingState: parts.routingState },
  });

  const submitted = { ...created, currentRevisionId: revisionId };
  await submitPriorityProposals(
    tx,
    {
      actorId: visitor.actorId,
      visitorId: visitor.id,
      actingView: "requester",
    },
    submitted,
    { source: "requester", proposals: parts.priorityProposals ?? [] },
  );
  return submitted;
}

/**
 * Submit a ready draft: request, content revision 1, required rating, and
 * audit event commit together. Replays with the same draft return the same
 * request instead of creating anything.
 */
export async function submitRequest(ctx: VisitorContext, input: unknown) {
  const data = parseInput(submitSchema, input);

  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);

    try {
      return await db.transaction(async (tx) => {
        const [draft] = await tx
          .select()
          .from(drafts)
          .where(eq(drafts.id, data.draftId))
          .limit(1)
          .for("update");
        if (!draft) throw new WorkflowError("NOT_FOUND", "draft");
        if (draft.visitorId !== visitor.id)
          throw new WorkflowError("NOT_OWNER", "draft");

        const existing = await existingRequestForDraft(tx, draft.id);
        if (existing) return requestSummary(existing);
        if (draft.state !== "ready")
          throw new WorkflowError("INVALID_STATE", "draft is not ready");
        requireVersion(data.expectedRowVersion, draft.rowVersion);

        const content: RequestContent = parseInput(
          requestContentSchema,
          draft.structuredContent,
        );

        const routingState = await resolveRouting(
          tx,
          draft,
          visitor.actorId,
          data.selectedServiceCandidateId,
        );
        const rejectedCandidateIds =
          routingState === "routing_requested"
            ? await recordSuggestionRejections(
                tx,
                draft,
                visitor.actorId,
                data.rejectionReason,
              )
            : [];
        const created = await insertSubmission(tx, {
          draft,
          visitor,
          content,
          routingState,
          selectedServiceCandidateId: data.selectedServiceCandidateId ?? null,
          rating: data.rating,
          idempotencyKey: data.idempotencyKey,
          priorityProposals: data.priorityProposals,
        });
        // Preparation jobs commit with the submission: no crash gap, and the
        // asset job reuses an unchanged confirmed-content result.
        await enqueueJobInTx(tx, visitor.id, {
          purpose: "asset_match",
          draftId: draft.id,
          requestId: created.id,
        });
        await enqueueJobInTx(tx, visitor.id, {
          purpose: "risk_assess",
          draftId: draft.id,
          requestId: created.id,
        });
        if (rejectedCandidateIds.length > 0)
          await insertAudit(tx, {
            actorId: visitor.actorId,
            visitorId: visitor.id,
            actingView: "requester",
            eventType: "service_suggestions_rejected",
            subjectId: created.id,
            payload: { candidateIds: rejectedCandidateIds },
          });
        return requestSummary(created);
      });
    } catch (error) {
      // A concurrent replay lost the race on the draft or idempotency key; the
      // winner's request is the result both callers asked for.
      if (isUniqueViolation(error)) {
        const existing = await existingRequestForDraft(db, data.draftId);
        if (existing) return requestSummary(existing);
      }
      throw error;
    }
  });
}

/** The visitor's own request with its open question, for Request status. */
export async function getOwnRequest(
  ctx: VisitorContext,
  requestIdInput: unknown,
  reader?: Tx,
) {
  const requestId = parseInput(uuidSchema, requestIdInput);
  return withReadSnapshot(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    const [request] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .limit(1);
    if (!request) throw new WorkflowError("NOT_FOUND", "request");
    if (request.ownerVisitorId !== visitor.id)
      throw new WorkflowError("NOT_OWNER", "request");

    const [open] = await db
      .select({
        clarificationId: clarificationRequests.id,
        question: clarificationRequests.question,
        askedAt: clarificationRequests.askedAt,
      })
      .from(clarificationRequests)
      .where(
        and(
          eq(clarificationRequests.requestId, request.id),
          eq(
            clarificationRequests.requestGeneration,
            request.fixtureGeneration,
          ),
          isNull(clarificationRequests.answeredAt),
        ),
      )
      .limit(1);

    return {
      ...requestSummary(request),
      rowVersion: request.rowVersion,
      currentRevisionId: request.currentRevisionId,
      content: contentFromRequestRow(request),
      answerNeeded: Boolean(open),
      openClarification: open ?? null,
      updatedAt: request.updatedAt,
    };
  }, reader);
}
