import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
  lifecycleStates,
  modelPurposes,
  modelStatuses,
  organizationKinds,
  requestStages,
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
} from "../domain/constants.ts";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow();
const positiveVersion = (name: string, column: { name: string }) =>
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

// Owned by the review/delivery slice; move into domain constants when that
// file is next open for edit.
export const handoffStatuses = ["intended", "confirmed", "failed"] as const;
export const resolutionOutcomes = [
  "fulfilled_reuse",
  "fulfilled_new",
  "fulfilled_mixed",
  "closed_without_fulfillment",
] as const;
export const handoffStatusEnum = pgEnum("handoff_status", handoffStatuses);
export const resolutionOutcomeEnum = pgEnum(
  "resolution_outcome",
  resolutionOutcomes,
);
export const routingStateEnum = pgEnum("routing_state", routingStates);
export const modelPurposeEnum = pgEnum("model_purpose", modelPurposes);
// Owned by the model-jobs slice; move into domain constants when that file
// is next open for edit.
export const modelJobStatuses = [
  "queued",
  "leased",
  "succeeded",
  "failed",
  "capped",
  "superseded",
] as const;
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

export const fixtureSeedManifests = pgTable("_one_door_fixture_seed", {
  name: text().primaryKey(),
  contentHash: text("content_hash").notNull(),
  seededAt: timestamp("seeded_at", {
    withTimezone: true,
    mode: "string",
  })
    .notNull()
    .defaultNow(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    name: text().notNull(),
    kind: organizationKindEnum().notNull(),
    parentId: uuid("parent_id"),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("organizations_fixture_key_unique").on(table.fixtureKey),
    index("organizations_parent_idx").on(table.parentId),
  ],
);

export const actors = pgTable(
  "actors",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    kind: actorKindEnum().notNull(),
    displayName: text("display_name").notNull(),
    email: text(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    capabilities: text().array().notNull().default(sql.raw("'{}'::text[]")),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("actors_fixture_key_unique").on(table.fixtureKey),
    index("actors_organization_idx").on(table.organizationId),
  ],
);

export const visitors = pgTable(
  "visitors",
  {
    id: uuid().primaryKey(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    lastMeaningfulRoute: text("last_meaningful_route"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("visitors_actor_unique").on(table.actorId)],
);

export const wip = pgTable(
  "wip",
  {
    id: uuid().primaryKey(),
    visitorId: uuid("visitor_id")
      .notNull()
      .references(() => visitors.id),
    actingView: actingViewEnum("acting_view").notNull(),
    pageKey: text("page_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    savedAt: timestamp("saved_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wip_scope_unique").on(
      table.visitorId,
      table.actingView,
      table.pageKey,
      table.subjectKey,
    ),
    positiveVersion("wip_row_version_check", table.rowVersion),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().primaryKey(),
    actorId: uuid("actor_id").references(() => actors.id),
    visitorId: uuid("visitor_id").references(() => visitors.id),
    actingView: actingViewEnum("acting_view"),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    origin: dataOriginEnum().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_events_subject_created_idx").on(
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
  ],
);

export const serviceOfferings = pgTable(
  "service_offerings",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    offeringKey: text("offering_key").notNull(),
    version: integer().notNull(),
    supersedesId: uuid("supersedes_id"),
    lifecycle: lifecycleStateEnum().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    ownerOrganizationId: uuid("owner_organization_id")
      .notNull()
      .references(() => organizations.id),
    capabilities: text().array().notNull(),
    prerequisites: text().array().notNull(),
    reviewDate: date("review_date").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("service_offerings_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("service_offerings_key_version_unique").on(
      table.offeringKey,
      table.version,
    ),
    uniqueIndex("service_offerings_one_active_key")
      .on(table.offeringKey)
      .where(sql.raw("lifecycle = 'active'")),
    positiveVersion("service_offerings_version_check", table.version),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    visitorId: uuid("visitor_id").references(() => visitors.id),
    requesterActorId: uuid("requester_actor_id")
      .notNull()
      .references(() => actors.id),
    requestingOrganizationId: uuid("requesting_organization_id")
      .notNull()
      .references(() => organizations.id),
    rawNeed: text("raw_need").notNull(),
    structuredContent: jsonb("structured_content")
      .$type<Record<string, unknown>>()
      .notNull(),
    fieldOrigins: jsonb("field_origins")
      .$type<Record<string, unknown>>()
      .notNull(),
    state: draftStateEnum().notNull(),
    currentStep: text("current_step").notNull(),
    confirmedIntakeJobId: uuid("confirmed_intake_job_id"),
    parentRequestId: uuid("parent_request_id"),
    creationKey: text("creation_key"),
    creationInputHash: text("creation_input_hash"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("drafts_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("drafts_creation_key_unique").on(table.creationKey),
    index("drafts_visitor_state_idx").on(table.visitorId, table.state),
    positiveVersion("drafts_row_version_check", table.rowVersion),
    check(
      "drafts_owner_check",
      sql.raw("visitor_id IS NOT NULL OR fixture_key IS NOT NULL"),
    ),
    check(
      "drafts_creation_key_pair_check",
      sql.raw("(creation_key IS NULL) = (creation_input_hash IS NULL)"),
    ),
  ],
);

export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id),
    visitorId: uuid("visitor_id").references(() => visitors.id),
    purpose: modelPurposeEnum().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    corpusVersions: jsonb("corpus_versions")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: modelStatusEnum().notNull(),
    attemptCount: smallint("attempt_count").notNull().default(1),
    reservedCostMicros: integer("reserved_cost_micros").notNull(),
    actualCostMicros: integer("actual_cost_micros"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    validatedOutput: jsonb("validated_output").$type<Record<string, unknown>>(),
    sanitizedError: text("sanitized_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    origin: dataOriginEnum().notNull(),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("model_calls_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("model_calls_idempotency_unique").on(table.idempotencyKey),
    index("model_calls_quota_idx").on(
      table.visitorId,
      table.createdAt,
      table.status,
    ),
    check(
      "model_calls_attempt_count_check",
      sql.raw("attempt_count BETWEEN 1 AND 2"),
    ),
    check(
      "model_calls_reserved_cost_check",
      sql.raw("reserved_cost_micros >= 0"),
    ),
    check(
      "model_calls_actual_cost_check",
      sql.raw("actual_cost_micros IS NULL OR actual_cost_micros >= 0"),
    ),
    check(
      "model_calls_status_check",
      sql.raw(
        "(status = 'reserved' AND completed_at IS NULL) OR (status IN ('succeeded', 'failed', 'denied') AND completed_at IS NOT NULL)",
      ),
    ),
    check(
      "model_calls_output_check",
      sql.raw("status <> 'succeeded' OR validated_output IS NOT NULL"),
    ),
    check(
      "model_calls_error_check",
      sql.raw(
        "status <> 'failed' OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)",
      ),
    ),
  ],
);

export const draftTurns = pgTable(
  "draft_turns",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id),
    ordinal: integer().notNull(),
    actor: turnActorEnum().notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    modelCallId: uuid("model_call_id").references(() => modelCalls.id),
    content: text().notNull(),
    replyToTurnId: uuid("reply_to_turn_id"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("draft_turns_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("draft_turns_ordinal_unique").on(table.draftId, table.ordinal),
    uniqueIndex("draft_turns_one_answer")
      .on(table.replyToTurnId)
      .where(sql.raw("reply_to_turn_id IS NOT NULL")),
    check("draft_turns_ordinal_check", sql.raw("ordinal >= 0")),
    check(
      "draft_turns_actor_check",
      sql.raw(
        "(actor = 'customer' AND actor_id IS NOT NULL AND model_call_id IS NULL) OR (actor = 'assistant' AND actor_id IS NULL AND model_call_id IS NOT NULL)",
      ),
    ),
  ],
);

export const serviceCandidates = pgTable(
  "service_candidates",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id),
    modelCallId: uuid("model_call_id")
      .notNull()
      .references(() => modelCalls.id),
    offeringId: uuid("offering_id")
      .notNull()
      .references(() => serviceOfferings.id),
    rank: smallint().notNull(),
    fitBand: fitBandEnum("fit_band").notNull(),
    coverage: text().array().notNull(),
    gaps: text().array().notNull(),
    relatedOfferingKeys: text("related_offering_keys").array().notNull(),
    rationale: text().notNull(),
    decision: candidateDecisionEnum(),
    decidedByActorId: uuid("decided_by_actor_id").references(() => actors.id),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("service_candidates_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("service_candidates_rank_unique").on(
      table.draftId,
      table.modelCallId,
      table.rank,
    ),
    check("service_candidates_rank_check", sql.raw("rank > 0")),
    check(
      "service_candidates_decision_check",
      sql.raw(
        "(decision IS NULL AND decided_by_actor_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL) OR (decision IS NOT NULL AND decided_by_actor_id IS NOT NULL AND decided_at IS NOT NULL)",
      ),
    ),
    check(
      "service_candidates_rejection_reason_check",
      sql.raw(
        "decision <> 'rejected' OR (decision_reason IS NOT NULL AND length(trim(decision_reason)) > 0)",
      ),
    ),
  ],
);

export const requests = pgTable(
  "requests",
  {
    id: uuid().primaryKey(),
    displayId: text("display_id").notNull(),
    fixtureKey: text("fixture_key"),
    ownerVisitorId: uuid("owner_visitor_id").references(() => visitors.id),
    requesterActorId: uuid("requester_actor_id")
      .notNull()
      .references(() => actors.id),
    requestingOrganizationId: uuid("requesting_organization_id")
      .notNull()
      .references(() => organizations.id),
    sourceDraftId: uuid("source_draft_id")
      .notNull()
      .references(() => drafts.id),
    selectedServiceCandidateId: uuid(
      "selected_service_candidate_id",
    ).references(() => serviceCandidates.id),
    routingState: routingStateEnum("routing_state").notNull(),
    title: text().notNull(),
    problem: text().notNull(),
    affectedPeople: text("affected_people").notNull(),
    acceptanceCriteria: text("acceptance_criteria").array().notNull(),
    requirements: text().array().notNull(),
    constraints: text().array().notNull(),
    unknowns: text().array().notNull(),
    stage: requestStageEnum().notNull(),
    coordinatingActorId: uuid("coordinating_actor_id").references(
      () => actors.id,
    ),
    currentRiceScoreId: uuid("current_rice_score_id"),
    currentRevisionId: uuid("current_revision_id"),
    nextOwner: text("next_owner"),
    fixtureGeneration: integer("fixture_generation").notNull().default(1),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    firstReviewCompletedAt: timestamp("first_review_completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("requests_display_id_unique").on(table.displayId),
    uniqueIndex("requests_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("requests_source_draft_unique").on(table.sourceDraftId),
    index("requests_queue_idx").on(table.stage, table.updatedAt),
    index("requests_owner_visitor_idx").on(table.ownerVisitorId),
    index("requests_organization_idx").on(table.requestingOrganizationId),
    index("requests_coordinator_idx").on(table.coordinatingActorId),
    positiveVersion("requests_row_version_check", table.rowVersion),
    check(
      "requests_owner_check",
      sql.raw("owner_visitor_id IS NOT NULL OR fixture_key IS NOT NULL"),
    ),
    check(
      "requests_routing_check",
      sql.raw(
        "(routing_state = 'service_selected' AND selected_service_candidate_id IS NOT NULL) OR (routing_state = 'routing_requested' AND selected_service_candidate_id IS NULL)",
      ),
    ),
  ],
);

export const requestContentRevisions = pgTable(
  "request_content_revisions",
  {
    id: uuid().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    revisionNumber: integer("revision_number").notNull(),
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    source: revisionSourceEnum().notNull(),
    authoredByActorId: uuid("authored_by_actor_id")
      .notNull()
      .references(() => actors.id),
    visitorId: uuid("visitor_id").references(() => visitors.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("request_content_revisions_number_unique").on(
      table.requestId,
      table.revisionNumber,
    ),
    uniqueIndex("request_content_revisions_parent_id_unique").on(
      table.id,
      table.requestId,
    ),
    check(
      "request_content_revisions_number_check",
      sql.raw("revision_number > 0"),
    ),
  ],
);

export const clarificationRequests = pgTable(
  "clarification_requests",
  {
    id: uuid().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    revisionId: uuid("revision_id").notNull(),
    question: text().notNull(),
    askedByActorId: uuid("asked_by_actor_id")
      .notNull()
      .references(() => actors.id),
    askedAt: timestamp("asked_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    answer: text(),
    answeredAt: timestamp("answered_at", {
      withTimezone: true,
      mode: "string",
    }),
    answerRevisionId: uuid("answer_revision_id"),
    requestGeneration: integer("request_generation").notNull().default(1),
    origin: dataOriginEnum().notNull(),
  },
  (table) => [
    index("clarification_requests_request_idx").on(
      table.requestId,
      table.askedAt,
    ),
    uniqueIndex("clarification_requests_one_open")
      .on(table.requestId, table.requestGeneration)
      .where(sql.raw("answered_at IS NULL")),
    check(
      "clarification_requests_question_check",
      sql.raw("length(trim(question)) > 0"),
    ),
    check(
      "clarification_requests_answer_check",
      sql.raw(
        "(answered_at IS NULL AND answer IS NULL AND answer_revision_id IS NULL) OR (answered_at IS NOT NULL AND answer IS NOT NULL AND length(trim(answer)) > 0 AND answer_revision_id IS NOT NULL)",
      ),
    ),
  ],
);

export const taskCompletions = pgTable(
  "task_completions",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    visitorId: uuid("visitor_id").references(() => visitors.id),
    taskType: taskTypeEnum("task_type").notNull(),
    actingView: actingViewEnum("acting_view").notNull(),
    rating: smallint().notNull(),
    origin: dataOriginEnum().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestGeneration: integer("request_generation").notNull().default(1),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("task_completions_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("task_completions_actor_task_request_unique").on(
      table.actorId,
      table.taskType,
      table.requestId,
      table.requestGeneration,
    ),
    uniqueIndex("task_completions_idempotency_unique").on(table.idempotencyKey),
    check("task_completions_rating_check", sql.raw("rating BETWEEN 1 AND 5")),
    check(
      "task_completions_view_check",
      sql.raw(
        "(task_type = 'requester_submission' AND acting_view = 'requester') OR (task_type = 'contributor_first_review' AND acting_view = 'contributor')",
      ),
    ),
  ],
);

export const inventorySources = pgTable(
  "inventory_sources",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    name: text().notNull(),
    adapterKind: text("adapter_kind").notNull(),
    ownerOrganizationId: uuid("owner_organization_id")
      .notNull()
      .references(() => organizations.id),
    expectedFreshnessHours: integer("expected_freshness_hours").notNull(),
    lifecycle: lifecycleStateEnum().notNull(),
    lastSuccessfulAt: timestamp("last_successful_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastFailedAt: timestamp("last_failed_at", {
      withTimezone: true,
      mode: "string",
    }),
    currentSyncRunId: uuid("current_sync_run_id"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("inventory_sources_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("inventory_sources_name_unique").on(table.name),
    check(
      "inventory_sources_freshness_check",
      sql.raw("expected_freshness_hours > 0"),
    ),
    positiveVersion("inventory_sources_row_version_check", table.rowVersion),
  ],
);

export const inventorySyncRuns = pgTable(
  "inventory_sync_runs",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => inventorySources.id),
    sourceVersion: text("source_version").notNull(),
    status: syncStatusEnum().notNull(),
    recordCount: integer("record_count").notNull(),
    contentHash: text("content_hash"),
    sanitizedError: text("sanitized_error"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("inventory_sync_runs_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("inventory_sync_runs_source_version_unique").on(
      table.sourceId,
      table.sourceVersion,
    ),
    uniqueIndex("inventory_sync_runs_parent_id_unique").on(
      table.id,
      table.sourceId,
    ),
    check("inventory_sync_runs_count_check", sql.raw("record_count >= 0")),
    check(
      "inventory_sync_runs_error_check",
      sql.raw(
        "status <> 'failed' OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)",
      ),
    ),
  ],
);

export const inventorySourceRecords = pgTable(
  "inventory_source_records",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    runId: uuid("run_id")
      .notNull()
      .references(() => inventorySyncRuns.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => inventorySources.id),
    sourceRecordKey: text("source_record_key").notNull(),
    state: sourceRecordStateEnum().notNull(),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull(),
    normalizedFields: jsonb("normalized_fields")
      .$type<Record<string, unknown>>()
      .notNull(),
    contentHash: text("content_hash").notNull(),
    priorRecordId: uuid("prior_record_id"),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("inventory_source_records_fixture_key_unique").on(
      table.fixtureKey,
    ),
    uniqueIndex("inventory_source_records_run_key_unique").on(
      table.runId,
      table.sourceRecordKey,
    ),
    index("inventory_source_records_source_key_idx").on(
      table.sourceId,
      table.sourceRecordKey,
      table.observedAt,
    ),
  ],
);

export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    itemKey: text("item_key").notNull(),
    publicationState: catalogStateEnum("publication_state").notNull(),
    approvalStatus: approvalStatusEnum("approval_status").notNull(),
    itemType: catalogItemTypeEnum("item_type").notNull(),
    currentVersion: integer("current_version").notNull(),
    name: text().notNull(),
    vendor: text(),
    description: text().notNull(),
    capabilities: text().array().notNull(),
    ownerOrganizationId: uuid("owner_organization_id")
      .notNull()
      .references(() => organizations.id),
    licenseModel: text("license_model"),
    dataClassifications: text("data_classifications").array().notNull(),
    integrations: text().array().notNull(),
    reviewDate: date("review_date").notNull(),
    renewalDate: date("renewal_date"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("catalog_items_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("catalog_items_key_unique").on(table.itemKey),
    index("catalog_items_matching_idx").on(
      table.publicationState,
      table.approvalStatus,
      table.itemType,
    ),
    positiveVersion("catalog_items_version_check", table.currentVersion),
    positiveVersion("catalog_items_row_version_check", table.rowVersion),
  ],
);

export const inventoryAliases = pgTable(
  "inventory_aliases",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    alias: text().notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    sourceId: uuid("source_id").references(() => inventorySources.id),
    catalogItemId: uuid("catalog_item_id").references(() => catalogItems.id),
    createdByActorId: uuid("created_by_actor_id")
      .notNull()
      .references(() => actors.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("inventory_aliases_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("inventory_aliases_scope_unique").on(
      table.normalizedAlias,
      table.sourceId,
    ),
  ],
);

export const inventoryConflicts = pgTable(
  "inventory_conflicts",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    catalogItemId: uuid("catalog_item_id").references(() => catalogItems.id),
    state: conflictStateEnum().notNull(),
    openedByRunId: uuid("opened_by_run_id")
      .notNull()
      .references(() => inventorySyncRuns.id),
    reopenedByRunId: uuid("reopened_by_run_id").references(
      () => inventorySyncRuns.id,
    ),
    currentEvidenceVersion: integer("current_evidence_version")
      .notNull()
      .default(1),
    currentResolutionVersion: integer("current_resolution_version"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("inventory_conflicts_fixture_key_unique").on(table.fixtureKey),
    index("inventory_conflicts_state_idx").on(table.state, table.updatedAt),
    positiveVersion(
      "inventory_conflicts_evidence_version_check",
      table.currentEvidenceVersion,
    ),
    positiveVersion("inventory_conflicts_row_version_check", table.rowVersion),
  ],
);

export const inventoryConflictMembers = pgTable(
  "inventory_conflict_members",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    conflictId: uuid("conflict_id")
      .notNull()
      .references(() => inventoryConflicts.id),
    evidenceVersion: integer("evidence_version").notNull(),
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => inventorySourceRecords.id),
    groupingReason: text("grouping_reason").notNull(),
  },
  (table) => [
    uniqueIndex("inventory_conflict_members_fixture_key_unique").on(
      table.fixtureKey,
    ),
    uniqueIndex("inventory_conflict_members_unique").on(
      table.conflictId,
      table.evidenceVersion,
      table.sourceRecordId,
    ),
    positiveVersion(
      "inventory_conflict_members_version_check",
      table.evidenceVersion,
    ),
  ],
);

