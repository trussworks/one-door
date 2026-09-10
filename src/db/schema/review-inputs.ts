import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  reviewInputAudiences,
  reviewInputOutcomes,
  reviewInputResolutions,
  reviewInputStates,
} from "../../domain/review-inputs.ts";
import { actors, visitors } from "./identity.ts";
import { priorityContributions } from "./priority.ts";
import { requestContentRevisions, requests } from "./requests.ts";
import { assetCandidates, riskFindings } from "./review.ts";
import {
  createdAt,
  positiveVersion,
  reviewAreaEnum,
  updatedAt,
} from "./shared.ts";

export const reviewInputRequests = pgTable(
  "review_input_requests",
  {
    id: uuid().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    revisionId: uuid("revision_id").references(
      () => requestContentRevisions.id,
    ),
    requestGeneration: integer("request_generation").notNull(),
    area: reviewAreaEnum().notNull(),
    audience: text({ enum: reviewInputAudiences }).notNull(),
    factor: text({ enum: ["reach", "impact", "confidence", "effort"] }),
    candidateId: uuid("candidate_id").references(() => assetCandidates.id),
    findingId: uuid("finding_id").references(() => riskFindings.id),
    question: text().notNull(),
    scope: text(),
    expertise: text(),
    askedByActorId: uuid("asked_by_actor_id")
      .notNull()
      .references(() => actors.id),
    askedByVisitorId: uuid("asked_by_visitor_id").references(() => visitors.id),
    assigneeActorId: uuid("assignee_actor_id").references(() => actors.id),
    assignedByActorId: uuid("assigned_by_actor_id").references(() => actors.id),
    state: text({ enum: reviewInputStates }).notNull().default("open"),
    rowVersion: integer("row_version").notNull().default(1),
    resolvedByActorId: uuid("resolved_by_actor_id").references(() => actors.id),
    resolutionKind: text("resolution_kind", { enum: reviewInputResolutions }),
    resolutionId: uuid("resolution_id"),
    resolvedAt: timestamp("resolved_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("review_input_requests_request_idx").on(
      table.requestId,
      table.createdAt,
    ),
    index("review_input_requests_assignee_idx").on(
      table.assigneeActorId,
      table.state,
    ),
    index("review_input_requests_asker_idx").on(
      table.askedByActorId,
      table.state,
    ),
    positiveVersion("review_input_requests_version_check", table.rowVersion),
    check(
      "review_input_requests_generation_check",
      sql.raw("request_generation > 0"),
    ),
    check(
      "review_input_requests_audience_check",
      sql.raw("audience IN ('internal', 'requester')"),
    ),
    check(
      "review_input_requests_state_check",
      sql.raw("state IN ('open', 'answered', 'resolved')"),
    ),
    check(
      "review_input_requests_question_check",
      sql.raw("length(trim(question)) BETWEEN 1 AND 2000"),
    ),
    check(
      "review_input_requests_target_check",
      sql.raw(`
      (factor IS NULL OR (area = 'rice' AND factor IN ('reach', 'impact', 'confidence', 'effort')))
      AND (candidate_id IS NULL OR area = 'assets')
      AND (finding_id IS NULL OR area = 'risk')
    `),
    ),
    check(
      "review_input_requests_requester_check",
      sql.raw("audience <> 'requester' OR assignee_actor_id IS NULL"),
    ),
    check(
      "review_input_requests_resolution_check",
      sql.raw(`
      (state = 'resolved' AND resolved_by_actor_id IS NOT NULL AND resolved_at IS NOT NULL
        AND resolution_id IS NOT NULL AND resolution_kind IN
          ('candidate_decision', 'risk_decision', 'priority_contribution', 'area_outcome'))
      OR (state <> 'resolved' AND resolved_by_actor_id IS NULL AND resolved_at IS NULL
        AND resolution_id IS NULL AND resolution_kind IS NULL)
    `),
    ),
  ],
);

export const reviewInputResponses = pgTable(
  "review_input_responses",
  {
    id: uuid().primaryKey(),
    inputRequestId: uuid("input_request_id")
      .notNull()
      .references(() => reviewInputRequests.id),
    inputVersion: integer("input_version").notNull(),
    revisionId: uuid("revision_id").references(
      () => requestContentRevisions.id,
    ),
    requestGeneration: integer("request_generation").notNull(),
    answer: text().notNull(),
    outcome: text({ enum: reviewInputOutcomes }).notNull(),
    respondentActorId: uuid("respondent_actor_id")
      .notNull()
      .references(() => actors.id),
    recordedByActorId: uuid("recorded_by_actor_id")
      .notNull()
      .references(() => actors.id),
    visitorId: uuid("visitor_id").references(() => visitors.id),
    contributionId: uuid("contribution_id").references(
      () => priorityContributions.id,
    ),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("review_input_responses_version_unique").on(
      table.inputRequestId,
      table.inputVersion,
    ),
    check(
      "review_input_responses_answer_check",
      sql.raw("length(trim(answer)) BETWEEN 1 AND 5000"),
    ),
    check(
      "review_input_responses_outcome_check",
      sql.raw("outcome IN ('provided', 'unknown')"),
    ),
    check(
      "review_input_responses_unknown_check",
      sql.raw("outcome <> 'unknown' OR contribution_id IS NULL"),
    ),
    check(
      "review_input_responses_generation_check",
      sql.raw("request_generation > 0"),
    ),
    positiveVersion("review_input_responses_version_check", table.inputVersion),
  ],
);
