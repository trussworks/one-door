import { z } from "zod";

export const priorityFactors = [
  "reach",
  "impact",
  "confidence",
  "effort",
] as const;
export type PriorityFactor = (typeof priorityFactors)[number];

export const priorityEstimateSchema = z
  .object({
    value: z.number().finite().nullable(),
    basis: z.string().trim().max(1000),
    unit: z.string().trim().max(80).optional(),
    period: z.string().trim().max(80).optional(),
    assumptions: z.string().trim().max(1000).optional(),
  })
  .strict();
export type PriorityEstimate = z.infer<typeof priorityEstimateSchema>;

const factorValues = {
  reach: z
    .number()
    .finite()
    .nonnegative()
    .max(999999999999.99)
    .multipleOf(0.01),
  impact: z.number().finite().positive().max(1000).multipleOf(0.01),
  confidence: z.number().finite().gt(0).max(1).multipleOf(0.0001),
  effort: z.number().finite().positive().max(10000).multipleOf(0.01),
};

export function priorityEstimateErrors(
  factor: PriorityFactor,
  estimate: PriorityEstimate,
  reviewed: boolean,
): string[] {
  const errors = estimateBasisErrors(factor, estimate, reviewed);
  if (estimate.value === null) {
    if (reviewed) errors.push("a reviewed estimate needs a value");
  } else if (!factorValues[factor].safeParse(estimate.value).success) {
    errors.push("value is outside the supported range or precision");
  }
  return errors;
}

function estimateBasisErrors(
  factor: PriorityFactor,
  estimate: PriorityEstimate,
  reviewed: boolean,
): string[] {
  const errors: string[] = [];
  if (reviewed && !estimate.basis.trim())
    errors.push("explain the estimate's basis");
  if (reviewed && factor === "reach" && !hasReachBasis(estimate)) {
    errors.push("reach needs a unit and period");
  }
  if (factor !== "reach" && (estimate.unit || estimate.period)) {
    errors.push("unit and period belong to reach only");
  }
  return errors;
}

function hasReachBasis(estimate: PriorityEstimate): boolean {
  return Boolean(estimate.unit?.trim() && estimate.period?.trim());
}

export const priorityProposalSchema = z
  .object({
    factor: z.enum(priorityFactors),
    estimate: priorityEstimateSchema,
    suppliedByActorId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    for (const message of priorityEstimateErrors(
      proposal.factor,
      proposal.estimate,
      false,
    )) {
      ctx.addIssue({ code: "custom", path: ["estimate"], message });
    }
  });
export type PriorityProposalInput = z.infer<typeof priorityProposalSchema>;

export const priorityDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      factor: z.enum(priorityFactors),
      action: z.literal("adopt"),
      proposalId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      factor: z.enum(priorityFactors),
      action: z.literal("replace"),
      proposalId: z.string().uuid().optional(),
      estimate: priorityEstimateSchema,
      suppliedByActorId: z.string().uuid().optional(),
      reason: z.string().trim().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      factor: z.enum(priorityFactors),
      action: z.literal("reject"),
      proposalId: z.string().uuid().optional(),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export type PriorityDecisionInput = z.infer<typeof priorityDecisionSchema>;

export const priorityDecisionsSchema = z
  .array(priorityDecisionSchema)
  .max(4)
  .superRefine((decisions, ctx) => {
    if (
      new Set(decisions.map((item) => item.factor)).size !== decisions.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "review each factor once per submission",
      });
    }
  });

export interface PriorityProposal {
  id: string;
  factor: PriorityFactor;
  estimate: PriorityEstimate;
  source: "requester" | "contributor";
  suppliedByActorId: string;
  recordedByActorId: string;
  createdAt: string;
  current: boolean;
}

export interface PriorityDecision {
  id: string;
  factor: PriorityFactor;
  action: PriorityDecisionInput["action"];
  proposalId: string | null;
  estimate: PriorityEstimate | null;
  suppliedByActorId: string | null;
  recordedByActorId: string;
  reviewerActorId: string;
  reason: string | null;
  createdAt: string;
  current: boolean;
}

export interface ReviewedPriorityEstimate {
  estimate: PriorityEstimate;
  proposalId: string | null;
  decisionId: string | null;
  scoreId: string | null;
  suppliedByActorId: string;
  recordedByActorId: string;
  reviewerActorId: string | null;
  source: "reviewed_contribution" | "existing_score";
}

export interface PriorityFactorView {
  factor: PriorityFactor;
  status: "missing" | "proposed" | "reviewed" | "rejected";
  proposals: PriorityProposal[];
  decisions: PriorityDecision[];
  reviewed: ReviewedPriorityEstimate | null;
}

export interface PriorityView {
  factors: PriorityFactorView[];
  complete: boolean;
  scoreId: string | null;
  score: number | null;
}
