import { isDeepStrictEqual } from "node:util";

import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";

import { actors } from "../db/schema/identity.ts";
import { priorityContributions } from "../db/schema/priority.ts";
import { requests } from "../db/schema/requests.ts";
import {
  assetAssessments,
  assetCandidateDecisions,
  assetCandidates,
  reviewTasks,
  riskAssessments,
  riskFindingDecisions,
  riskFindings,
} from "../db/schema/review.ts";
import {
  reviewInputRequests,
  reviewInputResponses,
} from "../db/schema/review-inputs.ts";
import { priorityEstimateSchema, priorityFactors } from "../domain/priority.ts";
import {
  isCurrentReviewInput,
  reviewInputAudiences,
  reviewInputOutcomes,
  reviewInputResolutions,
} from "../domain/review-inputs.ts";
import { WorkflowError } from "./errors.ts";
import {
  currentAssetAssessment,
  currentRiskAssessment,
} from "./review-assessments.ts";
import { readPriority, submitPriorityProposals } from "./priority.ts";
import {
  insertAudit,
  lockUnresolvedRequest,
  nowIso,
  parseInput,
  requireActor,
  requireUnresolved,
  requireVersion,
  requireVisitor,
  uuidSchema,
  withDb,
  type ActorContext,
  type Db,
  type Tx,
} from "./shared.ts";

type RequestRow = typeof requests.$inferSelect;
type InputRow = typeof reviewInputRequests.$inferSelect;
type TargetedInputRow = InputRow & {
  candidateAssessmentId: string | null;
  findingAssessmentId: string | null;
};
type ResponseRow = typeof reviewInputResponses.$inferSelect;
export type ReviewInputAnswerContext =
  | ActorContext
  | {
      actingView: "requester";
      visitorId: string;
    };

const optionalText = z.string().trim().min(1).max(2000).optional();
const version = z.number().int().positive();
const askShape = z
  .object({
    requestId: uuidSchema,
    inputRequestId: uuidSchema,
    expectedRowVersion: version,
    area: z.enum(["assets", "risk", "rice"]),
    audience: z.enum(reviewInputAudiences),
    factor: z.enum(priorityFactors).optional(),
    candidateId: uuidSchema.optional(),
    findingId: uuidSchema.optional(),
    question: z.string().trim().min(1).max(2000),
    scope: optionalText,
    expertise: optionalText,
    assigneeActorId: uuidSchema.optional(),
  })
  .strict();

function invalidTarget(data: z.infer<typeof askShape>) {
  return (
    (data.factor && data.area !== "rice") ||
    (data.candidateId && data.area !== "assets") ||
    (data.findingId && data.area !== "risk") ||
    (data.audience === "requester" && data.assigneeActorId)
  );
}

export const askReviewInputSchema = askShape.superRefine((data, ctx) => {
  if (invalidTarget(data))
    ctx.addIssue({
      code: "custom",
      message: "target does not match area or audience",
    });
  if (data.area === "rice" && !data.factor) {
    ctx.addIssue({
      code: "custom",
      path: ["factor"],
      message: "name the factor that needs input",
    });
  }
  if (
    data.audience === "internal" &&
    !data.assigneeActorId &&
    !data.expertise
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["expertise"],
      message: "name the expertise needed for allocation",
    });
  }
});

export const assignReviewInputSchema = z
  .object({
    requestId: uuidSchema,
    inputRequestId: uuidSchema,
    expectedRowVersion: version,
    expectedInputVersion: version,
    assigneeActorId: uuidSchema.nullable(),
  })
  .strict();

