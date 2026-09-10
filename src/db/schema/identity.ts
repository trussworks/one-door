import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  actingViewEnum,
  actorKindEnum,
  createdAt,
  dataOriginEnum,
  organizationKindEnum,
  positiveVersion,
  updatedAt,
} from "./shared.ts";
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
