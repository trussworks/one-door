import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { actors, organizations } from "./identity.ts";
import {
  approvalStatusEnum,
  catalogItemTypeEnum,
  catalogStateEnum,
  conflictStateEnum,
  createdAt,
  lifecycleStateEnum,
  positiveVersion,
  sourceRecordStateEnum,
  syncStatusEnum,
  updatedAt,
} from "./shared.ts";

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
