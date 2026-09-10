import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  actors,
  assetAssessments,
  assetCandidateDecisions,
  assetCandidates,
  catalogItems,
  clarificationRequests,
  policyRules,
  requests,
  reviewTasks,
  riceScores,
  riskFindingDecisions,
  riskFindings,
} from "../db/schema.ts";
import { currentCorpusHashes } from "../models/corpus.ts";
import { WorkflowError } from "./errors.ts";
import { applyPriorityDecisions } from "./priority.ts";
import { readReviewInputs } from "./review-inputs.ts";
import {
  currentAssetAssessment,
  currentRiskAssessment,
} from "./review-assessments.ts";
export {
  isCurrentAssessment,
  selectCurrentAssessment,
  completedAssessmentId,
  currentAssetAssessment,
  currentRiskAssessment,
} from "./review-assessments.ts";
import {
  insertAudit,
  lockUnresolvedRequest,
  newId,
  nowIso,
  parseInput,
  requireActor,
  requireVersion,
  uuidSchema,
  withDb,
  withReadSnapshot,
  type ActorContext,
  type Tx,
} from "./shared.ts";

type RequestRow = typeof requests.$inferSelect;

export const reviewAreaCapabilities = {
  assets: "review_existing_assets",
  risk: "review_risk",
  rice: "estimate_delivery_effort",
} as const;

/** Live requests can predate their review-task rows; create them on demand. */
export async function ensureReviewTasks(
  tx: Tx,
  requestId: string,
): Promise<void> {
  for (const area of ["assets", "risk", "rice"] as const) {
    await tx
      .insert(reviewTasks)
      .values({
        id: newId(),
        requestId,
        area,
        responsibleCapability: reviewAreaCapabilities[area],
        state: "pending",
      })
      .onConflictDoNothing();
  }
}

function requireReviewable(request: RequestRow): void {
  if (request.stage === "first_review_completed")
    throw new WorkflowError("INVALID_STATE", "first review is complete");
}

async function setTaskState(
  tx: Tx,
  requestId: string,
  area: "assets" | "risk" | "rice",
  change: {
    state: "pending" | "in_progress" | "completed";
    completedAssessmentId?: string | null;
  },
): Promise<void> {
  await tx
    .update(reviewTasks)
    .set({
      state: change.state,
      completedAt: change.state === "completed" ? nowIso() : null,
      completedAssessmentId:
        change.state === "completed"
          ? (change.completedAssessmentId ?? null)
          : null,
      updatedAt: nowIso(),
    })
    .where(
      and(eq(reviewTasks.requestId, requestId), eq(reviewTasks.area, area)),
    );
}

async function bumpRequest(tx: Tx, request: RequestRow): Promise<void> {
  await tx
    .update(requests)
    .set({ rowVersion: request.rowVersion + 1, updatedAt: nowIso() })
    .where(eq(requests.id, request.id));
}

export const assetDecisionSchema = z.object({
  requestId: uuidSchema,
  candidateId: uuidSchema,
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

/**
 * Record a human decision on one asset candidate of the current assessment.
 * The proposal stays immutable; the decision appends and the pointer moves.
 */
export async function saveAssetDecision(ctx: ActorContext, input: unknown) {
  return withDb((db) =>
    db.transaction((tx) => saveAssetDecisionInTx(tx, ctx, input)),
  );
}

export async function saveAssetDecisionInTx(
  tx: Tx,
  ctx: ActorContext,
  input: unknown,
) {
  const data = parseInput(assetDecisionSchema, input);
  if (data.decision === "rejected" && !data.reason)
    throw new WorkflowError("VALIDATION_FAILED", "rejection needs a reason");

  await requireActor(tx, ctx.actorId);
  const request = await lockUnresolvedRequest(tx, data.requestId);
  requireReviewable(request);
  requireVersion(data.expectedRowVersion, request.rowVersion);

  const found = await currentAssetAssessment(tx, request);
  if ("blocker" in found)
    throw new WorkflowError("INVALID_STATE", found.blocker);
  const [candidate] = await tx
    .select()
    .from(assetCandidates)
    .where(
      and(
        eq(assetCandidates.id, data.candidateId),
        eq(assetCandidates.assessmentId, found.assessment.id),
      ),
    )
    .limit(1);
  if (!candidate)
    throw new WorkflowError("NOT_FOUND", "candidate in current assessment");

  const decisionId = newId();
  await tx.insert(assetCandidateDecisions).values({
    id: decisionId,
    candidateId: candidate.id,
    decision: data.decision,
    actorId: ctx.actorId,
    reason: data.reason ?? null,
    origin: "live",
    requestGeneration: request.fixtureGeneration,
  });
  await tx
    .update(assetCandidates)
    .set({ currentDecisionId: decisionId })
    .where(eq(assetCandidates.id, candidate.id));

  await ensureReviewTasks(tx, request.id);
  await setTaskState(tx, request.id, "assets", { state: "in_progress" });
  await bumpRequest(tx, request);
  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType: "asset_decision_saved",
    subjectId: request.id,
    payload: { candidateId: candidate.id, decision: data.decision },
  });
  return {
    requestId: request.id,
    candidateId: candidate.id,
    decision: data.decision,
    rowVersion: request.rowVersion + 1,
  };
}

