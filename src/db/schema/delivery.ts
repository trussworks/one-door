import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { actors } from "./identity.ts";
import { requests } from "./requests.ts";
import {
  createdAt,
  externalSystemEnum,
  handoffStatusEnum,
  positiveVersion,
  resolutionOutcomeEnum,
  syncHealthEnum,
  syncStatusEnum,
} from "./shared.ts";

export const deliveryHandoffs = pgTable(
  "delivery_handoffs",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
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
    uniqueIndex("delivery_handoffs_fixture_key_unique").on(table.fixtureKey),
    positiveVersion("delivery_handoffs_row_version_check", table.rowVersion),
  ],
);
export const requestResolutions = pgTable(
  "request_resolutions",
  {
    id: uuid().primaryKey(),
    fixtureKey: text("fixture_key"),
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
    uniqueIndex("request_resolutions_fixture_key_unique").on(table.fixtureKey),
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