export const answerReviewInputSchema = z
  .object({
    requestId: uuidSchema,
    inputRequestId: uuidSchema,
    responseId: uuidSchema,
    expectedRowVersion: version,
    expectedInputVersion: version,
    answer: z.string().trim().min(1).max(5000),
    outcome: z.enum(reviewInputOutcomes),
    proposal: z
      .object({
        factor: z.enum(priorityFactors),
        estimate: priorityEstimateSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.outcome === "unknown" && data.proposal) {
      ctx.addIssue({
        code: "custom",
        path: ["proposal"],
        message: "an unknown answer cannot supply an estimate",
      });
    }
  });

export const resolveReviewInputSchema = z
  .object({
    inputRequestId: uuidSchema,
    expectedInputVersion: version,
    responseId: uuidSchema,
    resolutionKind: z.enum(reviewInputResolutions),
    resolutionId: uuidSchema,
  })
  .strict();

type AskInput = z.infer<typeof askReviewInputSchema>;
type AnswerInput = z.infer<typeof answerReviewInputSchema>;
type ResolutionInput = z.infer<typeof resolveReviewInputSchema>;

function requireInternal(ctx: { actingView: string }): void {
  if (ctx.actingView !== "contributor" && ctx.actingView !== "administrator") {
    throw new WorkflowError("NOT_OWNER", "internal review input");
  }
}

function requireAvailable(request: RequestRow, area: InputRow["area"]): void {
  if (request.stage === "first_review_completed" && area !== "rice") {
    throw new WorkflowError("INVALID_STATE", "first review is complete");
  }
}

async function activeActor(tx: Tx, actorId: string) {
  const [actor] = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.id, actorId), eq(actors.active, true)))
    .limit(1);
  if (!actor) throw new WorkflowError("NOT_FOUND", "active contributor");
}

async function bumpRequest(tx: Tx, request: RequestRow) {
  await tx
    .update(requests)
    .set({ rowVersion: request.rowVersion + 1, updatedAt: nowIso() })
    .where(eq(requests.id, request.id));
}

async function inputForRequest(
  tx: Tx,
  requestId: string,
  inputRequestId: string,
) {
  const [input] = await tx
    .select({
      input: reviewInputRequests,
      candidateAssessmentId: assetCandidates.assessmentId,
      findingAssessmentId: riskFindings.assessmentId,
    })
    .from(reviewInputRequests)
    .leftJoin(
      assetCandidates,
      eq(assetCandidates.id, reviewInputRequests.candidateId),
    )
    .leftJoin(riskFindings, eq(riskFindings.id, reviewInputRequests.findingId))
    .where(
      and(
        eq(reviewInputRequests.id, inputRequestId),
        eq(reviewInputRequests.requestId, requestId),
      ),
    )
    .limit(1)
    .for("update", { of: reviewInputRequests });
  if (!input) throw new WorkflowError("NOT_FOUND", "review input request");
  return {
    ...input.input,
    candidateAssessmentId: input.candidateAssessmentId,
    findingAssessmentId: input.findingAssessmentId,
  };
}

async function inputAssessmentCurrency(reader: Db | Tx, request: RequestRow) {
  const [assets, risk] = await Promise.all([
    currentAssetAssessment(reader, request),
    currentRiskAssessment(reader, request),
  ]);
  return {
    assetAssessmentId: "assessment" in assets ? assets.assessment.id : null,
    riskAssessmentId: "assessment" in risk ? risk.assessment.id : null,
  };
}

async function requireCurrent(
  tx: Tx,
  input: TargetedInputRow,
  request: RequestRow,
): Promise<void> {
  const currency =
    input.candidateId || input.findingId
      ? await inputAssessmentCurrency(tx, request)
      : undefined;
  if (!isCurrentReviewInput(input, request, currency)) {
    throw new WorkflowError(
      "VERSION_CONFLICT",
      "question belongs to an earlier request revision, fixture generation, or assessment",
    );
  }
  if (input.state === "resolved")
    throw new WorkflowError("INVALID_STATE", "input request is resolved");
  requireAvailable(request, input.area);
}

