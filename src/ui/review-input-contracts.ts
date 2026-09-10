/** UI-side names for the review-input and priority contracts. The value
 * and view types come straight from the backend modules; nothing here
 * guesses a shape. */

import {
  priorityEstimateErrors,
  type PriorityView,
  type PriorityFactor,
  type PriorityEstimate,
} from "../domain/priority";
import type { ReviewInputView } from "../workflow/review-inputs";
import type { RequestView } from "../server/request-views";

export type ReviewInputRow = ReviewInputView;

export const factorLabels: Record<PriorityFactor, string> = {
  reach: "Reach",
  impact: "Impact",
  confidence: "Confidence",
  effort: "Effort",
};

/** Actions on POST /api/review/actions. Schemas are strict: payloads carry
 * exactly the declared keys. */
export const SUBMIT_ASSESSMENT_ACTION = "submitAssessment";
export const ADD_CANDIDATE_ACTION = "addReviewCandidate";
export const ASK_INPUT_ACTION = "askReviewInput";
export const ANSWER_INPUT_ACTION = "answerReviewInput";
export const ASSIGN_INPUT_ACTION = "assignReviewInput";

export function priorityOf(data: RequestView): PriorityView | undefined {
  return data.priority;
}

export function inputRequestsOf(
  data: RequestView,
): ReviewInputView[] | undefined {
  return data.inputRequests;
}

/** Display helpers: confidence is stored as a fraction and effort as
 * person-months; people enter percent and working days. Display shows the
 * stored value at its supported precision — never rounded to something the
 * person did not enter (fraction 0.0001 ⇒ percent 0.01; months 0.01 ⇒
 * days 0.2). */
export function displayEstimate(
  factor: PriorityFactor,
  estimate: PriorityEstimate,
): string {
  if (estimate.value === null) return "No estimate";
  if (factor === "confidence")
    return Number((estimate.value * 100).toFixed(2)) + "%";
  if (factor === "effort")
    return (
      estimate.value +
      " person-months (" +
      Number((estimate.value * 20).toFixed(1)) +
      " working days)"
    );
  const reachBasis = [estimate.unit, estimate.period]
    .filter(Boolean)
    .join(" \u00b7 ");
  return String(estimate.value) + (reachBasis ? " " + reachBasis : "");
}

/** Exact unit conversion. Only floating-point noise is trimmed (12 decimal
 * places, far finer than any supported precision); a value the API cannot
 * hold is rejected by entryError with an explanation, never rounded into a
 * different number. */
export function entryToValue(
  factor: PriorityFactor,
  raw: string,
): number | null {
  const parsed = Number(raw);
  if (!raw.trim() || !Number.isFinite(parsed)) return null;
  if (factor === "confidence") return Number((parsed / 100).toFixed(12));
  if (factor === "effort") return Number((parsed / 20).toFixed(12));
  return parsed;
}

const precisionTexts: Record<PriorityFactor, string> = {
  reach: "Enter a whole count from 0 to 999,999,999,999, using digits only.",
  impact:
    "Enter a value greater than zero and no greater than 1000, with up to two decimal places.",
  confidence: "Enter 0.01% to 100%, in steps of 0.01 percentage points.",
  effort:
    "Enter more than zero and no more than 200,000 working days, in steps of 0.2 days.",
};

/** Reach is a whole count entered digits-only, matching the retired
 * dialog's behavior: letters, signs, decimals, and exponents never enter
 * the field. Other factors accept decimal entry at their supported
 * precision. */
export function acceptFactorEntry(
  factor: PriorityFactor,
  raw: string,
): boolean {
  return factor === "reach" ? /^\d*$/.test(raw) : true;
}

/** Rejects a number the stored precision cannot represent, with the reason
 * in the person's own units. Range problems stay with the caller's texts. */
export function entryError(factor: PriorityFactor, raw: string): string | null {
  const value = entryToValue(factor, raw);
  if (value === null) return null;
  const problems = priorityEstimateErrors(factor, { value, basis: "" }, false);
  if (problems.length > 0) return precisionTexts[factor];
  if (factor === "reach" && !Number.isInteger(value))
    return precisionTexts.reach;
  return null;
}
