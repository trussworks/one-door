export const reviewInputAudiences = ["internal", "requester"] as const;
export const reviewInputStates = ["open", "answered", "resolved"] as const;
export const reviewInputOutcomes = ["provided", "unknown"] as const;
export const reviewInputResolutions = [
  "candidate_decision",
  "risk_decision",
  "priority_contribution",
  "area_outcome",
] as const;

export interface ReviewInputAssessmentCurrency {
  assetAssessmentId: string | null;
  riskAssessmentId: string | null;
}

interface ReviewInputTarget {
  revisionId: string | null;
  requestGeneration: number;
  candidateId?: string | null;
  findingId?: string | null;
  candidateAssessmentId?: string | null;
  findingAssessmentId?: string | null;
}

export function isCurrentReviewInput(
  input: ReviewInputTarget,
  request: { currentRevisionId: string | null; fixtureGeneration: number },
  currency?: ReviewInputAssessmentCurrency,
): boolean {
  if (
    input.revisionId !== request.currentRevisionId ||
    input.requestGeneration !== request.fixtureGeneration
  )
    return false;
  if (input.candidateId)
    return Boolean(
      input.candidateAssessmentId &&
      input.candidateAssessmentId === currency?.assetAssessmentId,
    );
  if (input.findingId)
    return Boolean(
      input.findingAssessmentId &&
      input.findingAssessmentId === currency?.riskAssessmentId,
    );
  return true;
}
