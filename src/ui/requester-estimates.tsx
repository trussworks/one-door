"use client";

import type { PriorityProposalInput } from "../domain/priority";
import { Field } from "./fields";
import {
  acceptFactorEntry,
  entryError,
  entryToValue,
} from "./review-input-contracts";
import type { useSavedWork } from "./use-saved-work";
import styles from "./requester.module.css";

/** The requester's optional priority material. Plain-language statements
 * with a basis are always welcome; a known number is first-class and becomes
 * a directly adoptable proposal. Unknowns stay blank — never zero, never a
 * required form. */
export const estimatePrompts = [
  {
    factor: "reach",
    statementKey: "estimateBenefit",
    basisKey: "estimateBenefitBasis",
    numberKey: "estimateReachCount",
    label: "Who would benefit, how many, and over what period? (optional)",
    hint: "Count the people or units the proposed change would reach within a stated period. General workload may cover more than the change would affect.",
    numberLabel: "Reach count (optional)",
    numberHint:
      "Enter the count only. Add the unit and time period in their own fields.",
  },
  {
    factor: "impact",
    statementKey: "estimateImprovement",
    basisKey: "estimateImprovementBasis",
    numberKey: "estimateImpactValue",
    label: "What improvement would people or their work see? (optional)",
    hint: "Describe a concrete expected benefit, such as a change in the work people can do.",
    numberLabel: "Impact value (optional)",
    numberHint:
      "Guideposts: 0.25 smallest effect, 0.5 small, 1 intermediate, 2 large, 3 largest. Other positive values up to 1000 are allowed, with up to two decimal places.",
  },
  {
    factor: "confidence",
    statementKey: "estimateConfidenceNote",
    basisKey: "estimateConfidenceBasis",
    numberKey: "estimateConfidenceValue",
    label: "How confident are you in the numbers you supplied? (optional)",
    hint: "Describe the evidence behind your numbers. Say where you are uncertain.",
    numberLabel: "Confidence (%) (optional)",
    numberHint:
      "Rate the evidence behind the estimates. Guideposts: 80% strong evidence, 50% partial evidence, 20% an early assumption.",
  },
  {
    factor: "effort",
    statementKey: "estimateDelivery",
    basisKey: "estimateDeliveryBasis",
    numberKey: "estimateEffortDays",
    label: "What delivery effort has been estimated? (optional)",
    hint: "Use an existing plan or quote if one is available, and give its source.",
    numberLabel: "Total working days (optional)",
    numberHint:
      "Add the working days for everyone involved. Twenty working days equal one person-month.",
  },
] as const;

export const estimateDraftFields = Object.fromEntries(
  estimatePrompts.flatMap((prompt) => [
    [prompt.statementKey, ""],
    [prompt.basisKey, ""],
    [prompt.numberKey, ""],
  ]),
) as Record<string, string>;
estimateDraftFields.estimateReachUnit = "";
estimateDraftFields.estimateReachPeriod = "";

function combinedBasis(statement: string, basis: string): string {
  return [statement, basis].filter(Boolean).join(" — ");
}

/** Answered prompts become proposals. A valid number becomes a numeric
 * estimate the reviewer can adopt directly; prose alone travels as the
 * estimate's basis with a null value. Nothing is coerced or dropped:
 * a malformed number is reported through estimateIssues instead. */
export function estimateProposals(
  values: Record<string, string>,
): PriorityProposalInput[] {
  return estimatePrompts.flatMap((prompt) => promptProposal(prompt, values));
}

function promptProposal(
  prompt: (typeof estimatePrompts)[number],
  values: Record<string, string>,
): PriorityProposalInput[] {
  const entry = promptEntry(prompt, values);
  if (entry.value !== null && entry.issue) return [];
  if (entry.value !== null) {
    return [
      {
        factor: prompt.factor,
        estimate: {
          value: entry.value,
          basis: entry.basis,
          ...(prompt.factor === "reach" && {
            unit: entry.unit,
            period: entry.period,
          }),
        },
      },
    ];
  }
  if (!entry.statement) return [];
  return [
    {
      factor: prompt.factor,
      estimate: { value: null, basis: entry.basis },
    },
  ];
}