async function validateTarget(tx: Tx, request: RequestRow, data: AskInput) {
  const currency =
    data.candidateId || data.findingId
      ? await inputAssessmentCurrency(tx, request)
      : undefined;
  let candidateAssessmentId: string | null = null;
  let findingAssessmentId: string | null = null;
  if (data.candidateId) {
    const [row] = await tx
      .select({ assessment: assetAssessments })
      .from(assetCandidates)
      .innerJoin(
        assetAssessments,
        eq(assetCandidates.assessmentId, assetAssessments.id),
      )
      .where(eq(assetCandidates.id, data.candidateId))
      .limit(1);
    requireTargetAssessment(row?.assessment, request);
    candidateAssessmentId = row.assessment.id;
  }
  if (data.findingId) {
    const [row] = await tx
      .select({ assessment: riskAssessments })
      .from(riskFindings)
      .innerJoin(
        riskAssessments,
        eq(riskFindings.assessmentId, riskAssessments.id),
      )
      .where(eq(riskFindings.id, data.findingId))
      .limit(1);
    requireTargetAssessment(row?.assessment, request);
    findingAssessmentId = row.assessment.id;
  }
  if (
    !isCurrentReviewInput(
      {
        ...data,
        revisionId: request.currentRevisionId,
        requestGeneration: request.fixtureGeneration,
        candidateAssessmentId,
        findingAssessmentId,
      },
      request,
      currency,
    )
  )
    throw new WorkflowError(
      "VERSION_CONFLICT",
      "review target is no longer selected",
    );
  if (data.assigneeActorId) await activeActor(tx, data.assigneeActorId);
}

function requireTargetAssessment(
  assessment:
    | {
        draftId: string;
        revisionId: string | null;
        requestGeneration: number;
        origin: string;
        status: string;
      }
    | undefined,
  request: RequestRow,
) {
  if (!assessment || assessment.draftId !== request.sourceDraftId) {
    throw new WorkflowError("NOT_FOUND", "review target");
  }
  const current =
    assessment.revisionId === request.currentRevisionId &&
    (assessment.origin === "fixture" ||
      assessment.requestGeneration === request.fixtureGeneration);
  if (!current || assessment.status !== "succeeded") {
    throw new WorkflowError("VERSION_CONFLICT", "review target is not current");
  }
}

function sameQuestion(
  prior: InputRow,
  data: AskInput,
  actorId: string,
): boolean {
  return (
    prior.askedByActorId === actorId &&
    prior.requestId === data.requestId &&
    [
      "area",
      "audience",
      "factor",
      "candidateId",
      "findingId",
      "question",
      "scope",
      "expertise",
      "assigneeActorId",
    ].every(
      (key) =>
        prior[key as keyof InputRow] === (data[key as keyof AskInput] ?? null),
    )
  );
}

export async function askReviewInputInTx(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  raw: unknown,
) {
  requireInternal(ctx);
  const data = parseInput(askReviewInputSchema, raw);
  if (data.requestId !== request.id)
    throw new WorkflowError("NOT_FOUND", "request");
  await requireUnresolved(tx, request);
  await requireActor(tx, ctx.actorId);
  const [prior] = await tx
    .select()
    .from(reviewInputRequests)
    .where(eq(reviewInputRequests.id, data.inputRequestId))
    .limit(1);
  if (prior) {
    if (!sameQuestion(prior, data, ctx.actorId))
      throw new WorkflowError(
        "VERSION_CONFLICT",
        "input request id was reused",
      );
    return { ...prior, replayed: true };
  }
  requireVersion(data.expectedRowVersion, request.rowVersion);
  requireAvailable(request, data.area);
  await validateTarget(tx, request, data);
  const [created] = await tx
    .insert(reviewInputRequests)
    .values({
      id: data.inputRequestId,
      requestId: request.id,
      revisionId: request.currentRevisionId,
      requestGeneration: request.fixtureGeneration,
      area: data.area,
      audience: data.audience,
      factor: data.factor,
      candidateId: data.candidateId,
      findingId: data.findingId,
      question: data.question,
      scope: data.scope,
      expertise: data.expertise,
      askedByActorId: ctx.actorId,
      askedByVisitorId: ctx.visitorId,
      assigneeActorId: data.assigneeActorId,
      assignedByActorId: data.assigneeActorId ? ctx.actorId : null,
    })
    .returning();
  await inputAudit(tx, ctx, request.id, {
    event: "review_input_asked",
    inputRequestId: created.id,
  });
  return { ...created, replayed: false };
}