const assetOutcomeSchema = z.object({
  requestId: uuidSchema,
  outcome: z.enum(["accepted", "no_match"]),
  expectedRowVersion: z.number().int().positive().optional(),
});

/**
 * Close the assets area: either at least one accepted candidate stands, or
 * the reviewer records that no existing solution fits.
 */
export async function recordAssetOutcome(ctx: ActorContext, input: unknown) {
  return withDb((db) =>
    db.transaction((tx) => recordAssetOutcomeInTx(tx, ctx, input)),
  );
}

const addCandidateSchema = z.object({
  requestId: uuidSchema,
  catalogItemId: uuidSchema,
  expectedRowVersion: z.number().int().positive(),
});

export async function addReviewCandidate(ctx: ActorContext, input: unknown) {
  const data = parseInput(addCandidateSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const request = await lockUnresolvedRequest(tx, data.requestId);
      requireReviewable(request);
      requireVersion(data.expectedRowVersion, request.rowVersion);
      const found = await currentAssetAssessment(tx, request);
      if ("blocker" in found)
        throw new WorkflowError("INVALID_STATE", found.blocker);
      const [item] = await tx
        .select()
        .from(catalogItems)
        .where(eq(catalogItems.id, data.catalogItemId))
        .limit(1);
      if (
        !item ||
        item.publicationState !== "published" ||
        item.approvalStatus !== "approved"
      )
        throw new WorkflowError(
          "VALIDATION_FAILED",
          "choose a published, approved catalog option",
        );
      const candidates = await tx
        .select()
        .from(assetCandidates)
        .where(eq(assetCandidates.assessmentId, found.assessment.id));
      const existing = candidates.find(
        (candidate) => candidate.catalogItemId === item.id,
      );
      if (existing)
        return {
          requestId: request.id,
          candidateId: existing.id,
          rowVersion: request.rowVersion,
        };
      const candidateId = newId();
      await tx.insert(assetCandidates).values({
        id: candidateId,
        assessmentId: found.assessment.id,
        catalogItemId: item.id,
        catalogVersion: item.currentVersion,
        name: item.name,
        rank: Math.max(0, ...candidates.map((candidate) => candidate.rank)) + 1,
        fitBand: null,
        proposedByActorId: ctx.actorId,
        coverage: [],
        gaps: [],
        dependencies: [],
        rationale: "Added by a reviewer for evaluation.",
      });
      await ensureReviewTasks(tx, request.id);
      await setTaskState(tx, request.id, "assets", { state: "in_progress" });
      await bumpRequest(tx, request);
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "review_candidate_added",
        subjectId: request.id,
        payload: {
          candidateId,
          catalogItemId: item.id,
          catalogVersion: item.currentVersion,
        },
      });
      return {
        requestId: request.id,
        candidateId,
        rowVersion: request.rowVersion + 1,
      };
    }),
  );
}