export const catalogFieldDecisions = pgTable(
  "catalog_field_decisions",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    catalogItemId: uuid("catalog_item_id")
      .notNull()
      .references(() => catalogItems.id),
    canonicalVersion: integer("canonical_version").notNull(),
    fieldName: text("field_name").notNull(),
    value: jsonb().$type<unknown>().notNull(),
    sourceRecordId: uuid("source_record_id").references(
      () => inventorySourceRecords.id,
    ),
    decidedByActorId: uuid("decided_by_actor_id")
      .notNull()
      .references(() => actors.id),
    rationale: text(),
    supersedesId: uuid("supersedes_id"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("catalog_field_decisions_fixture_key_unique").on(
      table.fixtureKey,
    ),
    uniqueIndex("catalog_field_decisions_version_field_unique").on(
      table.catalogItemId,
      table.canonicalVersion,
      table.fieldName,
    ),
    positiveVersion(
      "catalog_field_decisions_version_check",
      table.canonicalVersion,
    ),
    check(
      "catalog_field_decisions_provenance_check",
      sql.raw(
        "source_record_id IS NOT NULL OR (rationale IS NOT NULL AND length(trim(rationale)) > 0)",
      ),
    ),
  ],
);

export const catalogItemSources = pgTable(
  "catalog_item_sources",
  {
    catalogItemId: uuid("catalog_item_id")
      .notNull()
      .references(() => catalogItems.id),
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => inventorySourceRecords.id),
    fixtureKey: text("fixture_key"),
  },
  (table) => [
    uniqueIndex("catalog_item_sources_unique").on(
      table.catalogItemId,
      table.sourceRecordId,
    ),
    uniqueIndex("catalog_item_sources_fixture_key_unique").on(table.fixtureKey),
  ],
);