export async function askReviewInput(ctx: ActorContext, raw: unknown) {
  const data = parseInput(askReviewInputSchema, raw);
  return withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockUnresolvedRequest(tx, data.requestId);
      const { replayed, ...created } = await askReviewInputInTx(
        tx,
        ctx,
        request,
        data,
      );
      if (!replayed) await bumpRequest(tx, request);
      return {
        inputRequest: created,
        rowVersion: request.rowVersion + Number(!replayed),
        replayed,
      };
    }),
  );
}

async function inputAudit(
  tx: Tx,
  ctx: {
    actorId: string;
    actingView: "contributor" | "administrator" | "requester";
    visitorId?: string;
  },
  requestId: string,
  event: {
    event: string;
    inputRequestId: string;
    responseId?: string;
    assigneeActorId?: string | null;
    resolutionId?: string;
  },
) {
  const { event: eventType, ...payload } = event;
  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType,
    subjectId: requestId,
    payload,
  });
}

export async function assignReviewInputInTx(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  raw: unknown,
) {
  if (ctx.actingView !== "administrator")
    throw new WorkflowError("NOT_OWNER", "administrator allocation");
  const data = parseInput(assignReviewInputSchema, raw);
  if (data.requestId !== request.id)
    throw new WorkflowError("NOT_FOUND", "request");
  await requireUnresolved(tx, request);
  await requireActor(tx, ctx.actorId);
  requireVersion(data.expectedRowVersion, request.rowVersion);
  const input = await inputForRequest(tx, request.id, data.inputRequestId);
  await requireCurrent(tx, input, request);
  requireVersion(data.expectedInputVersion, input.rowVersion);
  if (input.audience !== "internal")
    throw new WorkflowError(
      "INVALID_STATE",
      "requester questions cannot be allocated",
    );
  if (data.assigneeActorId) await activeActor(tx, data.assigneeActorId);
  const [updated] = await tx
    .update(reviewInputRequests)
    .set({
      assigneeActorId: data.assigneeActorId,
      assignedByActorId: ctx.actorId,
      rowVersion: input.rowVersion + 1,
      updatedAt: nowIso(),
    })
    .where(eq(reviewInputRequests.id, input.id))
    .returning();
  await inputAudit(tx, ctx, request.id, {
    event: "review_input_assigned",
    inputRequestId: input.id,
    assigneeActorId: data.assigneeActorId,
  });
  return updated;
}

export async function assignReviewInput(ctx: ActorContext, raw: unknown) {
  const data = parseInput(assignReviewInputSchema, raw);
  return withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockUnresolvedRequest(tx, data.requestId);
      const inputRequest = await assignReviewInputInTx(tx, ctx, request, data);
      await bumpRequest(tx, request);
      return { inputRequest, rowVersion: request.rowVersion + 1 };
    }),
  );
}

async function answerIdentity(
  tx: Tx,
  ctx: ReviewInputAnswerContext,
  request: RequestRow,
  input: InputRow,
) {
  if (ctx.actingView === "requester") {
    const visitor = await requireVisitor(tx, ctx.visitorId);
    if (
      input.audience !== "requester" ||
      request.ownerVisitorId !== visitor.id
    ) {
      throw new WorkflowError("NOT_OWNER", "requester question");
    }
    return {
      actorId: visitor.actorId,
      visitorId: visitor.id,
      actingView: ctx.actingView,
    };
  }
  requireInternal(ctx);
  await requireActor(tx, ctx.actorId);
  if (input.audience !== "internal" || input.assigneeActorId !== ctx.actorId) {
    throw new WorkflowError("NOT_OWNER", "addressed contributor");
  }
  return ctx;
}