export async function recordAssetOutcomeInTx(
  tx: Tx,
  ctx: ActorContext,
  input: unknown,
) {
  const data = parseInput(assetOutcomeSchema, input);
  await requireActor(tx, ctx.actorId);
  const request = await lockUnresolvedRequest(tx, data.requestId);
  requireReviewable(request);
  requireVersion(data.expectedRowVersion, request.rowVersion);

  const found = await currentAssetAssessment(tx, request);
  if ("blocker" in found)
    throw new WorkflowError("INVALID_STATE", found.blocker);
  const rows = await candidateDecisions(tx, found.assessment.id);
  const accepted = rows.filter((row) => row.decision === "accepted");
  if (data.outcome === "accepted" && accepted.length === 0)
    throw new WorkflowError("INVALID_STATE", "no accepted candidate");
  if (data.outcome === "no_match") {
    if (accepted.length > 0)
      throw new WorkflowError("INVALID_STATE", "accepted candidates exist");
    // Declaring no match over proposed candidates requires an explicit
    // rejected fit decision (with its reason) on every one; only a
    // genuine zero-candidate assessment needs the outcome alone.
    if (rows.some((row) => row.decision !== "rejected"))
      throw new WorkflowError(
        "INVALID_STATE",
        "candidates without a rejected decision remain",
      );
  }

  await ensureReviewTasks(tx, request.id);
  await setTaskState(tx, request.id, "assets", {
    state: "completed",
    completedAssessmentId: found.assessment.id,
  });
  await bumpRequest(tx, request);
  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType: "asset_outcome_recorded",
    subjectId: request.id,
    payload: {
      outcome: data.outcome,
      acceptedCount: accepted.length,
      candidateCount: rows.length,
      revisionId: request.currentRevisionId,
      requestGeneration: request.fixtureGeneration,
    },
  });
  return {
    requestId: request.id,
    outcome: data.outcome,
    rowVersion: request.rowVersion + 1,
  };
}

async function candidateDecisions(tx: Tx, assessmentId: string) {
  return tx
    .select({
      id: assetCandidates.id,
      catalogItemId: assetCandidates.catalogItemId,
      catalogVersion: assetCandidates.catalogVersion,
      currentDecisionId: assetCandidates.currentDecisionId,
      decision: assetCandidateDecisions.decision,
    })
    .from(assetCandidates)
    .leftJoin(
      assetCandidateDecisions,
      eq(assetCandidateDecisions.id, assetCandidates.currentDecisionId),
    )
    .where(eq(assetCandidates.assessmentId, assessmentId));
}

async function acceptedCandidates(tx: Tx, assessmentId: string) {
  const rows = await candidateDecisions(tx, assessmentId);
  return rows.filter((row) => row.decision === "accepted");
}

export const riskDecisionSchema = z.object({
  requestId: uuidSchema,
  findingId: uuidSchema,
  decision: z.enum([
    "confirmed",
    "overridden",
    "follow_up_required",
    "cleared",
  ]),
  finalSeverity: z.enum(["low", "moderate", "high", "critical"]).optional(),
  rationale: z.string().trim().min(1).max(2000).optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

/** Decide one finding of the current risk assessment; proposals stay intact. */
export async function saveRiskDecision(ctx: ActorContext, input: unknown) {
  return withDb((db) =>
    db.transaction((tx) => saveRiskDecisionInTx(tx, ctx, input)),
  );
}

function validateRiskDecision(data: z.infer<typeof riskDecisionSchema>): void {
  if (data.decision !== "confirmed" && !data.rationale)
    throw new WorkflowError("VALIDATION_FAILED", "decision needs a rationale");
  if (data.decision === "overridden" && !data.finalSeverity)
    throw new WorkflowError("VALIDATION_FAILED", "override needs a severity");
  // A carried-over severity must not ride into a non-override decision.
  if (data.decision !== "overridden" && data.finalSeverity !== undefined)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "a final severity belongs to an override only",
    );
}

export async function saveRiskDecisionInTx(
  tx: Tx,
  ctx: ActorContext,
  input: unknown,
) {
  const data = parseInput(riskDecisionSchema, input);
  validateRiskDecision(data);
  await requireActor(tx, ctx.actorId);
  const request = await lockUnresolvedRequest(tx, data.requestId);
  requireReviewable(request);
  requireVersion(data.expectedRowVersion, request.rowVersion);

  const found = await currentRiskAssessment(tx, request);
  if ("blocker" in found)
    throw new WorkflowError("INVALID_STATE", found.blocker);
  const [finding] = await tx
    .select()
    .from(riskFindings)
    .where(
      and(
        eq(riskFindings.id, data.findingId),
        eq(riskFindings.assessmentId, found.assessment.id),
      ),
    )
    .limit(1);
  if (!finding)
    throw new WorkflowError("NOT_FOUND", "finding in current assessment");
  if (finding.kind === "missing_information" && data.decision === "confirmed")
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "missing information requires documented resolution",
    );

  const decisionId = newId();
  await tx.insert(riskFindingDecisions).values({
    id: decisionId,
    findingId: finding.id,
    decision: data.decision,
    finalSeverity: data.finalSeverity ?? null,
    actorId: ctx.actorId,
    rationale: data.rationale ?? null,
    origin: "live",
    requestGeneration: request.fixtureGeneration,
  });
  await tx
    .update(riskFindings)
    .set({ currentDecisionId: decisionId })
    .where(eq(riskFindings.id, finding.id));

  const openState = await riskAreaState(tx, request, found.assessment.id);
  await ensureReviewTasks(tx, request.id);
  await setTaskState(tx, request.id, "risk", {
    state: openState,
    completedAssessmentId:
      openState === "completed" ? found.assessment.id : null,
  });
  await bumpRequest(tx, request);
  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType: "risk_decision_saved",
    subjectId: request.id,
    payload: { findingId: finding.id, decision: data.decision },
  });
  return {
    requestId: request.id,
    findingId: finding.id,
    decision: data.decision,
    rowVersion: request.rowVersion + 1,
  };
}