export const reviewTasks = pgTable(
  "review_tasks",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    area: reviewAreaEnum().notNull(),
    responsibleCapability: text("responsible_capability").notNull(),
    assigneeActorId: uuid("assignee_actor_id").references(() => actors.id),
    state: reviewTaskStateEnum().notNull(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    // The asset or risk assessment this completion reviewed; identity, not
    // creation order, decides whether the completion applies to what is
    // current now.
    completedAssessmentId: uuid("completed_assessment_id"),
  },
  (table) => [
    uniqueIndex("review_tasks_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("review_tasks_request_area_unique").on(
      table.requestId,
      table.area,
    ),
    index("review_tasks_assignee_state_idx").on(
      table.assigneeActorId,
      table.state,
    ),
    positiveVersion("review_tasks_row_version_check", table.rowVersion),
  ],
);

export const assetAssessments = pgTable(
  "asset_assessments",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id),
    modelCallId: uuid("model_call_id").references(() => modelCalls.id),
    status: assessmentStatusEnum().notNull(),
    catalogCorpusHash: text("catalog_corpus_hash").notNull(),
    revisionId: uuid("revision_id").references(
      () => requestContentRevisions.id,
    ),
    requestGeneration: integer("request_generation").notNull().default(1),
    sanitizedError: text("sanitized_error"),
    origin: dataOriginEnum().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("asset_assessments_fixture_key_unique").on(table.fixtureKey),
    check(
      "asset_assessments_status_check",
      sql.raw(
        "(status = 'succeeded' AND sanitized_error IS NULL) OR (status = 'failed' AND sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)",
      ),
    ),
  ],
);

