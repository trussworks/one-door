import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  priorityContributions,
  priorityDecisions,
} from "../db/schema/priority.ts";
import { actors, requests, reviewTasks, riceScores } from "../db/schema.ts";
import {
  priorityDecisionsSchema,
  priorityEstimateErrors,
  priorityFactors,
  priorityProposalSchema,
  type PriorityDecision,
  type PriorityDecisionInput,
  type PriorityEstimate,
  type PriorityFactor,
  type PriorityFactorView,
  type PriorityProposal,
  type PriorityView,
  type ReviewedPriorityEstimate,
} from "../domain/priority.ts";
import { WorkflowError } from "./errors.ts";
import {
  insertAudit,
  lockUnresolvedRequest,
  newId,
  nowIso,
  parseInput,
  requireUnresolved,
  requireVersion,
  withDb,
  type ActorContext,
  type Tx,
} from "./shared.ts";

type RequestRow = typeof requests.$inferSelect;
type ContributionRow = typeof priorityContributions.$inferSelect;
type DecisionRow = typeof priorityDecisions.$inferSelect;
type ScoreRow = typeof riceScores.$inferSelect;
type PriorityActor = Omit<ActorContext, "actingView"> & {
  actingView: ActorContext["actingView"] | "requester";
};

async function requireHumanActor(tx: Tx, actorId: string) {
  const [actor] = await tx
    .select({ kind: actors.kind })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  if (!actor) throw new WorkflowError("NOT_FOUND", "actor");
  if (actor.kind === "system")
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "priority estimates must be supplied and reviewed by a person",
    );
}

function isCurrent(
  request: RequestRow,
  row: { revisionId: string | null; requestGeneration: number },
) {
  return (
    row.revisionId === request.currentRevisionId &&
    row.requestGeneration === request.fixtureGeneration
  );
}

function contributionView(
  request: RequestRow,
  row: ContributionRow,
): PriorityProposal {
  return { ...row, current: isCurrent(request, row) };
}

function decisionView(request: RequestRow, row: DecisionRow): PriorityDecision {
  return { ...row, current: isCurrent(request, row) };
}

function existingEstimate(
  score: ScoreRow,
  factor: PriorityFactor,
): ReviewedPriorityEstimate {
  const estimate: PriorityEstimate = {
    value: Number(score[factor]),
    basis: score[`${factor}Rationale`],
  };
  if (factor === "reach") {
    estimate.unit = score.reachUnit;
    estimate.period = score.reachPeriod;
  }
  return {
    estimate,
    proposalId: null,
    decisionId: null,
    scoreId: score.id,
    suppliedByActorId: score[`${factor}ActorId`],
    recordedByActorId: score.createdByActorId,
    reviewerActorId: null,
    source: "existing_score",
  };
}

function applyDecisionToView(
  reviewed: ReviewedPriorityEstimate | null,
  decision: PriorityDecision,
): ReviewedPriorityEstimate | null {
  if (decision.action === "reject") {
    return !decision.proposalId || decision.proposalId === reviewed?.proposalId
      ? null
      : reviewed;
  }
  if (!decision.estimate || !decision.suppliedByActorId) {
    throw new WorkflowError(
      "INVALID_STATE",
      "reviewed priority value is missing",
    );
  }
  return {
    estimate: decision.estimate,
    proposalId: decision.proposalId,
    decisionId: decision.id,
    scoreId: null,
    suppliedByActorId: decision.suppliedByActorId,
    recordedByActorId: decision.recordedByActorId,
    reviewerActorId: decision.reviewerActorId,
    source: "reviewed_contribution",
  };
}

function factorStatus(
  reviewed: ReviewedPriorityEstimate | null,
  proposals: PriorityProposal[],
  decisions: PriorityDecision[],
): PriorityFactorView["status"] {
  if (reviewed) return "reviewed";
  if (
    proposals.some(
      (proposal) =>
        !decisions.some((decision) => decision.proposalId === proposal.id),
    )
  )
    return "proposed";
  if (decisions.some((decision) => decision.action === "reject"))
    return "rejected";
  return proposals.length ? "proposed" : "missing";
}

