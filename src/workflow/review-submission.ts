import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetCandidates,
  auditEvents,
  requests,
  reviewTasks,
  riskFindings,
} from "../db/schema.ts";
import { priorityDecisionsSchema } from "../domain/priority.ts";
import { completeFirstReviewInTx, completeSchema } from "./delivery.ts";
import { WorkflowError } from "./errors.ts";
import { applyPriorityDecisions, readPriority } from "./priority.ts";
import {
  readReviewInputs,
  resolveReviewInputInTx,
  type ReviewInputView,
} from "./review-inputs.ts";
import {
  assetDecisionSchema,
  recordAssetOutcomeInTx,
  recordRiskOutcomeInTx,
  riskDecisionSchema,
  saveAssetDecisionInTx,
  saveRiskDecisionInTx,
} from "./review.ts";
import {
  insertAudit,
  lockRequest,
  lockUnresolvedRequest,
  nowIso,
  parseInput,
  requireActor,
  requireUnresolved,
  requireVersion,
  uuidSchema,
  withDb,
  type ActorContext,
  type Tx,
} from "./shared.ts";

export const reviewSubmissionSchema = z
  .object({
    requestId: uuidSchema,
    expectedRowVersion: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(120),
    assetDecisions: z
      .array(
        assetDecisionSchema.omit({ requestId: true, expectedRowVersion: true }),
      )
      .max(100)
      .default([]),
    assetOutcome: z.enum(["accepted", "no_match"]).optional(),
    riskDecisions: z
      .array(
        riskDecisionSchema.omit({ requestId: true, expectedRowVersion: true }),
      )
      .max(200)
      .default([]),
    riskOutcome: z.boolean().default(false),
    priorityDecisions: priorityDecisionsSchema.default([]),
    complete: completeSchema
      .omit({ requestId: true, expectedRowVersion: true, idempotencyKey: true })
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      new Set(data.assetDecisions.map((item) => item.candidateId)).size !==
      data.assetDecisions.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["assetDecisions"],
        message: "review each option once per submission",
      });
    if (
      new Set(data.riskDecisions.map((item) => item.findingId)).size !==
      data.riskDecisions.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["riskDecisions"],
        message: "review each finding once per submission",
      });
  });

export type ReviewSubmissionInput = z.input<typeof reviewSubmissionSchema>;

const resultSchema = z.object({
  requestId: uuidSchema,
  rowVersion: z.number().int().positive(),
  completed: z.boolean(),
});

export async function submitAssessment(ctx: ActorContext, input: unknown) {
  const data = parseInput(reviewSubmissionSchema, input);
  return withDb((db) =>
    db.transaction((tx) => submitAssessmentInTx(tx, ctx, data)),
  );
}

async function submissionReplay(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  identity: { key: string; hash: string },
) {
  const [prior] = await tx
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.subjectId, request.id),
        eq(auditEvents.actorId, ctx.actorId),
        eq(auditEvents.eventType, "review_submitted"),
        sql`${auditEvents.payload}->>'idempotencyKey' = ${identity.key}`,
        sql`${auditEvents.payload}->>'generation' = ${String(request.fixtureGeneration)}`,
      ),
    )
    .limit(1);
  if (!prior) return null;
  if (prior.payload.inputHash !== identity.hash)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "submission key was already used for different changes",
    );
  return parseInput(resultSchema, prior.payload.result);
}

async function recordReviewDecisions(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  data: Submission,
) {
  let rowVersion = request.rowVersion;
  for (const decision of data.assetDecisions)
    ({ rowVersion } = await saveAssetDecisionInTx(tx, ctx, {
      ...decision,
      requestId: request.id,
      expectedRowVersion: rowVersion,
    }));
  if (data.assetOutcome)
    ({ rowVersion } = await recordAssetOutcomeInTx(tx, ctx, {
      requestId: request.id,
      outcome: data.assetOutcome,
      expectedRowVersion: rowVersion,
    }));
  for (const decision of data.riskDecisions)
    ({ rowVersion } = await saveRiskDecisionInTx(tx, ctx, {
      ...decision,
      requestId: request.id,
      expectedRowVersion: rowVersion,
    }));
  if (data.riskOutcome)
    await recordRiskOutcomeInTx(tx, ctx, {
      requestId: request.id,
      expectedRowVersion: rowVersion,
    });
}

