import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type {
  PriorityDecisionInput,
  PriorityEstimate,
  PriorityFactor,
} from "../../domain/priority.ts";
import { actors } from "./identity.ts";
import { requestContentRevisions, requests } from "./requests.ts";
import { riceScores } from "./review.ts";
import { createdAt } from "./shared.ts";

export const priorityContributions = pgTable(
  "priority_contributions",
  {
    id: uuid().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    revisionId: uuid("revision_id"),
    requestGeneration: integer("request_generation").notNull(),
    factor: text().$type<PriorityFactor>().notNull(),
    estimate: jsonb().$type<PriorityEstimate>().notNull(),
    source: text().$type<"requester" | "contributor">().notNull(),
    suppliedByActorId: uuid("supplied_by_actor_id")
      .notNull()
      .references(() => actors.id),
    recordedByActorId: uuid("recorded_by_actor_id")
      .notNull()
      .references(() => actors.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("priority_contributions_parent_unique").on(
      table.id,
      table.requestId,
      table.factor,
    ),
    index("priority_contributions_request_idx").on(
      table.requestId,
      table.requestGeneration,
    ),
    foreignKey({
      columns: [table.revisionId, table.requestId],
      foreignColumns: [
        requestContentRevisions.id,
        requestContentRevisions.requestId,
      ],
      name: "priority_contributions_revision_fk",
    }),
    check(
      "priority_contributions_factor_check",
      sql.raw("factor IN ('reach', 'impact', 'confidence', 'effort')"),
    ),
    check(
      "priority_contributions_source_check",
      sql.raw("source IN ('requester', 'contributor')"),
    ),
    check(
      "priority_contributions_generation_check",
      sql.raw("request_generation > 0"),
    ),
  ],
);

export const priorityDecisions = pgTable(
  "priority_decisions",
  {
    id: uuid().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    revisionId: uuid("revision_id"),
    requestGeneration: integer("request_generation").notNull(),
    sequence: integer().notNull(),
    factor: text().$type<PriorityFactor>().notNull(),
    action: text().$type<PriorityDecisionInput["action"]>().notNull(),
    proposalId: uuid("proposal_id"),
    estimate: jsonb().$type<PriorityEstimate>(),
    suppliedByActorId: uuid("supplied_by_actor_id").references(() => actors.id),
    recordedByActorId: uuid("recorded_by_actor_id")
      .notNull()
      .references(() => actors.id),
    reviewerActorId: uuid("reviewer_actor_id")
      .notNull()
      .references(() => actors.id),
    baseScoreId: uuid("base_score_id"),
    reason: text(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("priority_decisions_sequence_unique").on(
      table.requestId,
      table.sequence,
    ),
    foreignKey({
      columns: [table.proposalId, table.requestId, table.factor],
      foreignColumns: [
        priorityContributions.id,
        priorityContributions.requestId,
        priorityContributions.factor,
      ],
      name: "priority_decisions_proposal_fk",
    }),
    foreignKey({
      columns: [table.revisionId, table.requestId],
      foreignColumns: [
        requestContentRevisions.id,
        requestContentRevisions.requestId,
      ],
      name: "priority_decisions_revision_fk",
    }),
    foreignKey({
      columns: [table.baseScoreId, table.requestId],
      foreignColumns: [riceScores.id, riceScores.requestId],
      name: "priority_decisions_base_score_fk",
    }),
    check(
      "priority_decisions_factor_check",
      sql.raw("factor IN ('reach', 'impact', 'confidence', 'effort')"),
    ),
    check(
      "priority_decisions_action_check",
      sql.raw("action IN ('adopt', 'replace', 'reject')"),
    ),
    check(
      "priority_decisions_value_check",
      sql.raw(
        "(action = 'reject' AND estimate IS NULL AND supplied_by_actor_id IS NULL AND reason IS NOT NULL AND length(trim(reason)) > 0) OR (action IN ('adopt', 'replace') AND estimate IS NOT NULL AND supplied_by_actor_id IS NOT NULL)",
      ),
    ),
    check(
      "priority_decisions_adopt_check",
      sql.raw("action <> 'adopt' OR proposal_id IS NOT NULL"),
    ),
    check(
      "priority_decisions_generation_check",
      sql.raw("request_generation > 0 AND sequence > 0"),
    ),
  ],
);