const riskOutcomeSchema = z.object({
  requestId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
});

/**
 * Explicit human completion of the risk review area. Zero findings is a
 * human judgment, not an automatic pass: a person confirms the successful
 * assessment surfaced nothing needing follow-up. With findings, the call is
 * an idempotent confirmation once every finding is settled.
 */
export async function recordRiskOutcome(ctx: ActorContext, input: unknown) {
  return withDb((db) =>
    db.transaction((tx) => recordRiskOutcomeInTx(tx, ctx, input)),
  );
}

export async function recordRiskOutcomeInTx(
  tx: Tx,
  ctx: ActorContext,
  input: unknown,
) {
  const data = parseInput(riskOutcomeSchema, input);
  await requireActor(tx, ctx.actorId);
  const request = await lockUnresolvedRequest(tx, data.requestId);
  requireReviewable(request);
  requireVersion(data.expectedRowVersion, request.rowVersion);

  const found = await currentRiskAssessment(tx, request);
  if ("blocker" in found)
    throw new WorkflowError("INVALID_STATE", found.blocker);
  const findings = await currentFindingDecisions(tx, found.assessment.id);
  const settled = findings.every((row) => isSettledRiskDecision(row.decision));
  if (!settled)
    throw new WorkflowError("INVALID_STATE", "risk findings are not settled");

  await ensureReviewTasks(tx, request.id);
  await setTaskState(tx, request.id, "risk", {
    state: "completed",
    completedAssessmentId: found.assessment.id,
  });
  await bumpRequest(tx, request);
  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType: "risk_outcome_recorded",
    subjectId: request.id,
    payload: {
      assessmentId: found.assessment.id,
      findingCount: findings.length,
      revisionId: request.currentRevisionId,
      requestGeneration: request.fixtureGeneration,
    },
  });
  return {
    requestId: request.id,
    findingCount: findings.length,
    rowVersion: request.rowVersion + 1,
  };
}

/**
 * Risk closes only when every finding has a settled current decision. A
 * documented cleared ruling settles its finding like a confirmation or an
 * override; follow-up keeps the area open.
 */
function isSettledRiskDecision(decision: string | null): boolean {
  return (
    decision === "confirmed" ||
    decision === "overridden" ||
    decision === "cleared"
  );
}

async function riskAreaState(
  tx: Tx,
  request: RequestRow,
  assessmentId: string,
): Promise<"in_progress" | "completed"> {
  const findings = await currentFindingDecisions(tx, assessmentId);
  const settled = findings.every((row) => isSettledRiskDecision(row.decision));
  return settled && findings.length > 0 ? "completed" : "in_progress";
}