function factorView(
  factor: PriorityFactor,
  proposals: PriorityProposal[],
  decisions: PriorityDecision[],
  baseScore: ScoreRow | null,
): PriorityFactorView {
  const factorProposals = proposals.filter(
    (proposal) => proposal.factor === factor,
  );
  const factorDecisions = decisions.filter(
    (decision) => decision.factor === factor,
  );
  const currentDecisions = factorDecisions.filter(
    (decision) => decision.current,
  );
  const initial = baseScore ? existingEstimate(baseScore, factor) : null;
  const reviewed = currentDecisions.reduce(applyDecisionToView, initial);
  return {
    factor,
    status: factorStatus(
      reviewed,
      factorProposals.filter((proposal) => proposal.current),
      currentDecisions,
    ),
    proposals: factorProposals,
    decisions: factorDecisions,
    reviewed,
  };
}

async function scoreById(
  tx: Tx,
  request: RequestRow,
  scoreId: string | null,
): Promise<ScoreRow | null> {
  if (!scoreId) return null;
  const [score] = await tx
    .select()
    .from(riceScores)
    .where(
      and(eq(riceScores.id, scoreId), eq(riceScores.requestId, request.id)),
    )
    .limit(1);
  if (
    !score ||
    (score.origin !== "fixture" &&
      score.requestGeneration !== request.fixtureGeneration)
  )
    return null;
  return score;
}

async function priorityRecords(tx: Tx, request: RequestRow) {
  const proposals = await tx
    .select()
    .from(priorityContributions)
    .where(eq(priorityContributions.requestId, request.id))
    .orderBy(
      asc(priorityContributions.createdAt),
      asc(priorityContributions.id),
    );
  const decisions = await tx
    .select()
    .from(priorityDecisions)
    .where(eq(priorityDecisions.requestId, request.id))
    .orderBy(asc(priorityDecisions.sequence));
  const firstCurrent = decisions.find((decision) =>
    isCurrent(request, decision),
  );
  // Retain the actual old snapshot as the baseline after an edited factor
  // invalidates its pointer. This is evidence of entry, not a fabricated approval.
  const baseScoreId = firstCurrent
    ? firstCurrent.baseScoreId
    : request.currentRiceScoreId;
  const baseScore = await scoreById(tx, request, baseScoreId);
  return { proposals, decisions, baseScore, baseScoreId };
}

export async function readPriority(
  tx: Tx,
  requestId: string,
): Promise<PriorityView> {
  const [request] = await tx
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);
  if (!request) throw new WorkflowError("NOT_FOUND", "request");
  const records = await priorityRecords(tx, request);
  const proposals = records.proposals.map((row) =>
    contributionView(request, row),
  );
  const decisions = records.decisions.map((row) => decisionView(request, row));
  const factors = priorityFactors.map((factor) =>
    factorView(factor, proposals, decisions, records.baseScore),
  );
  const currentScore = await scoreById(tx, request, request.currentRiceScoreId);
  const complete = factors.every((factor) => factor.reviewed !== null);
  return {
    factors,
    complete,
    scoreId: complete ? (currentScore?.id ?? null) : null,
    score: complete && currentScore ? Number(currentScore.score) : null,
  };
}

const proposalsSchema = z
  .object({
    source: z.enum(["requester", "contributor"]),
    proposals: z.array(priorityProposalSchema).max(4),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      new Set(data.proposals.map((proposal) => proposal.factor)).size !==
      data.proposals.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "supply each factor once per submission",
      });
    }
  });

/** Caller holds the request lock and owns the enclosing transaction/version bump. */
export async function submitPriorityProposals(
  tx: Tx,
  ctx: PriorityActor,
  request: RequestRow,
  input: unknown,
): Promise<string[]> {
  const data = parseInput(proposalsSchema, input);
  await requireHumanActor(tx, ctx.actorId);
  await requireUnresolved(tx, request);
  if (data.source === "requester" && ctx.actorId !== request.requesterActorId) {
    throw new WorkflowError("NOT_OWNER", "requester priority contribution");
  }
  const ids: string[] = [];
  for (const proposal of data.proposals) {
    const supplier = proposal.suppliedByActorId ?? ctx.actorId;
    if (data.source === "requester" && supplier !== ctx.actorId) {
      throw new WorkflowError(
        "VALIDATION_FAILED",
        "requester records their own contribution",
      );
    }
    await requireHumanActor(tx, supplier);
    const id = newId();
    await tx.insert(priorityContributions).values({
      id,
      requestId: request.id,
      revisionId: request.currentRevisionId,
      requestGeneration: request.fixtureGeneration,
      factor: proposal.factor,
      estimate: proposal.estimate,
      source: data.source,
      suppliedByActorId: supplier,
      recordedByActorId: ctx.actorId,
    });
    ids.push(id);
  }
  return ids;
}

