import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";

import {
  catalogFieldDecisions,
  catalogItems,
  inventoryConflictMembers,
  inventoryConflicts,
  inventorySourceRecords,
  inventorySources,
  inventorySyncRuns,
  organizations,
} from "../db/schema.ts";
import {
  applyItemRevision,
  itemChangesSchema,
  itemProvenanceSchema,
} from "./catalog.ts";
import { WorkflowError } from "./errors.ts";
import {
  insertAudit,
  isUniqueViolation,
  newId,
  nowIso,
  parseInput,
  requireActor,
  requireVersion,
  uuidSchema,
  withDb,
  type ActorContext,
  type Tx,
} from "./shared.ts";

const line = (max: number) => z.string().trim().min(1).max(max);

async function lockSource(tx: Tx, sourceId: string) {
  const [source] = await tx
    .select()
    .from(inventorySources)
    .where(eq(inventorySources.id, sourceId))
    .limit(1)
    .for("update");
  if (!source) throw new WorkflowError("NOT_FOUND", "inventory source");
  return source;
}

const registerSchema = z.object({
  name: line(200),
  adapterKind: line(80),
  ownerOrganizationId: uuidSchema,
  expectedFreshnessHours: z
    .number()
    .int()
    .positive()
    .max(24 * 90),
});

/** Register a source definition for future imports. */
export async function registerSource(ctx: ActorContext, input: unknown) {
  const data = parseInput(registerSchema, input);
  return withDb(async (db) => {
    try {
      return await db.transaction(async (tx) => {
        await requireActor(tx, ctx.actorId);
        const [organization] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, data.ownerOrganizationId))
          .limit(1);
        if (!organization) throw new WorkflowError("NOT_FOUND", "organization");
        const sourceId = newId();
        await tx.insert(inventorySources).values({
          id: sourceId,
          name: data.name,
          adapterKind: data.adapterKind,
          ownerOrganizationId: data.ownerOrganizationId,
          expectedFreshnessHours: data.expectedFreshnessHours,
          lifecycle: "active",
        });
        await insertAudit(tx, {
          actorId: ctx.actorId,
          visitorId: ctx.visitorId ?? null,
          actingView: ctx.actingView,
          eventType: "inventory_source_registered",
          subjectType: "inventory_source",
          subjectId: sourceId,
          payload: { adapterKind: data.adapterKind },
        });
        return { sourceId, rowVersion: 1 };
      });
    } catch (error) {
      if (isUniqueViolation(error, "inventory_sources_name"))
        throw new WorkflowError("INVALID_STATE", "source name already exists");
      throw error;
    }
  });
}

const updateSchema = z.object({
  sourceId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
  name: line(200).optional(),
  adapterKind: line(80).optional(),
  ownerOrganizationId: uuidSchema.optional(),
  expectedFreshnessHours: z
    .number()
    .int()
    .positive()
    .max(24 * 90)
    .optional(),
});

/** Edit source metadata; import evidence and history stay untouched. */
export async function updateSource(ctx: ActorContext, input: unknown) {
  const data = parseInput(updateSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const source = await lockSource(tx, data.sourceId);
      requireVersion(data.expectedRowVersion, source.rowVersion);
      if (source.lifecycle === "retired")
        throw new WorkflowError("INVALID_STATE", "source is retired");
      await tx
        .update(inventorySources)
        .set({
          name: data.name ?? source.name,
          adapterKind: data.adapterKind ?? source.adapterKind,
          ownerOrganizationId:
            data.ownerOrganizationId ?? source.ownerOrganizationId,
          expectedFreshnessHours:
            data.expectedFreshnessHours ?? source.expectedFreshnessHours,
          rowVersion: source.rowVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(inventorySources.id, source.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "inventory_source_updated",
        subjectType: "inventory_source",
        subjectId: source.id,
        payload: {},
      });
      return { sourceId: source.id, rowVersion: source.rowVersion + 1 };
    }),
  );
}

const sourceActionSchema = z.object({
  sourceId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
});

/** Retire a source definition; its records and runs remain evidence. */
export async function retireSource(ctx: ActorContext, input: unknown) {
  const data = parseInput(sourceActionSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const source = await lockSource(tx, data.sourceId);
      requireVersion(data.expectedRowVersion, source.rowVersion);
      if (source.lifecycle === "retired")
        throw new WorkflowError("INVALID_STATE", "already retired");
      await tx
        .update(inventorySources)
        .set({
          lifecycle: "retired",
          rowVersion: source.rowVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(inventorySources.id, source.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "inventory_source_retired",
        subjectType: "inventory_source",
        subjectId: source.id,
        payload: {},
      });
      return {
        sourceId: source.id,
        lifecycle: "retired" as const,
        rowVersion: source.rowVersion + 1,
      };
    }),
  );
}

/** Internal read: a source with its import history, newest run first. */
export async function getSourceHistory(sourceIdInput: unknown) {
  const sourceId = parseInput(uuidSchema, sourceIdInput);
  return withDb(async (db) => {
    const [source] = await db
      .select()
      .from(inventorySources)
      .where(eq(inventorySources.id, sourceId))
      .limit(1);
    if (!source) throw new WorkflowError("NOT_FOUND", "inventory source");
    const runs = await db
      .select({
        runId: inventorySyncRuns.id,
        sourceVersion: inventorySyncRuns.sourceVersion,
        status: inventorySyncRuns.status,
        recordCount: inventorySyncRuns.recordCount,
        sanitizedError: inventorySyncRuns.sanitizedError,
        startedAt: inventorySyncRuns.startedAt,
        completedAt: inventorySyncRuns.completedAt,
      })
      .from(inventorySyncRuns)
      .where(eq(inventorySyncRuns.sourceId, sourceId))
      .orderBy(desc(inventorySyncRuns.startedAt), desc(inventorySyncRuns.id));
    return { source, runs };
  });
}