// Defined before its parent so asset_candidates can reference the current
// decision. The migration adds the reverse and same-parent foreign keys.
export const assetCandidateDecisions = pgTable(
  "asset_candidate_decisions",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    candidateId: uuid("candidate_id").notNull(),
    decision: candidateDecisionEnum().notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    reason: text(),
    origin: dataOriginEnum().notNull(),
    requestGeneration: integer("request_generation").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("asset_candidate_decisions_fixture_key_unique").on(
      table.fixtureKey,
    ),
    uniqueIndex("asset_candidate_decisions_parent_id_unique").on(
      table.id,
      table.candidateId,
    ),
    check(
      "asset_candidate_decisions_reason_check",
      sql.raw(
        "decision <> 'rejected' OR (reason IS NOT NULL AND length(trim(reason)) > 0)",
      ),
    ),
  ],
);

export const assetCandidates = pgTable(
  "asset_candidates",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => assetAssessments.id),
    catalogItemId: uuid("catalog_item_id")
      .notNull()
      .references(() => catalogItems.id),
    catalogVersion: integer("catalog_version").notNull(),
    /** The catalog name at proposal time; null for rows predating capture. */
    name: text(),
    rank: smallint().notNull(),
    fitBand: fitBandEnum("fit_band").notNull(),
    coverage: text().array().notNull(),
    gaps: text().array().notNull(),
    dependencies: text().array().notNull(),
    rationale: text().notNull(),
    currentDecisionId: uuid("current_decision_id").references(
      () => assetCandidateDecisions.id,
    ),
  },
  (table) => [
    uniqueIndex("asset_candidates_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("asset_candidates_assessment_rank_unique").on(
      table.assessmentId,
      table.rank,
    ),
    positiveVersion("asset_candidates_version_check", table.catalogVersion),
    check("asset_candidates_rank_check", sql.raw("rank > 0")),
  ],
);

