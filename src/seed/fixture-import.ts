import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { createDatabase } from "../db/client.ts";
import {
  actors,
  auditEvents,
  catalogItems,
  inventoryConflictMembers,
  inventoryConflicts,
  inventorySourceRecords,
  inventorySources,
  inventorySyncRuns,
} from "../db/schema.ts";
import { contentHash, stableUuid } from "./stable.ts";

const sourceVersion = "2026-09-10";
const runKey = "architecture-20260910";
const runId = stableUuid("inventory-sync-run", runKey);
const observedAt = "2026-09-10T12:00:00.000Z";
const changedItems = [
  {
    itemKey: "colorado-azure-landing-zone",
    recordKey: "AR-0051",
    name: "Azure Application Landing Zone",
    owner: "Platform Enablement and Cloud Platform",
  },
  {
    itemKey: "notify-stream",
    recordKey: "AR-0050",
    name: "Notify Stream",
    owner: "Shared Services",
  },
] as const;
const runHash = contentHash(changedItems);
type Db = ReturnType<typeof createDatabase>["db"];
type ImportTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SourceRow = typeof inventorySources.$inferSelect;

/**
 * Apply the 2026-09-10 architecture fixture import in one transaction.
 * Returns true when rows changed, false when the import already matches.
 */
export async function importArchitectureFixture(db: Db): Promise<boolean> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql.raw("SELECT pg_advisory_xact_lock(9248664)"));
    const source = await requireSource(transaction);
    if (await matchingRunExists(transaction, source.id)) return false;
    await insertRun(transaction, source.id);
    for (const item of changedItems) {
      await importChangedItem(transaction, source, item);
    }
    await transaction
      .update(inventorySources)
      .set({
        currentSyncRunId: runId,
        lastSuccessfulAt: observedAt,
        rowVersion: sql.raw("row_version + 1"),
        updatedAt: observedAt,
      })
      .where(eq(inventorySources.id, source.id));
    await recordImport(transaction, source.id);
    return true;
  });
}

async function requireSource(
  transaction: ImportTransaction,
): Promise<SourceRow> {
  const [source] = await transaction
    .select()
    .from(inventorySources)
    .where(
      eq(inventorySources.fixtureKey, "inventory-source:architecture-registry"),
    )
    .limit(1);
  if (!source) throw new Error("Architecture fixture source is missing");
  return source;
}

async function matchingRunExists(
  transaction: ImportTransaction,
  sourceId: string,
): Promise<boolean> {
  const [existing] = await transaction
    .select()
    .from(inventorySyncRuns)
    .where(
      and(
        eq(inventorySyncRuns.sourceId, sourceId),
        eq(inventorySyncRuns.sourceVersion, sourceVersion),
      ),
    )
    .limit(1);
  if (!existing) return false;
  if (existing.contentHash !== runHash) {
    throw new Error(
      "The installed import version has different content from this fixture.",
    );
  }
  return true;
}

async function insertRun(
  transaction: ImportTransaction,
  sourceId: string,
): Promise<void> {
  await transaction.insert(inventorySyncRuns).values({
    id: runId,
    fixtureKey: "inventory-sync-run:" + runKey,
    sourceId,
    sourceVersion,
    status: "succeeded",
    recordCount: changedItems.length,
    contentHash: runHash,
    sanitizedError: null,
    startedAt: "2026-09-10T11:55:00.000Z",
    completedAt: observedAt,
  });
}

async function importChangedItem(
  transaction: ImportTransaction,
  source: SourceRow,
  item: (typeof changedItems)[number],
): Promise<void> {
  const [catalog] = await transaction
    .select()
    .from(catalogItems)
    .where(eq(catalogItems.itemKey, item.itemKey))
    .limit(1);
  if (!catalog) throw new Error("Catalog item is missing: " + item.itemKey);
  const recordId = stableUuid("inventory-record", runKey + ":" + item.itemKey);
  const normalizedFields = changedSourceFields(catalog, item);
  await transaction.insert(inventorySourceRecords).values({
    id: recordId,
    fixtureKey: "inventory-record:" + runKey + ":" + item.itemKey,
    runId,
    sourceId: source.id,
    sourceRecordKey: item.recordKey,
    state: "present",
    rawPayload: {
      recordKey: item.recordKey,
      productName: item.name,
      owner: item.owner,
      approval: catalog.approvalStatus,
      license: catalog.licenseModel,
    },
    normalizedFields,
    contentHash: contentHash(normalizedFields),
    priorRecordId: stableUuid(
      "inventory-record",
      "architecture-20260903:" + item.itemKey,
    ),
    observedAt,
  });
  await reopenConflict(transaction, item.itemKey, recordId);
}

function changedSourceFields(
  catalog: typeof catalogItems.$inferSelect,
  item: (typeof changedItems)[number],
): Record<string, unknown> {
  return {
    itemKey: catalog.itemKey,
    name: item.name,
    vendor: catalog.vendor,
    owner: item.owner,
    approvalStatus: catalog.approvalStatus,
    publicationState: catalog.publicationState,
    itemType: catalog.itemType,
    licenseModel: catalog.licenseModel,
    reviewDate: catalog.reviewDate,
    renewalDate: catalog.renewalDate,
  };
}

async function reopenConflict(
  transaction: ImportTransaction,
  itemKey: string,
  newRecordId: string,
): Promise<void> {
  const conflictId = stableUuid("inventory-conflict", itemKey);
  const [conflict] = await transaction
    .select()
    .from(inventoryConflicts)
    .where(eq(inventoryConflicts.id, conflictId))
    .limit(1);
  if (!conflict) throw new Error("Conflict is missing: " + itemKey);
  const evidenceVersion = conflict.currentEvidenceVersion + 1;
  const records = [
    stableUuid("inventory-record", "servicenow-20260903:" + itemKey),
    newRecordId,
  ];
  for (const [index, sourceRecordId] of records.entries()) {
    await transaction.insert(inventoryConflictMembers).values({
      id: stableUuid(
        "inventory-conflict-member",
        itemKey + ":" + evidenceVersion + ":" + sourceRecordId,
      ),
      fixtureKey:
        "inventory-conflict-member:" +
        itemKey +
        ":" +
        evidenceVersion +
        ":" +
        index,
      conflictId,
      evidenceVersion,
      sourceRecordId,
      groupingReason:
        index === 0
          ? "Existing canonical source record"
          : "Later architecture record changed a material field",
    });
  }
  await transaction
    .update(inventoryConflicts)
    .set({
      state: "reopened",
      reopenedByRunId: runId,
      currentEvidenceVersion: evidenceVersion,
      rowVersion: sql.raw("row_version + 1"),
      updatedAt: observedAt,
    })
    .where(eq(inventoryConflicts.id, conflictId));
}

async function recordImport(
  transaction: ImportTransaction,
  sourceId: string,
): Promise<void> {
  const [systemActor] = await transaction
    .select({ id: actors.id })
    .from(actors)
    .where(eq(actors.fixtureKey, "actor:one-door-system"))
    .limit(1);
  if (!systemActor) throw new Error("One Door system actor is missing");
  await transaction.insert(auditEvents).values({
    id: randomUUID(),
    actorId: systemActor.id,
    visitorId: null,
    actingView: "administrator",
    eventType: "inventory_fixture_imported",
    subjectType: "inventory_source",
    subjectId: sourceId,
    payload: {
      sourceVersion,
      changedItemKeys: changedItems.map((item) => item.itemKey),
    },
    origin: "system",
    createdAt: observedAt,
  });
}