async function responseContribution(
  tx: Tx,
  ctx: Awaited<ReturnType<typeof answerIdentity>>,
  request: RequestRow,
  data: { input: InputRow; proposal: AnswerInput["proposal"] },
) {
  if (!data.proposal) return null;
  if (
    data.input.area !== "rice" ||
    (data.input.factor && data.input.factor !== data.proposal.factor)
  ) {
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "estimate does not answer the requested factor",
    );
  }
  const ids = await submitPriorityProposals(tx, ctx, request, {
    source: ctx.actingView === "requester" ? "requester" : "contributor",
    proposals: [data.proposal],
  });
  return ids[0];
}

async function sameAnswer(
  tx: Tx,
  prior: ResponseRow,
  data: AnswerInput,
  actorId: string,
) {
  if (
    prior.inputRequestId !== data.inputRequestId ||
    prior.respondentActorId !== actorId ||
    prior.answer !== data.answer ||
    prior.outcome !== data.outcome
  )
    return false;
  if (!prior.contributionId) return !data.proposal;
  const [proposal] = await tx
    .select()
    .from(priorityContributions)
    .where(eq(priorityContributions.id, prior.contributionId));
  return Boolean(
    proposal &&
    data.proposal &&
    proposal.factor === data.proposal.factor &&
    isDeepStrictEqual(proposal.estimate, data.proposal.estimate),
  );
}

export async function answerReviewInputInTx(
  tx: Tx,
  ctx: ReviewInputAnswerContext,
  request: RequestRow,
  raw: unknown,
) {
  const data = parseInput(answerReviewInputSchema, raw);
  if (data.requestId !== request.id)
    throw new WorkflowError("NOT_FOUND", "request");
  await requireUnresolved(tx, request);
  const input = await inputForRequest(tx, request.id, data.inputRequestId);
  const actor = await answerIdentity(tx, ctx, request, input);
  const [prior] = await tx
    .select()
    .from(reviewInputResponses)
    .where(eq(reviewInputResponses.id, data.responseId))
    .limit(1);
  if (prior) {
    if (!(await sameAnswer(tx, prior, data, actor.actorId)))
      throw new WorkflowError("VERSION_CONFLICT", "response id was reused");
    return { inputRequest: input, response: prior, replayed: true };
  }
  await requireCurrent(tx, input, request);
  requireVersion(data.expectedRowVersion, request.rowVersion);
  requireVersion(data.expectedInputVersion, input.rowVersion);
  const contributionId = await responseContribution(tx, actor, request, {
    input,
    proposal: data.proposal,
  });
  const [response] = await tx
    .insert(reviewInputResponses)
    .values({
      id: data.responseId,
      inputRequestId: input.id,
      inputVersion: input.rowVersion + 1,
      revisionId: request.currentRevisionId,
      requestGeneration: request.fixtureGeneration,
      answer: data.answer,
      outcome: data.outcome,
      respondentActorId: actor.actorId,
      recordedByActorId: actor.actorId,
      visitorId: actor.visitorId,
      contributionId,
    })
    .returning();
  const [updated] = await tx
    .update(reviewInputRequests)
    .set({
      state: "answered",
      rowVersion: input.rowVersion + 1,
      updatedAt: nowIso(),
    })
    .where(eq(reviewInputRequests.id, input.id))
    .returning();
  await inputAudit(tx, actor, request.id, {
    event: "review_input_answered",
    inputRequestId: input.id,
    responseId: response.id,
  });
  return { inputRequest: updated, response, replayed: false };
}

export async function answerReviewInput(
  ctx: ReviewInputAnswerContext,
  raw: unknown,
) {
  const data = parseInput(answerReviewInputSchema, raw);
  return withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockUnresolvedRequest(tx, data.requestId);
      const result = await answerReviewInputInTx(tx, ctx, request, data);
      if (!result.replayed) await bumpRequest(tx, request);
      return {
        ...result,
        rowVersion: request.rowVersion + Number(!result.replayed),
      };
    }),
  );
}

async function latestResponse(tx: Tx, inputRequestId: string) {
  const [response] = await tx
    .select()
    .from(reviewInputResponses)
    .where(eq(reviewInputResponses.inputRequestId, inputRequestId))
    .orderBy(desc(reviewInputResponses.inputVersion))
    .limit(1);
  return response;
}