// The requester's own fit verdict on a recommended existing asset, recorded
// during intake. Insert-only history, separate from reviewer candidate
// decisions; currency derives from the candidate's assessment model call.
export const assetFitDecisions = pgTable(
  "asset_fit_decisions",
  {
    id: uuid().primaryKey(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => assetCandidates.id),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => assetAssessments.id),
    decision: candidateDecisionEnum().notNull(),
    reason: text(),
    visitorId: uuid("visitor_id")
      .notNull()
      .references(() => visitors.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    createdAt: createdAt(),
  },
  (table) => [
    index("asset_fit_decisions_draft_idx").on(table.draftId),
    check(
      "asset_fit_decisions_decision_check",
      sql.raw("decision IN ('accepted', 'rejected', 'cleared')"),
    ),
    check(
      "asset_fit_decisions_reason_check",
      sql.raw(
        "decision <> 'rejected' OR (reason IS NOT NULL AND length(trim(reason)) > 0)",
      ),
    ),
  ],
);

export const policyRules = pgTable(
  "policy_rules",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    code: text().notNull(),
    version: integer().notNull(),
    supersedesId: uuid("supersedes_id"),
    lifecycle: lifecycleStateEnum().notNull(),
    domain: riskDomainEnum().notNull(),
    title: text().notNull(),
    rule: text().notNull(),
    triggerTerms: text("trigger_terms").array().notNull(),
    defaultSeverity: riskSeverityEnum("default_severity").notNull(),
    citation: text().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("policy_rules_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("policy_rules_code_version_unique").on(
      table.code,
      table.version,
    ),
    uniqueIndex("policy_rules_one_active_code")
      .on(table.code)
      .where(sql.raw("lifecycle = 'active'")),
    index("policy_rules_domain_idx").on(table.domain),
    positiveVersion("policy_rules_version_check", table.version),
  ],
);

