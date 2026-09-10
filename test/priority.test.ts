import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  priorityDecisionsSchema,
  priorityEstimateErrors,
  priorityProposalSchema,
} from "../src/domain/priority.ts";

describe("human priority estimates", () => {
  it("accepts an unknown or evidence-only proposal without turning it into zero", () => {
    const proposal = priorityProposalSchema.parse({
      factor: "effort",
      estimate: { value: null, basis: "Delivery discovery has not happened." },
    });
    expect(proposal.estimate.value).toBeNull();
    expect(
      priorityEstimateErrors(proposal.factor, proposal.estimate, true),
    ).toContain("a reviewed estimate needs a value");
  });

  it("requires reach basis and rationale only when a reviewer adopts a value", () => {
    const estimate = { value: 120, basis: "" };
    expect(priorityEstimateErrors("reach", estimate, false)).toEqual([]);
    expect(priorityEstimateErrors("reach", estimate, true)).toEqual([
      "explain the estimate's basis",
      "reach needs a unit and period",
    ]);
    expect(
      priorityEstimateErrors(
        "reach",
        {
          ...estimate,
          value: 0,
          basis: "No affected people this quarter",
          unit: "people",
          period: "quarter",
        },
        true,
      ),
    ).toEqual([]);
  });

  it.each([
    ["effort", 0],
    ["effort", -1],
    ["effort", 1.001],
    ["confidence", 0],
    ["confidence", 80],
    ["confidence", 0.12345],
    ["reach", -1],
    ["reach", 1.001],
    ["impact", Number.POSITIVE_INFINITY],
  ] as const)(
    "rejects invalid %s value %s before recording a proposal",
    (factor, value) => {
      expect(
        priorityProposalSchema.safeParse({
          factor,
          estimate: { value, basis: "Human estimate" },
        }).success,
      ).toBe(false);
    },
  );

  it("does not accept confidence percentages as fractions or effort days as an implicit unit", () => {
    expect(
      priorityProposalSchema.safeParse({
        factor: "confidence",
        estimate: { value: 80, basis: "Survey" },
      }).success,
    ).toBe(false);
    expect(
      priorityProposalSchema.safeParse({
        factor: "effort",
        estimate: { value: 20, unit: "days", basis: "Team quote" },
      }).success,
    ).toBe(false);
  });

  it("requires a reason to reject and prevents conflicting actions on one factor", () => {
    expect(
      priorityDecisionsSchema.safeParse([{ factor: "reach", action: "reject" }])
        .success,
    ).toBe(false);
    expect(
      priorityDecisionsSchema.safeParse([
        { factor: "reach", action: "adopt", proposalId: randomUUID() },
        { factor: "reach", action: "reject", reason: "Scope changed" },
      ]).success,
    ).toBe(false);
  });
});