async function candidateResolution(
  tx: Tx,
  request: RequestRow,
  input: InputRow,
  resolution: { id: string; answeredAt: string },
) {
  if (input.area !== "assets" || !input.candidateId) return false;
  const [row] = await tx
    .select({ decision: assetCandidateDecisions, assessment: assetAssessments })
    .from(assetCandidates)
    .innerJoin(
      assetCandidateDecisions,
      eq(assetCandidates.currentDecisionId, assetCandidateDecisions.id),
    )
    .innerJoin(
      assetAssessments,
      eq(assetCandidates.assessmentId, assetAssessments.id),
    )
    .where(
      and(
        eq(assetCandidates.id, input.candidateId),
        eq(assetCandidateDecisions.id, resolution.id),
        gte(assetCandidateDecisions.createdAt, resolution.answeredAt),
      ),
    )
    .limit(1);
  if (!row || !["accepted", "rejected"].includes(row.decision.decision))
    return false;
  requireTargetAssessment(row.assessment, request);
  return row.decision.requestGeneration === request.fixtureGeneration;
}

async function riskResolution(
  tx: Tx,
  request: RequestRow,
  input: InputRow,
  resolution: { id: string; answeredAt: string },
) {
  if (input.area !== "risk" || !input.findingId) return false;
  const [row] = await tx
    .select({ decision: riskFindingDecisions, assessment: riskAssessments })
    .from(riskFindings)
    .innerJoin(
      riskFindingDecisions,
      eq(riskFindings.currentDecisionId, riskFindingDecisions.id),
    )
    .innerJoin(
      riskAssessments,
      eq(riskFindings.assessmentId, riskAssessments.id),
    )
    .where(
      and(
        eq(riskFindings.id, input.findingId),
        eq(riskFindingDecisions.id, resolution.id),
        gte(riskFindingDecisions.createdAt, resolution.answeredAt),
      ),
    )
    .limit(1);
  if (!row || row.decision.decision === "follow_up_required") return false;
  requireTargetAssessment(row.assessment, request);
  return row.decision.requestGeneration === request.fixtureGeneration;
}

async function areaResolution(
  tx: Tx,
  request: RequestRow,
  input: InputRow,
  resolution: { id: string; answeredAt: string },
) {
  if (input.area === "rice" || input.candidateId || input.findingId)
    return false;
  const [task] = await tx
    .select()
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.id, resolution.id),
        eq(reviewTasks.requestId, request.id),
        eq(reviewTasks.area, input.area),
        eq(reviewTasks.state, "completed"),
        gte(reviewTasks.completedAt, resolution.answeredAt),
      ),
    )
    .limit(1);
  if (!task?.completedAssessmentId) return false;
  const table = input.area === "assets" ? assetAssessments : riskAssessments;
  const [assessment] = await tx
    .select()
    .from(table)
    .where(eq(table.id, task.completedAssessmentId))
    .limit(1);
  requireTargetAssessment(assessment, request);
  return true;
}

async function resolutionSatisfied(
  tx: Tx,
  request: RequestRow,
  input: InputRow,
  data: { resolution: ResolutionInput; response: ResponseRow },
) {
  const { resolution, response } = data;
  const judgment = {
    id: resolution.resolutionId,
    answeredAt: response.createdAt,
  };
  switch (resolution.resolutionKind) {
    case "candidate_decision":
      return candidateResolution(tx, request, input, judgment);
    case "risk_decision":
      return riskResolution(tx, request, input, judgment);
    case "area_outcome":
      return areaResolution(tx, request, input, judgment);
    case "priority_contribution": {
      if (
        input.area !== "rice" ||
        response.contributionId !== resolution.resolutionId
      )
        return false;
      const priority = await readPriority(tx, request.id);
      return priority.factors.some(
        (factor) =>
          (!input.factor || factor.factor === input.factor) &&
          factor.reviewed?.proposalId === response.contributionId,
      );
    }
  }
}

