import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  externalWorkItems,
  inventorySources,
  workSystems,
} from "../db/schema.ts";
import { defaultWaitThresholds } from "../domain/business-days.ts";
import {
  parseInput,
  withReadSnapshot,
  type Db,
  type Tx,
} from "../workflow/shared.ts";
import {
  enrichedRequests,
  thresholdsSchema,
  type AttentionFlags,
} from "./read-model.ts";

/**
 * Administrator dashboard: every request once (linked work is nested, never
 * a second request row), unlinked external items, and source health.
 */
export async function dashboardView(optionsInput: unknown = {}) {
  const options = parseInput(dashboardOptionsSchema, optionsInput ?? {});
  const thresholds = options.thresholds ?? defaultWaitThresholds;
  return withReadSnapshot(async (db) => {
    const [rows, unlinked, sources] = await Promise.all([
      enrichedRequests(thresholds, undefined, db),
      unlinkedWork(db),
      sourceHealth(db),
    ]);
    const attentionCounts = {
      unansweredClarification: 0,
      reviewOverdue: 0,
      waitingOverdue: 0,
      blockedDelivery: 0,
      missingOwner: 0,
      stalePreparation: 0,
      cappedPreparation: 0,
    };
    for (const row of rows)
      for (const key of Object.keys(attentionCounts) as Array<
        keyof AttentionFlags
      >)
        if (row.attention[key]) attentionCounts[key] += 1;
    return {
      requests: rows,
      totals: {
        open: rows.filter((row) => row.phase !== "resolved").length,
        needAttention: rows.filter((row) => row.needsAttention).length,
        resolved: rows.filter((row) => row.phase === "resolved").length,
      },
      attentionCounts,
      inputRequestsNeedingAllocation: inputExceptions(rows, "allocation"),
      overdueInputRequests: inputExceptions(rows, "overdue"),
      unlinkedWork: unlinked,
      sources,
      thresholds,
    };
  });
}

function inputExceptions(
  rows: Awaited<ReturnType<typeof enrichedRequests>>,
  kind: "allocation" | "overdue",
) {
  return rows.flatMap((row) =>
    row.inputRequests
      .filter((input) =>
        kind === "allocation"
          ? input.audience === "internal" && input.assigneeActorId === null
          : input.overdue,
      )
      .map((input) => ({
        ...input,
        requestId: row.requestId,
        displayId: row.displayId,
        title: row.title,
        requestRowVersion: row.rowVersion,
        coordinatorActorId: row.coordinatorActorId,
        organizationName: row.organizationName,
      })),
  );
}

function inventoryHealth(source: {
  lastSuccessfulAt: string | null;
  lastFailedAt: string | null;
  expectedFreshnessHours: number;
  nowMs: number;
}): "current" | "stale" | "failed" {
  const { lastSuccessfulAt, lastFailedAt, expectedFreshnessHours, nowMs } =
    source;
  if (lastFailedAt && (!lastSuccessfulAt || lastFailedAt > lastSuccessfulAt))
    return "failed";
  if (
    !lastSuccessfulAt ||
    nowMs - Date.parse(lastSuccessfulAt) > expectedFreshnessHours * 3_600_000
  )
    return "stale";
  return "current";
}

async function sourceHealth(db: Db | Tx) {
  const nowMs = Date.now();
  const [systems, sources] = await Promise.all([
    db.select().from(workSystems).orderBy(asc(workSystems.system)),
    db
      .select()
      .from(inventorySources)
      .where(eq(inventorySources.lifecycle, "active"))
      .orderBy(asc(inventorySources.name)),
  ]);
  return {
    workSystems: systems.map((system) => ({
      system: system.system,
      name: system.name,
      syncHealth: system.syncHealth,
      lastSuccessfulAt: system.lastSuccessfulAt,
      expectedFreshnessHours: system.expectedFreshnessHours,
    })),
    inventorySources: sources.map((source) => ({
      sourceId: source.id,
      name: source.name,
      health: inventoryHealth({ ...source, nowMs }),
      lastSuccessfulAt: source.lastSuccessfulAt,
      lastFailedAt: source.lastFailedAt,
      expectedFreshnessHours: source.expectedFreshnessHours,
    })),
  };
}

async function unlinkedWork(db: Db | Tx) {
  return db
    .select({
      workItemId: externalWorkItems.id,
      system: externalWorkItems.system,
      externalId: externalWorkItems.externalId,
      title: externalWorkItems.title,
      sourceStatus: externalWorkItems.sourceStatus,
      syncHealth: externalWorkItems.syncHealth,
      closedAt: externalWorkItems.closedAt,
    })
    .from(externalWorkItems)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM request_work_item_links l WHERE l.work_item_id = ${externalWorkItems.id})`,
    )
    .orderBy(asc(externalWorkItems.system), asc(externalWorkItems.externalId));
}

const dashboardOptionsSchema = z.object({
  thresholds: thresholdsSchema.optional(),
});

export type DashboardView = Awaited<ReturnType<typeof dashboardView>>;