/**
 * Internal read: one conflict with its current-evidence candidate records
 * side by side, each with its source and freshness, plus the canonical
 * item's current values and latest per-field provenance.
 */
export async function getConflictComparison(conflictIdInput: unknown) {
  const conflictId = parseInput(uuidSchema, conflictIdInput);
  return withDb(async (db) => {
    const [conflict] = await db
      .select()
      .from(inventoryConflicts)
      .where(eq(inventoryConflicts.id, conflictId))
      .limit(1);
    if (!conflict) throw new WorkflowError("NOT_FOUND", "conflict");
    const members = await db
      .select({
        memberId: inventoryConflictMembers.id,
        groupingReason: inventoryConflictMembers.groupingReason,
        sourceRecordId: inventorySourceRecords.id,
        sourceRecordKey: inventorySourceRecords.sourceRecordKey,
        normalizedFields: inventorySourceRecords.normalizedFields,
        observedAt: inventorySourceRecords.observedAt,
        recordState: inventorySourceRecords.state,
        sourceId: inventorySources.id,
        sourceName: inventorySources.name,
        sourceLifecycle: inventorySources.lifecycle,
        sourceLastSuccessfulAt: inventorySources.lastSuccessfulAt,
        expectedFreshnessHours: inventorySources.expectedFreshnessHours,
      })
      .from(inventoryConflictMembers)
      .innerJoin(
        inventorySourceRecords,
        eq(inventorySourceRecords.id, inventoryConflictMembers.sourceRecordId),
      )
      .innerJoin(
        inventorySources,
        eq(inventorySources.id, inventorySourceRecords.sourceId),
      )
      .where(
        and(
          eq(inventoryConflictMembers.conflictId, conflictId),
          eq(
            inventoryConflictMembers.evidenceVersion,
            conflict.currentEvidenceVersion,
          ),
        ),
      );
    let item = null;
    let latestDecisions: Array<typeof catalogFieldDecisions.$inferSelect> = [];
    if (conflict.catalogItemId) {
      const [row] = await db
        .select()
        .from(catalogItems)
        .where(eq(catalogItems.id, conflict.catalogItemId))
        .limit(1);
      item = row ?? null;
      // Active lineage only: decisions above the current version belong to a
      // generation a reset abandoned.
      const all = await db
        .select()
        .from(catalogFieldDecisions)
        .where(
          and(
            eq(catalogFieldDecisions.catalogItemId, conflict.catalogItemId),
            lte(
              catalogFieldDecisions.canonicalVersion,
              row?.currentVersion ?? 0,
            ),
          ),
        )
        .orderBy(desc(catalogFieldDecisions.canonicalVersion));
      const seen = new Set<string>();
      latestDecisions = all.filter((decision) => {
        if (seen.has(decision.fieldName)) return false;
        seen.add(decision.fieldName);
        return true;
      });
    }
    return { conflict, members, item, latestDecisions };
  });
}

const resolveConflictSchema = z.object({
  conflictId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
  itemExpectedRowVersion: z.number().int().positive().optional(),
  changes: itemChangesSchema,
  provenance: z.array(itemProvenanceSchema).min(1).max(20),
});

/**
 * Resolve a conflict by applying the steward's decided canonical fields as a
 * new item version. The imported observations stay untouched; a later source
 * change reopens the conflict without erasing the published decision.
 */
export async function resolveConflict(ctx: ActorContext, input: unknown) {
  const data = parseInput(resolveConflictSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const [conflict] = await tx
        .select()
        .from(inventoryConflicts)
        .where(eq(inventoryConflicts.id, data.conflictId))
        .limit(1)
        .for("update");
      if (!conflict) throw new WorkflowError("NOT_FOUND", "conflict");
      requireVersion(data.expectedRowVersion, conflict.rowVersion);
      if (conflict.state === "resolved")
        throw new WorkflowError("INVALID_STATE", "conflict already resolved");
      if (!conflict.catalogItemId)
        throw new WorkflowError("INVALID_STATE", "conflict has no item");

      const [item] = await tx
        .select()
        .from(catalogItems)
        .where(eq(catalogItems.id, conflict.catalogItemId))
        .limit(1)
        .for("update");
      if (!item) throw new WorkflowError("NOT_FOUND", "catalog item");
      requireVersion(data.itemExpectedRowVersion, item.rowVersion);
      const newVersion = await applyItemRevision(tx, ctx, {
        item,
        changes: data.changes,
        provenance: data.provenance,
      });
      await tx
        .update(inventoryConflicts)
        .set({
          state: "resolved",
          currentResolutionVersion: newVersion,
          rowVersion: conflict.rowVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(inventoryConflicts.id, conflict.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "inventory_conflict_resolved",
        subjectType: "inventory_conflict",
        subjectId: conflict.id,
        payload: {
          catalogItemId: conflict.catalogItemId,
          resolutionVersion: newVersion,
        },
      });
      return {
        conflictId: conflict.id,
        state: "resolved" as const,
        catalogItemId: conflict.catalogItemId,
        resolutionVersion: newVersion,
        rowVersion: conflict.rowVersion + 1,
      };
    }),
  );
}