export const riskAssessments = pgTable(
  "risk_assessments",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id),
    modelCallId: uuid("model_call_id").references(() => modelCalls.id),
    status: assessmentStatusEnum().notNull(),
    policyCorpusHash: text("policy_corpus_hash").notNull(),
    revisionId: uuid("revision_id").references(
      () => requestContentRevisions.id,
    ),
    requestGeneration: integer("request_generation").notNull().default(1),
    sanitizedError: text("sanitized_error"),
    origin: dataOriginEnum().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("risk_assessments_fixture_key_unique").on(table.fixtureKey),
    check(
      "risk_assessments_status_check",
      sql.raw(
        "(status = 'succeeded' AND sanitized_error IS NULL) OR (status = 'failed' AND sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)",
      ),
    ),
  ],
);

// Defined before its parent for the same reason as asset decisions.
export const riskFindingDecisions = pgTable(
  "risk_finding_decisions",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    findingId: uuid("finding_id").notNull(),
    decision: riskDecisionEnum().notNull(),
    finalSeverity: riskSeverityEnum("final_severity"),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    rationale: text(),
    origin: dataOriginEnum().notNull(),
    requestGeneration: integer("request_generation").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("risk_finding_decisions_fixture_key_unique").on(
      table.fixtureKey,
    ),
    uniqueIndex("risk_finding_decisions_parent_id_unique").on(
      table.id,
      table.findingId,
    ),
    check(
      "risk_finding_decisions_rationale_check",
      sql.raw(
        "decision NOT IN ('overridden', 'follow_up_required') OR (rationale IS NOT NULL AND length(trim(rationale)) > 0)",
      ),
    ),
    check(
      "risk_finding_decisions_severity_check",
      sql.raw("decision <> 'overridden' OR final_severity IS NOT NULL"),
    ),
    check(
      "risk_finding_decisions_override_severity_check",
      sql.raw("final_severity IS NULL OR decision = 'overridden'"),
    ),
  ],
);