async function currentFindingDecisions(tx: Tx, assessmentId: string) {
  return tx
    .select({
      findingId: riskFindings.id,
      decision: riskFindingDecisions.decision,
    })
    .from(riskFindings)
    .leftJoin(
      riskFindingDecisions,
      eq(riskFindingDecisions.id, riskFindings.currentDecisionId),
    )
    .where(eq(riskFindings.assessmentId, assessmentId));
}

const factor = z.number().finite();
const riceSchema = z.object({
  requestId: uuidSchema,
  reach: factor.nonnegative().max(999999999999.99).multipleOf(0.01),
  reachUnit: z.string().trim().min(1).max(80),
  reachPeriod: z.string().trim().min(1).max(80),
  reachRationale: z.string().trim().min(1).max(1000),
  reachActorId: uuidSchema,
  impact: factor.positive().max(1000).multipleOf(0.01),
  impactRationale: z.string().trim().min(1).max(1000),
  impactActorId: uuidSchema,
  confidence: factor.gt(0).max(1).multipleOf(0.0001),
  confidenceRationale: z.string().trim().min(1).max(1000),
  confidenceActorId: uuidSchema,
  effort: factor.positive().max(10000).multipleOf(0.01),
  effortRationale: z.string().trim().min(1).max(1000),
  effortActorId: uuidSchema,
  rubricVersion: z.literal("rubric-v1").default("rubric-v1"),
  expectedRowVersion: z.number().int().positive().optional(),
});

/**
 * Append a human-entered RICE version and move the current pointer. No model
 * participates; the deterministic arithmetic must satisfy the database's
 * formula check.
 */
export async function saveRiceScore(ctx: ActorContext, input: unknown) {
  const data = parseInput(riceSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockUnresolvedRequest(tx, data.requestId);
      requireVersion(data.expectedRowVersion, request.rowVersion);
      const priority = await applyPriorityDecisions(tx, ctx, request, [
        {
          factor: "reach",
          action: "replace",
          estimate: {
            value: data.reach,
            basis: data.reachRationale,
            unit: data.reachUnit,
            period: data.reachPeriod,
          },
          suppliedByActorId: data.reachActorId,
        },
        {
          factor: "impact",
          action: "replace",
          estimate: { value: data.impact, basis: data.impactRationale },
          suppliedByActorId: data.impactActorId,
        },
        {
          factor: "confidence",
          action: "replace",
          estimate: { value: data.confidence, basis: data.confidenceRationale },
          suppliedByActorId: data.confidenceActorId,
        },
        {
          factor: "effort",
          action: "replace",
          estimate: { value: data.effort, basis: data.effortRationale },
          suppliedByActorId: data.effortActorId,
        },
      ]);
      if (!priority.scoreId)
        throw new WorkflowError(
          "INVALID_STATE",
          "complete priority did not produce a score",
        );
      const [saved] = await tx
        .select({ version: riceScores.version, score: riceScores.score })
        .from(riceScores)
        .where(eq(riceScores.id, priority.scoreId));
      await bumpRequest(tx, request);
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "rice_saved",
        subjectId: request.id,
        payload: { version: saved.version, score: saved.score },
      });
      return {
        requestId: request.id,
        version: saved.version,
        score: Number(saved.score),
        rowVersion: request.rowVersion + 1,
      };
    }),
  );
}

const assignSchema = z.object({
  requestId: uuidSchema,
  coordinatorActorId: uuidSchema.nullable().optional(),
  assignments: z
    .array(
      z.object({
        area: z.enum(["assets", "risk", "rice"]),
        assigneeActorId: uuidSchema.nullable(),
      }),
    )
    .max(3)
    .optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

/** Assign or reassign the coordinator and per-area responsibilities. */
export async function assignReview(ctx: ActorContext, input: unknown) {
  const data = parseInput(assignSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const request = await lockUnresolvedRequest(tx, data.requestId);
      requireVersion(data.expectedRowVersion, request.rowVersion);
      await ensureReviewTasks(tx, request.id);

      if (data.coordinatorActorId !== undefined) {
        if (data.coordinatorActorId)
          await requireActor(tx, data.coordinatorActorId);
        await tx
          .update(requests)
          .set({ coordinatingActorId: data.coordinatorActorId })
          .where(eq(requests.id, request.id));
      }
      for (const assignment of data.assignments ?? []) {
        if (assignment.assigneeActorId)
          await requireActor(tx, assignment.assigneeActorId);
        await tx
          .update(reviewTasks)
          .set({
            assigneeActorId: assignment.assigneeActorId,
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(reviewTasks.requestId, request.id),
              eq(reviewTasks.area, assignment.area),
            ),
          );
      }
      await bumpRequest(tx, request);
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "review_assigned",
        subjectId: request.id,
        payload: {
          coordinatorActorId: data.coordinatorActorId ?? null,
          areas: (data.assignments ?? []).map((entry) => entry.area),
        },
      });
      return { requestId: request.id, rowVersion: request.rowVersion + 1 };
    }),
  );
}

