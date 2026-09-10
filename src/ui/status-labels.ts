import type { externalSystems } from "../domain/constants";
import type { ActionNeeded, RequestPhase } from "../server/read-model";
import type { RequestView } from "../server/request-views";

export const phaseLabels: Record<RequestPhase, string> = {
  received: "Received",
  review: "Under review",
  waiting: "Waiting for requester",
  approved: "Review complete",
  delivery: "In delivery",
  resolved: "Closed",
};
export function requestPhaseLabel(data: RequestView): string {
  if (data.status) return phaseLabels[data.status.phase];
  if (data.delivery.resolution) return "Closed";
  if (data.record.waitingOnRequester) return "Waiting for requester";
  if (data.delivery.handoff?.status === "confirmed") return "In delivery";
  if (data.record.stage === "first_review_completed") return "Review complete";
  if (data.record.stage === "under_review") return "Under review";
  return "Received";
}
export const actionLabels: Record<ActionNeeded, string> = {
  refresh_preparation: "Update preparation",
  review_usage_limit: "Check model usage limits",
  wait_for_preparation: "Wait for preparation",
  retry_assessment: "Retry preparation",
  review_assets: "Review existing options",
  review_risk: "Review policy findings",
  score_rice: "Review priority estimates",
  complete_first_review: "Complete first review",
  wait_for_requester: "Wait for request clarification",
  retry_handoff: "Retry delivery handoff",
  execute_handoff: "Start delivery handoff",
  monitor_delivery: "Check delivery progress",
  record_outcome: "Record final outcome",
  none: "No further action",
};
export function formatScore(value: string | number | null) {
  return value === null
    ? "Not scored"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
        Number(value),
      );
}

export const riskDecisionLabels: Record<string, string> = {
  confirmed: "Confirmed",
  overridden: "Severity changed",
  cleared: "Does not apply",
  follow_up_required: "Information needed",
};

/** A model job the requester is still waiting on, queued or already leased. */
export function jobPending(status: string | undefined): boolean {
  return status === "queued" || status === "leased";
}

/** Simulated work is closed when a closure was recorded against it. */
export function workClosed(item: { closedAt: string | null }): boolean {
  return Boolean(item.closedAt);
}

/** Simulated work carries a fixture key or an identifier the demo minted. */
export function isSimulatedWork(item: {
  fixtureKey: string | null;
  externalId: string;
}): boolean {
  return Boolean(item.fixtureKey) || item.externalId.startsWith("SIM-");
}

export const externalSystemLabels: Record<
  (typeof externalSystems)[number],
  string
> = {
  servicenow: "ServiceNow",
  azure_devops: "Azure DevOps",
};