async function submitAssessmentInTx(
  tx: Tx,
  ctx: ActorContext,
  data: Submission,
) {
  await requireActor(tx, ctx.actorId);
  let request = await lockRequest(tx, data.requestId);
  const inputHash = createHash("sha256")
    .update(JSON.stringify({ ...data, expectedRowVersion: undefined }))
    .digest("hex");
  const replay = await submissionReplay(tx, ctx, request, {
    key: data.idempotencyKey,
    hash: inputHash,
  });
  if (replay) return replay;
  await requireUnresolved(tx, request);
  requireVersion(data.expectedRowVersion, request.rowVersion);
  await recordReviewDecisions(tx, ctx, request, data);
  request = await lockUnresolvedRequest(tx, request.id);
  if (data.priorityDecisions.length)
    await applyPriorityDecisions(tx, ctx, request, data.priorityDecisions);
  await settleAnsweredInputs(tx, ctx, request, data);
  await tx
    .update(requests)
    .set({ rowVersion: request.rowVersion + 1, updatedAt: nowIso() })
    .where(eq(requests.id, request.id));
  if (data.complete)
    await completeFirstReviewInTx(tx, ctx, {
      ...data.complete,
      requestId: request.id,
      idempotencyKey: data.idempotencyKey,
      expectedRowVersion: request.rowVersion + 1,
    });
  const updated = await lockUnresolvedRequest(tx, request.id);
  const result = {
    requestId: updated.id,
    rowVersion: updated.rowVersion,
    completed: updated.stage === "first_review_completed",
  };
  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType: "review_submitted",
    subjectId: request.id,
    payload: {
      idempotencyKey: data.idempotencyKey,
      inputHash,
      generation: request.fixtureGeneration,
      result,
    },
  });
  return result;
}

type Submission = z.output<typeof reviewSubmissionSchema>;
type RequestRow = typeof requests.$inferSelect;
type Resolution = {
  resolutionKind:
    | "candidate_decision"
    | "risk_decision"
    | "priority_contribution"
    | "area_outcome";
  resolutionId: string;
};

async function priorityInputResolution(
  tx: Tx,
  input: ReviewInputView,
  data: Submission,
): Promise<Resolution | null> {
  if (
    !data.priorityDecisions.some((decision) => decision.factor === input.factor)
  )
    return null;
  const priority = await readPriority(tx, input.requestId);
  const proposalId = priority.factors.find(
    (factor) => factor.factor === input.factor,
  )?.reviewed?.proposalId;
  return proposalId && proposalId === input.latestResponse?.contributionId
    ? { resolutionKind: "priority_contribution", resolutionId: proposalId }
    : null;
}

async function riskInputResolution(
  tx: Tx,
  input: ReviewInputView,
  data: Submission,
): Promise<Resolution | null> {
  if (
    !input.findingId ||
    !data.riskDecisions.some(
      (decision) =>
        decision.findingId === input.findingId &&
        decision.decision !== "follow_up_required",
    )
  )
    return null;
  const [finding] = await tx
    .select({ id: riskFindings.currentDecisionId })
    .from(riskFindings)
    .where(eq(riskFindings.id, input.findingId));
  return finding?.id
    ? { resolutionKind: "risk_decision", resolutionId: finding.id }
    : null;
}

async function candidateInputResolution(
  tx: Tx,
  input: ReviewInputView,
  data: Submission,
): Promise<Resolution | null> {
  if (
    !input.candidateId ||
    !data.assetDecisions.some(
      (decision) => decision.candidateId === input.candidateId,
    )
  )
    return null;
  const [candidate] = await tx
    .select({ id: assetCandidates.currentDecisionId })
    .from(assetCandidates)
    .where(eq(assetCandidates.id, input.candidateId));
  return candidate?.id
    ? { resolutionKind: "candidate_decision", resolutionId: candidate.id }
    : null;
}

async function areaInputResolution(
  tx: Tx,
  input: ReviewInputView,
  data: Submission,
): Promise<Resolution | null> {
  const recorded =
    input.area === "assets"
      ? Boolean(data.assetOutcome)
      : input.area === "risk" && data.riskOutcome;
  if (!recorded) return null;
  const [task] = await tx
    .select({ id: reviewTasks.id })
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.requestId, input.requestId),
        eq(reviewTasks.area, input.area),
      ),
    );
  return task
    ? { resolutionKind: "area_outcome", resolutionId: task.id }
    : null;
}

function inputResolution(
  tx: Tx,
  input: ReviewInputView,
  data: Submission,
): Promise<Resolution | null> {
  if (input.area === "rice") return priorityInputResolution(tx, input, data);
  if (input.findingId) return riskInputResolution(tx, input, data);
  if (input.candidateId) return candidateInputResolution(tx, input, data);
  return areaInputResolution(tx, input, data);
}

async function settleAnsweredInputs(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  data: Submission,
) {
  const inputs = await readReviewInputs(tx, request.id);
  for (const input of inputs) {
    if (
      !input.current ||
      input.state === "resolved" ||
      input.latestResponse?.outcome !== "provided"
    )
      continue;
    const resolution = await inputResolution(tx, input, data);
    if (!resolution) continue;
    await resolveReviewInputInTx(tx, ctx, request, {
      inputRequestId: input.id,
      expectedInputVersion: input.rowVersion,
      responseId: input.latestResponse.id,
      ...resolution,
    });
  }
}