export const riskFindings = pgTable(
  "risk_findings",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => riskAssessments.id),
    policyRuleId: uuid("policy_rule_id")
      .notNull()
      .references(() => policyRules.id),
    kind: riskKindEnum().notNull(),
    evidence: text(),
    missingInformation: text("missing_information"),
    proposedSeverity: riskSeverityEnum("proposed_severity"),
    rationale: text().notNull(),
    currentDecisionId: uuid("current_decision_id").references(
      () => riskFindingDecisions.id,
    ),
  },
  (table) => [
    uniqueIndex("risk_findings_fixture_key_unique").on(table.fixtureKey),
    check(
      "risk_findings_kind_check",
      sql.raw(
        "(kind = 'supported_risk' AND evidence IS NOT NULL AND proposed_severity IS NOT NULL AND missing_information IS NULL) OR (kind = 'missing_information' AND evidence IS NULL AND proposed_severity IS NULL AND missing_information IS NOT NULL AND length(trim(missing_information)) > 0)",
      ),
    ),
  ],
);

export const riceScores = pgTable(
  "rice_scores",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    version: integer().notNull(),
    reach: numeric({ precision: 14, scale: 2 }).notNull(),
    reachUnit: text("reach_unit").notNull(),
    reachPeriod: text("reach_period").notNull(),
    reachRationale: text("reach_rationale").notNull(),
    reachActorId: uuid("reach_actor_id")
      .notNull()
      .references(() => actors.id),
    impact: numeric({ precision: 6, scale: 2 }).notNull(),
    impactRationale: text("impact_rationale").notNull(),
    impactActorId: uuid("impact_actor_id")
      .notNull()
      .references(() => actors.id),
    confidence: numeric({ precision: 5, scale: 4 }).notNull(),
    confidenceRationale: text("confidence_rationale").notNull(),
    confidenceActorId: uuid("confidence_actor_id")
      .notNull()
      .references(() => actors.id),
    effort: numeric({ precision: 10, scale: 2 }).notNull(),
    effortRationale: text("effort_rationale").notNull(),
    effortActorId: uuid("effort_actor_id")
      .notNull()
      .references(() => actors.id),
    score: numeric({ precision: 16, scale: 4 }).notNull(),
    rubricVersion: text("rubric_version").notNull(),
    formulaVersion: text("formula_version").notNull(),
    createdByActorId: uuid("created_by_actor_id")
      .notNull()
      .references(() => actors.id),
    origin: dataOriginEnum().notNull(),
    requestGeneration: integer("request_generation").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("rice_scores_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("rice_scores_request_version_unique").on(
      table.requestId,
      table.version,
    ),
    uniqueIndex("rice_scores_parent_id_unique").on(table.id, table.requestId),
    positiveVersion("rice_scores_version_check", table.version),
    check("rice_scores_reach_check", sql.raw("reach >= 0")),
    check("rice_scores_impact_check", sql.raw("impact > 0")),
    check(
      "rice_scores_confidence_check",
      sql.raw("confidence > 0 AND confidence <= 1"),
    ),
    check("rice_scores_effort_check", sql.raw("effort > 0")),
    check(
      "rice_scores_basis_check",
      sql.raw(
        "length(trim(reach_unit)) > 0 AND length(trim(reach_period)) > 0",
      ),
    ),
    check(
      "rice_scores_formula_check",
      sql.raw(
        "formula_version <> 'rice-v1' OR abs(score - ((reach * impact * confidence) / effort)) < 0.0001",
      ),
    ),
  ],
);

export const deliveryHandoffs = pgTable(
  "delivery_handoffs",
  {
    id: uuid().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    targetSystem: externalSystemEnum("target_system").notNull(),
    nextOwner: text("next_owner").notNull(),
    workPlan: jsonb("work_plan")
      .$type<
        Array<{ title: string; relationship: "required" | "supporting" }>
      >()
      .notNull(),
    retryKey: text("retry_key").notNull(),
    status: handoffStatusEnum().notNull(),
    sanitizedError: text("sanitized_error"),
    confirmedAt: timestamp("confirmed_at", {
      withTimezone: true,
      mode: "string",
    }),
    requestGeneration: integer("request_generation").notNull().default(1),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("delivery_handoffs_request_unique").on(
      table.requestId,
      table.requestGeneration,
    ),
    uniqueIndex("delivery_handoffs_retry_key_unique").on(table.retryKey),
    positiveVersion("delivery_handoffs_row_version_check", table.rowVersion),
  ],
);

