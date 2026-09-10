import { sql } from "drizzle-orm";
import { check, pgEnum, timestamp } from "drizzle-orm/pg-core";

import {
  actingViews,
  actorKinds,
  approvalStatuses,
  assessmentStatuses,
  candidateDecisions,
  catalogItemTypes,
  catalogStates,
  conflictStates,
  dataOrigins,
  draftStates,
  externalSystems,
  fitBands,
  handoffStatuses,
  lifecycleStates,
  modelJobStatuses,
  modelPurposes,
  modelStatuses,
  organizationKinds,
  requestStages,
  resolutionOutcomes,
  reviewAreas,
  reviewTaskStates,
  revisionSources,
  riskDecisions,
  riskDomains,
  riskKinds,
  riskSeverities,
  routingStates,
  sourceRecordStates,
  syncHealthStates,
  syncStatuses,
  taskTypes,
  turnActors,
} from "../../domain/constants.ts";

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow();
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow();
export const positiveVersion = (name: string, column: { name: string }) =>
  check(name, sql.raw('"' + column.name + '" > 0'));
export const actingViewEnum = pgEnum("acting_view", actingViews);
export const actorKindEnum = pgEnum("actor_kind", actorKinds);
export const organizationKindEnum = pgEnum(
  "organization_kind",
  organizationKinds,
);
export const dataOriginEnum = pgEnum("data_origin", dataOrigins);
export const draftStateEnum = pgEnum("draft_state", draftStates);
export const turnActorEnum = pgEnum("turn_actor", turnActors);
export const requestStageEnum = pgEnum("request_stage", requestStages);
export const revisionSourceEnum = pgEnum("revision_source", revisionSources);
export const handoffStatusEnum = pgEnum("handoff_status", handoffStatuses);
export const resolutionOutcomeEnum = pgEnum(
  "resolution_outcome",
  resolutionOutcomes,
);
export const routingStateEnum = pgEnum("routing_state", routingStates);
export const modelPurposeEnum = pgEnum("model_purpose", modelPurposes);
export const modelJobStatusEnum = pgEnum("model_job_status", modelJobStatuses);
export const modelStatusEnum = pgEnum("model_status", modelStatuses);
export const lifecycleStateEnum = pgEnum("lifecycle_state", lifecycleStates);
export const fitBandEnum = pgEnum("fit_band", fitBands);
export const candidateDecisionEnum = pgEnum(
  "candidate_decision",
  candidateDecisions,
);
export const taskTypeEnum = pgEnum("task_type", taskTypes);
export const syncStatusEnum = pgEnum("sync_status", syncStatuses);
export const sourceRecordStateEnum = pgEnum(
  "source_record_state",
  sourceRecordStates,
);
export const conflictStateEnum = pgEnum("conflict_state", conflictStates);
export const catalogStateEnum = pgEnum("catalog_state", catalogStates);
export const approvalStatusEnum = pgEnum("approval_status", approvalStatuses);
export const catalogItemTypeEnum = pgEnum(
  "catalog_item_type",
  catalogItemTypes,
);
export const reviewAreaEnum = pgEnum("review_area", reviewAreas);
export const reviewTaskStateEnum = pgEnum(
  "review_task_state",
  reviewTaskStates,
);
export const assessmentStatusEnum = pgEnum(
  "assessment_status",
  assessmentStatuses,
);
export const riskDomainEnum = pgEnum("risk_domain", riskDomains);
export const riskKindEnum = pgEnum("risk_kind", riskKinds);
export const riskSeverityEnum = pgEnum("risk_severity", riskSeverities);
export const riskDecisionEnum = pgEnum("risk_decision", riskDecisions);
export const externalSystemEnum = pgEnum("external_system", externalSystems);
export const syncHealthEnum = pgEnum("sync_health", syncHealthStates);