// The caller commits the corresponding judgment and this resolution in one transaction.
export async function resolveReviewInputInTx(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  raw: unknown,
) {
  requireInternal(ctx);
  const data = parseInput(resolveReviewInputSchema, raw);
  await requireUnresolved(tx, request);
  await requireActor(tx, ctx.actorId);
  const input = await inputForRequest(tx, request.id, data.inputRequestId);
  await requireCurrent(tx, input, request);
  requireVersion(data.expectedInputVersion, input.rowVersion);
  const response = await latestResponse(tx, input.id);
  if (
    !response ||
    response.id !== data.responseId ||
    response.outcome !== "provided" ||
    !isCurrentReviewInput(response, request)
  ) {
    throw new WorkflowError(
      "APPROVAL_BLOCKED",
      "a current relevant answer is required",
    );
  }
  if (
    !(await resolutionSatisfied(tx, request, input, {
      resolution: data,
      response,
    }))
  ) {
    throw new WorkflowError(
      "APPROVAL_BLOCKED",
      "the corresponding judgment has not satisfied the input request",
    );
  }
  const [updated] = await tx
    .update(reviewInputRequests)
    .set({
      state: "resolved",
      rowVersion: input.rowVersion + 1,
      resolvedByActorId: ctx.actorId,
      resolvedAt: nowIso(),
      updatedAt: nowIso(),
      resolutionKind: data.resolutionKind,
      resolutionId: data.resolutionId,
    })
    .where(eq(reviewInputRequests.id, input.id))
    .returning();
  await inputAudit(tx, ctx, request.id, {
    event: "review_input_resolved",
    inputRequestId: input.id,
    resolutionId: data.resolutionId,
  });
  return updated;
}

export async function readReviewInputs(
  reader: Db | Tx,
  requestId: string,
  options: { audience?: "requester" } = {},
) {
  const [request] = await reader
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);
  if (!request) throw new WorkflowError("NOT_FOUND", "request");
  const rows = await reader
    .select({
      input: reviewInputRequests,
      candidateAssessmentId: assetCandidates.assessmentId,
      findingAssessmentId: riskFindings.assessmentId,
    })
    .from(reviewInputRequests)
    .leftJoin(
      assetCandidates,
      eq(assetCandidates.id, reviewInputRequests.candidateId),
    )
    .leftJoin(riskFindings, eq(riskFindings.id, reviewInputRequests.findingId))
    .where(
      and(
        eq(reviewInputRequests.requestId, requestId),
        options.audience
          ? eq(reviewInputRequests.audience, options.audience)
          : undefined,
      ),
    )
    .orderBy(asc(reviewInputRequests.createdAt));
  const inputs = rows.map(({ input, ...target }) => ({ ...input, ...target }));
  if (!inputs.length) return [];
  const currency = inputs.some((input) => input.candidateId || input.findingId)
    ? await inputAssessmentCurrency(reader, request)
    : undefined;
  const responses = await reader
    .select()
    .from(reviewInputResponses)
    .where(
      inArray(
        reviewInputResponses.inputRequestId,
        inputs.map((input) => input.id),
      ),
    )
    .orderBy(asc(reviewInputResponses.inputVersion));
  const names = await reader
    .select({ id: actors.id, name: actors.displayName })
    .from(actors);
  const name = (id: string | null) =>
    names.find((actor) => actor.id === id)?.name ?? null;
  return inputs.map((input) => {
    const replies = responses
      .filter((response) => response.inputRequestId === input.id)
      .map((response) => ({
        ...response,
        respondentName: name(response.respondentActorId),
        recordedByName: name(response.recordedByActorId),
      }));
    return {
      ...input,
      current: isCurrentReviewInput(input, request, currency),
      askedByName: name(input.askedByActorId),
      assigneeName: name(input.assigneeActorId),
      assignedByName: name(input.assignedByActorId),
      resolvedByName: name(input.resolvedByActorId),
      responses: replies,
      latestResponse: replies.at(-1) ?? null,
    };
  });
}

export type ReviewInputView = Awaited<
  ReturnType<typeof readReviewInputs>
>[number];