const routingSchema = z.object({
  requestId: uuidSchema,
  nextOwner: z.string().trim().min(1).max(160).optional(),
  deliveryOwnerActorId: uuidSchema.optional(),
  nextTask: z.string().trim().min(1).max(2000).optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

export interface DeliveryOwnerFields {
  nextOwner: string;
  deliveryOwnerActorId: string | null;
  nextTask: string | null;
}

/**
 * One write mode at a time: either the structured pair (owner actor plus
 * next task, resolved server-side to a display name) or the legacy free
 * text. Mixing the modes is contradictory input, and a legacy write clears
 * the structured pair so no stale values survive it.
 */
export async function resolveDeliveryOwner(
  tx: Tx,
  input: {
    nextOwner?: string;
    deliveryOwnerActorId?: string;
    nextTask?: string;
  },
): Promise<DeliveryOwnerFields | null> {
  const structured = Boolean(input.deliveryOwnerActorId || input.nextTask);
  if (structured && input.nextOwner)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "supply the delivery owner pair or the legacy next owner, not both",
    );
  if (structured) {
    if (!input.deliveryOwnerActorId || !input.nextTask)
      throw new WorkflowError(
        "VALIDATION_FAILED",
        "deliveryOwnerActorId and nextTask go together",
      );
    const [owner] = await tx
      .select({ displayName: actors.displayName, kind: actors.kind })
      .from(actors)
      .where(eq(actors.id, input.deliveryOwnerActorId))
      .limit(1);
    if (!owner) throw new WorkflowError("NOT_FOUND", "delivery owner");
    // Delivery ownership names an accountable person; a system actor
    // cannot answer for the next task.
    if (owner.kind === "system")
      throw new WorkflowError(
        "VALIDATION_FAILED",
        "the delivery owner must be a person",
      );
    return {
      // The legacy-compatible string carries the full task; nothing is
      // truncated for old readers or handoff snapshots.
      nextOwner: owner.displayName + ": " + input.nextTask,
      deliveryOwnerActorId: input.deliveryOwnerActorId,
      nextTask: input.nextTask,
    };
  }
  if (!input.nextOwner) return null;
  return {
    nextOwner: input.nextOwner,
    deliveryOwnerActorId: null,
    nextTask: null,
  };
}

/**
 * Record the human-selected next owner or path for a request, typically one
 * with no service match. The text is caller-provided existing content.
 */
export async function recordRouting(ctx: ActorContext, input: unknown) {
  const data = parseInput(routingSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const request = await lockUnresolvedRequest(tx, data.requestId);
      requireReviewable(request);
      requireVersion(data.expectedRowVersion, request.rowVersion);

      const owner = await resolveDeliveryOwner(tx, data);
      if (!owner)
        throw new WorkflowError(
          "VALIDATION_FAILED",
          "routing needs a delivery owner",
        );
      await tx.update(requests).set(owner).where(eq(requests.id, request.id));
      await bumpRequest(tx, request);
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "human_routing_recorded",
        subjectId: request.id,
        // Before and after owner values, so a later routing write never
        // erases which plan was recorded first. hasNextOwner stays for
        // readers of the old payload shape.
        payload: {
          hasNextOwner: true,
          previous: {
            nextOwner: request.nextOwner,
            deliveryOwnerActorId: request.deliveryOwnerActorId,
            nextTask: request.nextTask,
          },
          recorded: {
            nextOwner: owner.nextOwner,
            deliveryOwnerActorId: owner.deliveryOwnerActorId,
            nextTask: owner.nextTask,
          },
        },
      });
      return { requestId: request.id, rowVersion: request.rowVersion + 1 };
    }),
  );
}