function proposalForDecision(
  request: RequestRow,
  proposals: ContributionRow[],
  decision: PriorityDecisionInput,
): ContributionRow | null {
  if (!decision.proposalId) return null;
  const proposal = proposals.find(
    (row) => row.id === decision.proposalId && row.factor === decision.factor,
  );
  if (!proposal) throw new WorkflowError("NOT_FOUND", "priority proposal");
  if (!isCurrent(request, proposal))
    throw new WorkflowError(
      "VERSION_CONFLICT",
      "priority proposal belongs to an earlier request revision",
    );
  return proposal;
}

function decisionValue(
  ctx: ActorContext,
  decision: PriorityDecisionInput,
  proposal: ContributionRow | null,
) {
  if (decision.action === "reject")
    return {
      estimate: null,
      suppliedByActorId: null,
      recordedByActorId: ctx.actorId,
    };
  if (decision.action === "adopt") {
    if (!proposal) throw new WorkflowError("NOT_FOUND", "priority proposal");
    return {
      estimate: proposal.estimate,
      suppliedByActorId: proposal.suppliedByActorId,
      recordedByActorId: proposal.recordedByActorId,
    };
  }
  return {
    estimate: decision.estimate,
    suppliedByActorId: decision.suppliedByActorId ?? ctx.actorId,
    recordedByActorId: ctx.actorId,
  };
}

async function appendDecision(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  input: {
    decision: PriorityDecisionInput;
    proposals: ContributionRow[];
    sequence: number;
    baseScoreId: string | null;
  },
) {
  const { decision } = input;
  const proposal = proposalForDecision(request, input.proposals, decision);
  const value = decisionValue(ctx, decision, proposal);
  if (value.estimate) {
    const errors = priorityEstimateErrors(
      decision.factor,
      value.estimate,
      true,
    );
    if (errors.length)
      throw new WorkflowError(
        "VALIDATION_FAILED",
        `${decision.factor}: ${errors.join("; ")}`,
      );
  }
  if (value.suppliedByActorId)
    await requireHumanActor(tx, value.suppliedByActorId);
  await tx.insert(priorityDecisions).values({
    id: newId(),
    requestId: request.id,
    revisionId: request.currentRevisionId,
    requestGeneration: request.fixtureGeneration,
    sequence: input.sequence,
    factor: decision.factor,
    action: decision.action,
    proposalId: proposal?.id ?? null,
    ...value,
    reviewerActorId: ctx.actorId,
    baseScoreId: input.baseScoreId,
    reason: "reason" in decision ? (decision.reason ?? null) : null,
  });
}

function reviewedFactors(
  view: PriorityView,
): Record<PriorityFactor, ReviewedPriorityEstimate> {
  const entries = view.factors.map((factor) => {
    if (!factor.reviewed)
      throw new WorkflowError("INVALID_STATE", "priority is incomplete");
    return [factor.factor, factor.reviewed];
  });
  return Object.fromEntries(entries) as Record<
    PriorityFactor,
    ReviewedPriorityEstimate
  >;
}

function snapshotValues(
  factors: Record<PriorityFactor, ReviewedPriorityEstimate>,
) {
  const reach = factors.reach.estimate.value!;
  const impact = factors.impact.estimate.value!;
  const confidence = factors.confidence.estimate.value!;
  const effort = factors.effort.estimate.value!;
  const score = (reach * impact * confidence) / effort;
  if (!Number.isFinite(score) || score >= 1e12)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "score exceeds supported range",
    );
  return {
    reach: String(reach),
    reachUnit: factors.reach.estimate.unit!,
    reachPeriod: factors.reach.estimate.period!,
    reachRationale: factors.reach.estimate.basis,
    reachActorId: factors.reach.suppliedByActorId,
    impact: String(impact),
    impactRationale: factors.impact.estimate.basis,
    impactActorId: factors.impact.suppliedByActorId,
    confidence: String(confidence),
    confidenceRationale: factors.confidence.estimate.basis,
    confidenceActorId: factors.confidence.suppliedByActorId,
    effort: String(effort),
    effortRationale: factors.effort.estimate.basis,
    effortActorId: factors.effort.suppliedByActorId,
    score: score.toFixed(4),
  };
}

