import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { actors, organizations, visitors } from "./identity.ts";
import {
  actingViewEnum,
  candidateDecisionEnum,
  createdAt,
  dataOriginEnum,
  draftStateEnum,
  fitBandEnum,
  lifecycleStateEnum,
  modelJobStatusEnum,
  modelPurposeEnum,
  modelStatusEnum,
  positiveVersion,
  requestStageEnum,
  revisionSourceEnum,
  routingStateEnum,
  taskTypeEnum,
  turnActorEnum,
  updatedAt,
} from "./shared.ts";

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
        `
        (status = 'reserved'
          AND completed_at IS NULL)
        OR (status IN ('succeeded', 'failed', 'denied')
          AND completed_at IS NOT NULL)
      `,
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
        `
        (actor = 'customer'
          AND actor_id IS NOT NULL
          AND model_call_id IS NULL)
        OR (actor = 'assistant'
          AND actor_id IS NULL
          AND model_call_id IS NOT NULL)
      `,
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
        `
        (decision IS NULL
          AND decided_by_actor_id IS NULL
          AND decision_reason IS NULL
          AND decided_at IS NULL)
        OR (decision IS NOT NULL
          AND decided_by_actor_id IS NOT NULL
          AND decided_at IS NOT NULL)
      `,
      ),
    ),
    check(
      "service_candidates_rejection_reason_check",
      sql.raw(
        `
        decision <> 'rejected'
        OR (decision_reason IS NOT NULL
          AND length(trim(decision_reason)) > 0)
      `,
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
    deliveryOwnerActorId: uuid("delivery_owner_actor_id").references(
      () => actors.id,
    ),
    nextTask: text("next_task"),
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
        `
        (routing_state = 'service_selected'
          AND selected_service_candidate_id IS NOT NULL)
        OR (routing_state = 'routing_requested'
          AND selected_service_candidate_id IS NULL)
      `,
      ),
    ),
    check(
      "requests_next_task_check",
      sql.raw("next_task IS NULL OR length(trim(next_task)) > 0"),
    ),
    check(
      "requests_delivery_pair_check",
      sql.raw("(delivery_owner_actor_id IS NULL) = (next_task IS NULL)"),
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
    fixtureKey: text("fixture_key"),
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
    uniqueIndex("clarification_requests_fixture_key_unique").on(
      table.fixtureKey,
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
        `
        (answered_at IS NULL
          AND answer IS NULL
          AND answer_revision_id IS NULL)
        OR (answered_at IS NOT NULL
          AND answer IS NOT NULL
          AND length(trim(answer)) > 0
          AND answer_revision_id IS NOT NULL)
      `,
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
        `
        (task_type = 'requester_submission'
          AND acting_view = 'requester')
        OR (task_type = 'contributor_first_review'
          AND acting_view = 'contributor')
      `,
      ),
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
        `
        (status = 'leased'
          AND lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL)
        OR (status <> 'leased'
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL)
      `,
      ),
    ),
    check(
      "model_jobs_error_check",
      sql.raw(
        `
        status NOT IN ('failed', 'capped')
        OR (sanitized_error IS NOT NULL
          AND length(trim(sanitized_error)) > 0)
      `,
      ),
    ),
  ],
);