export type ApprovalBlocker =
  | "OPEN_CLARIFICATION"
  | "ASSET_ASSESSMENT_MISSING"
  | "ASSET_ASSESSMENT_FAILED"
  | "ASSET_OUTCOME_PENDING"
  | "RISK_ASSESSMENT_MISSING"
  | "RISK_ASSESSMENT_FAILED"
  | "RISK_FINDINGS_UNDECIDED"
  | "RISK_FOLLOW_UP_OPEN"
  | "RISK_OUTCOME_PENDING"
  | "ASSET_CORPUS_STALE"
  | "RISK_CORPUS_STALE"
  | "RICE_MISSING"
  | "NEXT_OWNER_MISSING"
  | "CATALOG_INELIGIBLE"
  | "RISK_RULE_RETIRED";

/**
 * Final approval rechecks the whole eligible corpus, not only cited members:
 * a newly added, changed, or retired catalog item or policy rule moves the
 * collectCorpus hash and demands fresh preparation, even for an assessment
 * with zero candidates or findings. Fixture and live assessments use the
 * same currency check; origin remains separate provenance, never proof of
 * whether the corpus still matches.
 */
async function assetBlockers(
  tx: Tx,
  request: RequestRow,
  assessment: typeof assetAssessments.$inferSelect,
  currentHash: string,
): Promise<ApprovalBlocker[]> {
  const blockers: ApprovalBlocker[] = [];
  if (assessment.catalogCorpusHash !== currentHash)
    blockers.push("ASSET_CORPUS_STALE");
  const [task] = await tx
    .select({
      state: reviewTasks.state,
      completedAssessmentId: reviewTasks.completedAssessmentId,
    })
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.requestId, request.id),
        eq(reviewTasks.area, "assets"),
      ),
    )
    .limit(1);
  // The completion must name the assessment that is current now; a
  // completion recorded against a superseded result approves nothing.
  if (
    task?.state !== "completed" ||
    task.completedAssessmentId !== assessment.id
  )
    blockers.push("ASSET_OUTCOME_PENDING");
  else blockers.push(...(await catalogBlockers(tx, assessment.id)));
  return blockers;
}

/** Every reason first-review completion is currently impossible. */
export async function approvalBlockers(
  tx: Tx,
  request: RequestRow,
): Promise<ApprovalBlocker[]> {
  const blockers: ApprovalBlocker[] = [];
  const [open] = await tx
    .select({ id: clarificationRequests.id })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.requestId, request.id),
        eq(clarificationRequests.requestGeneration, request.fixtureGeneration),
        isNull(clarificationRequests.answeredAt),
      ),
    )
    .limit(1);
  if (open) blockers.push("OPEN_CLARIFICATION");
  const pendingInputs = (await readReviewInputs(tx, request.id)).filter(
    (input) => input.current && input.state !== "resolved",
  );
  if (pendingInputs.some((input) => input.area === "assets"))
    blockers.push("ASSET_OUTCOME_PENDING");
  if (pendingInputs.some((input) => input.area === "risk"))
    blockers.push("RISK_FOLLOW_UP_OPEN");

  const corpusHashes = await currentCorpusHashes(tx);
  const assets = await currentAssetAssessment(tx, request);
  if ("blocker" in assets) blockers.push(assets.blocker);
  else
    blockers.push(
      ...(await assetBlockers(
        tx,
        request,
        assets.assessment,
        corpusHashes.asset,
      )),
    );

  const risk = await currentRiskAssessment(tx, request);
  if ("blocker" in risk) blockers.push(risk.blocker);
  else {
    if (risk.assessment.policyCorpusHash !== corpusHashes.risk)
      blockers.push("RISK_CORPUS_STALE");
    blockers.push(...(await riskBlockers(tx, risk.assessment.id)));
    // A successful assessment with zero findings is not an automatic pass:
    // a person records the risk outcome before approval, exactly as the
    // assets area requires a recorded outcome — and the completion must
    // name the assessment that is current now.
    const [task] = await tx
      .select({
        state: reviewTasks.state,
        completedAssessmentId: reviewTasks.completedAssessmentId,
      })
      .from(reviewTasks)
      .where(
        and(
          eq(reviewTasks.requestId, request.id),
          eq(reviewTasks.area, "risk"),
        ),
      )
      .limit(1);
    if (
      task?.state !== "completed" ||
      task.completedAssessmentId !== risk.assessment.id
    )
      blockers.push("RISK_OUTCOME_PENDING");
  }

  return blockers;
}

