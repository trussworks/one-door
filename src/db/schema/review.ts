import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { actors, visitors } from "./identity.ts";
import { catalogItems } from "./inventory.ts";
import {
  drafts,
  modelCalls,
  requestContentRevisions,
  requests,
} from "./requests.ts";
import {
  assessmentStatusEnum,
  candidateDecisionEnum,
  createdAt,
  dataOriginEnum,
  fitBandEnum,
  lifecycleStateEnum,
  positiveVersion,
  reviewAreaEnum,
  reviewTaskStateEnum,
  riskDecisionEnum,
  riskDomainEnum,
  riskKindEnum,
  riskSeverityEnum,
  updatedAt,
} from "./shared.ts";

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
        `
        (status = 'succeeded'
          AND sanitized_error IS NULL)
        OR (status = 'failed'
          AND sanitized_error IS NOT NULL
          AND length(trim(sanitized_error)) > 0)
      `,
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
    fitBand: fitBandEnum("fit_band"),
    proposedByActorId: uuid("proposed_by_actor_id").references(() => actors.id),
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
        `
        (status = 'succeeded'
          AND sanitized_error IS NULL)
        OR (status = 'failed'
          AND sanitized_error IS NOT NULL
          AND length(trim(sanitized_error)) > 0)
      `,
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
        `
        decision NOT IN ('overridden', 'follow_up_required')
        OR (rationale IS NOT NULL
          AND length(trim(rationale)) > 0)
      `,
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
        `
        (kind = 'supported_risk'
          AND evidence IS NOT NULL
          AND proposed_severity IS NOT NULL
          AND missing_information IS NULL)
        OR (kind = 'missing_information'
          AND evidence IS NULL
          AND proposed_severity IS NULL
          AND missing_information IS NOT NULL
          AND length(trim(missing_information)) > 0)
      `,
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
        `
        formula_version <> 'rice-v1'
        OR abs(score - ((reach * impact * confidence) / effort)) < 0.0001
      `,
      ),
    ),
  ],
);