function promptEntry(
  prompt: (typeof estimatePrompts)[number],
  values: Record<string, string>,
) {
  const statement = (values[prompt.statementKey] ?? "").trim();
  const rawNumber = (values[prompt.numberKey] ?? "").trim();
  const value = rawNumber ? entryToValue(prompt.factor, rawNumber) : null;
  const unit = (values.estimateReachUnit ?? "").trim();
  const period = (values.estimateReachPeriod ?? "").trim();
  const basis = combinedBasis(
    statement,
    (values[prompt.basisKey] ?? "").trim(),
  );
  const issue =
    value !== null
      ? numberIssue(prompt.factor, rawNumber, value, { unit, period })
      : null;
  return { statement, value, unit, period, basis, issue };
}

function reachIssue(value: number, unit: string, period: string) {
  if (!unit || !period)
    return "Add the unit counted and the time period for Reach.";
  if (value < 0 || !Number.isFinite(value))
    return "Enter a whole count from 0 to 999,999,999,999, using digits only.";
  return null;
}

const rangeIssues: Record<string, (value: number) => string | null> = {
  impact: (value) =>
    value <= 0 || value > 1000
      ? "Enter an Impact value greater than zero and no greater than 1000."
      : null,
  confidence: (value) =>
    value <= 0 || value > 1 ? "Enter a confidence from 0.01% to 100%." : null,
  effort: (value) =>
    value <= 0
      ? "Enter more than zero and no more than 200,000 working days, in steps of 0.2 days."
      : null,
};

function numberIssue(
  factor: (typeof estimatePrompts)[number]["factor"],
  raw: string,
  value: number,
  reach: { unit: string; period: string },
): string | null {
  const base =
    factor === "reach"
      ? reachIssue(value, reach.unit, reach.period)
      : (rangeIssues[factor]?.(value) ?? null);
  return base ?? entryError(factor, raw);
}

/** Problems that must stop submission rather than silently dropping what
 * the requester typed. */
export function estimateIssues(values: Record<string, string>): string[] {
  return estimatePrompts.flatMap((prompt) => {
    const rawNumber = (values[prompt.numberKey] ?? "").trim();
    if (!rawNumber) return [];
    const value = entryToValue(prompt.factor, rawNumber);
    if (value === null)
      return [prompt.factor + " cannot use the value " + rawNumber + "."];
    const issue = numberIssue(prompt.factor, rawNumber, value, {
      unit: (values.estimateReachUnit ?? "").trim(),
      period: (values.estimateReachPeriod ?? "").trim(),
    });
    return issue ? [issue] : [];
  });
}

export function PriorityInvitation({
  draft,
}: {
  draft: ReturnType<typeof useSavedWork>;
}) {
  return (
    <details className={styles.priorityInvitation}>
      <summary>Add information for prioritization (optional)</summary>
      <p>
        Share any facts or numbers you know, and explain where they come from.
        Every contribution is optional and will be reviewed.
      </p>
      {estimatePrompts.map((prompt) => (
        <div key={prompt.factor}>
          <Field
            name={prompt.statementKey}
            label={prompt.label}
            hint={prompt.hint}
            required={false}
            value={draft.values[prompt.statementKey] ?? ""}
            onChange={(value) => draft.change(prompt.statementKey, value)}
          />
          <Field
            name={prompt.numberKey}
            label={prompt.numberLabel}
            hint={prompt.numberHint}
            required={false}
            value={draft.values[prompt.numberKey] ?? ""}
            onChange={(value) => {
              if (acceptFactorEntry(prompt.factor, value))
                draft.change(prompt.numberKey, value);
            }}
            inputMode={prompt.factor === "reach" ? "numeric" : "decimal"}
            pattern={prompt.factor === "reach" ? "[0-9]+" : undefined}
            narrow
          />
          {prompt.factor === "reach" && <ReachBasisFields draft={draft} />}
          <Field
            name={prompt.basisKey}
            label="Where does this information come from? (optional)"
            hint="For example, a count, a plan, a quote or your rough judgment."
            required={false}
            value={draft.values[prompt.basisKey] ?? ""}
            onChange={(value) => draft.change(prompt.basisKey, value)}
          />
        </div>
      ))}
    </details>
  );
}

function ReachBasisFields({
  draft,
}: {
  draft: ReturnType<typeof useSavedWork>;
}) {
  return (
    <>
      <Field
        name="estimateReachUnit"
        label="Unit counted (optional)"
        hint="For example, people or teams."
        required={false}
        value={draft.values.estimateReachUnit ?? ""}
        onChange={(value) => draft.change("estimateReachUnit", value)}
      />
      <Field
        name="estimateReachPeriod"
        label="Time period (optional)"
        hint="For example, one month or one year."
        required={false}
        value={draft.values.estimateReachPeriod ?? ""}
        onChange={(value) => draft.change("estimateReachPeriod", value)}
      />
    </>
  );
}