async function riskBlockers(
  tx: Tx,
  assessmentId: string,
): Promise<ApprovalBlocker[]> {
  const rows = await currentFindingDecisions(tx, assessmentId);
  const blockers: ApprovalBlocker[] = [];
  if (rows.some((row) => row.decision === null))
    blockers.push("RISK_FINDINGS_UNDECIDED");
  if (rows.some((row) => row.decision === "follow_up_required"))
    blockers.push("RISK_FOLLOW_UP_OPEN");
  const retired = await tx
    .select({ id: riskFindings.id })
    .from(riskFindings)
    .innerJoin(policyRules, eq(policyRules.id, riskFindings.policyRuleId))
    .where(
      and(
        eq(riskFindings.assessmentId, assessmentId),
        eq(policyRules.lifecycle, "retired"),
      ),
    );
  if (retired.length > 0) blockers.push("RISK_RULE_RETIRED");
  return blockers;
}

/** Accepted assets must still be published, approved, and version-current. */
async function catalogBlockers(
  tx: Tx,
  assessmentId: string,
): Promise<ApprovalBlocker[]> {
  const accepted = await acceptedCandidates(tx, assessmentId);
  for (const candidate of accepted) {
    const [item] = await tx
      .select({
        publicationState: catalogItems.publicationState,
        approvalStatus: catalogItems.approvalStatus,
        currentVersion: catalogItems.currentVersion,
      })
      .from(catalogItems)
      .where(eq(catalogItems.id, candidate.catalogItemId))
      .limit(1);
    if (
      !item ||
      item.publicationState !== "published" ||
      item.approvalStatus !== "approved" ||
      item.currentVersion !== candidate.catalogVersion
    ) {
      return ["CATALOG_INELIGIBLE"];
    }
  }
  return [];
}

/** Internal read: task states, blockers, and the recorded next owner. */
/** The structured owner's display name, resolved for the read model. */
async function deliveryOwnerName(
  tx: Tx,
  actorId: string | null,
): Promise<string | null> {
  if (!actorId) return null;
  const [owner] = await tx
    .select({ displayName: actors.displayName })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  return owner?.displayName ?? null;
}

export async function getReviewState(requestIdInput: unknown, reader?: Tx) {
  const requestId = parseInput(uuidSchema, requestIdInput);
  // A read model takes no row lock; the read-snapshot boundary provides the
  // consistency, and a read-only transaction could not lock anyway.
  return withReadSnapshot(async (tx) => {
    const [request] = await tx
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .limit(1);
    if (!request) throw new WorkflowError("NOT_FOUND", "request");
    const tasks = await tx
      .select({
        area: reviewTasks.area,
        state: reviewTasks.state,
        assigneeActorId: reviewTasks.assigneeActorId,
        responsibleCapability: reviewTasks.responsibleCapability,
      })
      .from(reviewTasks)
      .where(eq(reviewTasks.requestId, requestId));
    const blockers =
      request.stage === "first_review_completed"
        ? []
        : await approvalBlockers(tx, request);
    // Completion can supply the owner directly, so the shared blocker list
    // leaves it out; the read model reports the full picture.
    if (request.stage !== "first_review_completed" && !request.nextOwner)
      blockers.push("NEXT_OWNER_MISSING");
    return {
      requestId,
      stage: request.stage,
      rowVersion: request.rowVersion,
      coordinatingActorId: request.coordinatingActorId,
      nextOwner: request.nextOwner,
      deliveryOwnerActorId: request.deliveryOwnerActorId,
      deliveryOwnerName: await deliveryOwnerName(
        tx,
        request.deliveryOwnerActorId,
      ),
      nextTask: request.nextTask,
      currentRiceScoreId: request.currentRiceScoreId,
      tasks,
      blockers,
    };
  }, reader);
}
