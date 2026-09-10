export const actingViews = [
  "requester",
  "contributor",
  "administrator",
] as const;
export const actorKinds = ["persona", "visitor", "system"] as const;
export const organizationKinds = ["agency", "office", "team"] as const;
export const dataOrigins = ["fixture", "live", "system"] as const;
export const draftStates = ["open", "ready", "submitted"] as const;
export const turnActors = ["customer", "assistant"] as const;
export const requestStages = [
  "submitted",
  "under_review",
  "first_review_completed",
] as const;
// Audit-log event type for an administrator note attached to a request.
export const administratorNoteEvent = "administrator_note";
export const revisionSources = ["submission", "clarification_answer"] as const;
export const routingStates = ["service_selected", "routing_requested"] as const;
export const handoffStatuses = ["intended", "confirmed", "failed"] as const;
export const resolutionOutcomes = [
  "fulfilled_reuse",
  "fulfilled_new",
  "fulfilled_mixed",
  "closed_without_fulfillment",
] as const;
export const modelPurposes = [
  "intake_interpret",
  "asset_match",
  "risk_assess",
] as const;
export const modelJobStatuses = [
  "queued",
  "leased",
  "succeeded",
  "failed",
  "capped",
  "superseded",
] as const;
export const modelStatuses = [
  "reserved",
  "succeeded",
  "failed",
  "denied",
] as const;
export const lifecycleStates = ["active", "retired"] as const;
export const fitBands = ["strong", "possible", "weak"] as const;
export const candidateDecisions = ["accepted", "rejected", "cleared"] as const;
export const taskTypes = [
  "requester_submission",
  "contributor_first_review",
] as const;
export const syncStatuses = ["running", "succeeded", "failed"] as const;
export const sourceRecordStates = ["present", "stale"] as const;
export const conflictStates = ["open", "resolved", "reopened"] as const;
export const catalogStates = ["draft", "published", "retired"] as const;
export const approvalStatuses = [
  "approved",
  "conditional",
  "review_required",
] as const;
export const catalogItemTypes = [
  "software",
  "infrastructure",
  "platform",
] as const;
export const reviewAreas = ["assets", "risk", "rice"] as const;
export const reviewTaskStates = [
  "pending",
  "in_progress",
  "completed",
] as const;
export const assessmentStatuses = ["succeeded", "failed"] as const;
export const riskDomains = [
  "policy",
  "accessibility",
  "security",
  "privacy",
  "ai",
  "procurement",
] as const;
export const riskKinds = ["supported_risk", "missing_information"] as const;
export const riskSeverities = ["low", "moderate", "high", "critical"] as const;
export const riskDecisions = [
  "confirmed",
  "overridden",
  "follow_up_required",
  "cleared",
] as const;
export const externalSystems = ["servicenow", "azure_devops"] as const;
export const syncHealthStates = ["current", "stale", "failed"] as const;

export type ActingView = (typeof actingViews)[number];
export type DataOrigin = (typeof dataOrigins)[number];
export type RequestStage = (typeof requestStages)[number];
export type RiskDomain = (typeof riskDomains)[number];