export const requestResolutions = pgTable(
  "request_resolutions",
  {
    id: uuid().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    outcome: resolutionOutcomeEnum().notNull(),
    summary: text().notNull(),
    reason: text(),
    resolvedByActorId: uuid("resolved_by_actor_id")
      .notNull()
      .references(() => actors.id),
    requestGeneration: integer("request_generation").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("request_resolutions_request_unique").on(
      table.requestId,
      table.requestGeneration,
    ),
  ],
);

export const workSystems = pgTable(
  "work_systems",
  {
    system: externalSystemEnum().primaryKey(),
    fixtureKey: text("fixture_key"),
    name: text().notNull(),
    authoritativeBaseUrl: text("authoritative_base_url").notNull(),
    expectedFreshnessHours: integer("expected_freshness_hours").notNull(),
    lastSuccessfulAt: timestamp("last_successful_at", {
      withTimezone: true,
      mode: "string",
    }),
    syncHealth: syncHealthEnum("sync_health").notNull(),
  },
  (table) => [
    uniqueIndex("work_systems_fixture_key_unique").on(table.fixtureKey),
    check(
      "work_systems_freshness_check",
      sql.raw("expected_freshness_hours > 0"),
    ),
  ],
);

export const workSyncRuns = pgTable(
  "work_sync_runs",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    system: externalSystemEnum()
      .notNull()
      .references(() => workSystems.system),
    status: syncStatusEnum().notNull(),
    itemCount: integer("item_count").notNull(),
    sanitizedError: text("sanitized_error"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("work_sync_runs_fixture_key_unique").on(table.fixtureKey),
    check("work_sync_runs_count_check", sql.raw("item_count >= 0")),
    check(
      "work_sync_runs_error_check",
      sql.raw(
        "status <> 'failed' OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)",
      ),
    ),
  ],
);

export const externalWorkItems = pgTable(
  "external_work_items",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
    system: externalSystemEnum()
      .notNull()
      .references(() => workSystems.system),
    externalId: text("external_id").notNull(),
    title: text().notNull(),
    sourceStatus: text("source_status").notNull(),
    sourceOwner: text("source_owner"),
    sourceUrl: text("source_url").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    lastSynchronizedAt: timestamp("last_synchronized_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    syncHealth: syncHealthEnum("sync_health").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("external_work_items_fixture_key_unique").on(table.fixtureKey),
    uniqueIndex("external_work_items_system_id_unique").on(
      table.system,
      table.externalId,
    ),
    index("external_work_items_health_idx").on(
      table.system,
      table.syncHealth,
      table.sourceUpdatedAt,
    ),
  ],
);

export const requestWorkItemLinks = pgTable(
  "request_work_item_links",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => externalWorkItems.id),
    relationship: text().notNull(),
    fixtureKey: text("fixture_key"),
    handoffId: uuid("handoff_id").references(() => deliveryHandoffs.id),
    requestGeneration: integer("request_generation").notNull().default(1),
  },
  (table) => [
    primaryKey({
      columns: [table.requestId, table.workItemId, table.requestGeneration],
    }),
    uniqueIndex("request_work_item_links_fixture_key_unique").on(
      table.fixtureKey,
    ),
  ],
);

export const modelJobs = pgTable(
  "model_jobs",
  {
    id: uuid().primaryKey(),
    purpose: modelPurposeEnum().notNull(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id),
    requestId: uuid("request_id").references(() => requests.id),
    revisionId: uuid("revision_id").references(
      () => requestContentRevisions.id,
    ),
    visitorId: uuid("visitor_id").references(() => visitors.id),
    inputHash: text("input_hash").notNull(),
    corpusHash: text("corpus_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    requestGeneration: integer("request_generation").notNull().default(1),
    status: modelJobStatusEnum().notNull(),
    attemptCount: smallint("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    inputSnapshot: jsonb("input_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    corpusSnapshot: jsonb("corpus_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    currentModelCallId: uuid("current_model_call_id").references(
      () => modelCalls.id,
    ),
    sanitizedError: text("sanitized_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("model_jobs_logical_unique").on(
      table.purpose,
      table.draftId,
      table.inputHash,
      table.corpusHash,
      table.promptVersion,
      table.requestGeneration,
    ),
    index("model_jobs_ready_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    index("model_jobs_draft_idx").on(table.draftId, table.purpose),
    check("model_jobs_attempt_check", sql.raw("attempt_count BETWEEN 0 AND 2")),
    check(
      "model_jobs_lease_check",
      sql.raw(
        "(status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)",
      ),
    ),
    check(
      "model_jobs_error_check",
      sql.raw(
        "status NOT IN ('failed', 'capped') OR (sanitized_error IS NOT NULL AND length(trim(sanitized_error)) > 0)",
      ),
    ),
  ],
);