async function saveSnapshot(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  view: PriorityView,
): Promise<string | null> {
  if (!view.complete) return null;
  const prior = await tx
    .select({ version: riceScores.version })
    .from(riceScores)
    .where(eq(riceScores.requestId, request.id));
  const id = newId();
  await tx.insert(riceScores).values({
    id,
    requestId: request.id,
    version: prior.reduce((max, row) => Math.max(max, row.version), 0) + 1,
    ...snapshotValues(reviewedFactors(view)),
    rubricVersion: "rubric-v1",
    formulaVersion: "rice-v1",
    createdByActorId: ctx.actorId,
    origin: "live",
    requestGeneration: request.fixtureGeneration,
  });
  return id;
}

async function setPriorityState(
  tx: Tx,
  requestId: string,
  scoreId: string | null,
) {
  await tx
    .update(requests)
    .set({ currentRiceScoreId: scoreId })
    .where(eq(requests.id, requestId));
  const state = scoreId ? "completed" : "in_progress";
  const completedAt = scoreId ? nowIso() : null;
  await tx
    .insert(reviewTasks)
    .values({
      id: newId(),
      requestId,
      area: "rice",
      responsibleCapability: "estimate_delivery_effort",
      state,
      completedAt,
    })
    .onConflictDoUpdate({
      target: [reviewTasks.requestId, reviewTasks.area],
      set: {
        state,
        completedAt,
        completedAssessmentId: null,
        rowVersion: sql`${reviewTasks.rowVersion} + 1`,
        updatedAt: nowIso(),
      },
    });
}

/** Caller holds the request lock; every decision and score shares that transaction. */
export async function applyPriorityDecisions(
  tx: Tx,
  ctx: ActorContext,
  request: RequestRow,
  input: unknown,
): Promise<PriorityView> {
  const decisions = parseInput(priorityDecisionsSchema, input);
  await requireHumanActor(tx, ctx.actorId);
  await requireUnresolved(tx, request);
  if (!decisions.length) return readPriority(tx, request.id);
  const records = await priorityRecords(tx, request);
  let sequence = records.decisions.at(-1)?.sequence ?? 0;
  for (const decision of decisions) {
    sequence += 1;
    await appendDecision(tx, ctx, request, {
      decision,
      proposals: records.proposals,
      sequence,
      baseScoreId: records.baseScoreId,
    });
  }
  const view = await readPriority(tx, request.id);
  const scoreId = await saveSnapshot(tx, ctx, request, view);
  await setPriorityState(tx, request.id, scoreId);
  await insertAudit(tx, {
    actorId: ctx.actorId,
    visitorId: ctx.visitorId ?? null,
    actingView: ctx.actingView,
    eventType: "priority_reviewed",
    subjectId: request.id,
    payload: { factors: decisions.map((decision) => decision.factor), scoreId },
  });
  return readPriority(tx, request.id);
}

const savePrioritySchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRowVersion: z.number().int().positive(),
    decisions: priorityDecisionsSchema.min(1),
  })
  .strict();

export async function savePriority(ctx: ActorContext, input: unknown) {
  const data = parseInput(savePrioritySchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      const request = await lockUnresolvedRequest(tx, data.requestId);
      requireVersion(data.expectedRowVersion, request.rowVersion);
      const priority = await applyPriorityDecisions(
        tx,
        ctx,
        request,
        data.decisions,
      );
      await tx
        .update(requests)
        .set({ rowVersion: request.rowVersion + 1, updatedAt: nowIso() })
        .where(eq(requests.id, request.id));
      return {
        requestId: request.id,
        rowVersion: request.rowVersion + 1,
        priority,
      };
    }),
  );
}
