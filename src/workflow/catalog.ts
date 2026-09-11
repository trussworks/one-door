import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";

import {
  catalogFieldDecisions,
  catalogItems,
  catalogItemSources,
  inventoryConflicts,
  inventorySourceRecords,
  inventorySources,
  organizations,
} from "../db/schema.ts";
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
const lines = z.array(line(200)).max(30);
const dateText = z.iso
  .date()
  .refine(
    (value) =>
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value,
    { message: "not a real calendar date" },
  );

/** Publication requires current provenance for these stored values. */
const materialFields = [
  "name",
  "description",
  "itemType",
  "approvalStatus",
  "ownerOrganizationId",
  "capabilities",
  "dataClassifications",
] as const;

/** Material fields a steward authors at creation; approval evidence arrives
 * with the approving revision. */
const authoredMaterialFields = [
  "name",
  "description",
  "itemType",
  "ownerOrganizationId",
  "capabilities",
  "dataClassifications",
] as const;

/** Every canonical field a steward may author, with its validated shape. */
const itemFieldSchemas = {
  name: line(200),
  vendor: line(200).nullable(),
  description: line(5000),
  itemType: z.enum(["software", "infrastructure", "platform"]),
  capabilities: lines,
  dataClassifications: lines,
  integrations: lines,
  licenseModel: line(200).nullable(),
  reviewDate: dateText,
  renewalDate: dateText.nullable(),
  approvalStatus: z.enum(["approved", "conditional", "review_required"]),
  ownerOrganizationId: uuidSchema,
} as const;
type ItemFieldName = keyof typeof itemFieldSchemas;
const itemFieldNames = Object.keys(itemFieldSchemas) as [
  ItemFieldName,
  ...ItemFieldName[],
];

export const itemChangesSchema = z
  .object(itemFieldSchemas)
  .partial()
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    {
      message: "at least one field change is required",
    },
  );

/** Caller-provided provenance: a source record, human rationale, or both. */
export const itemProvenanceSchema = z
  .object({
    fieldName: z.enum(itemFieldNames),
    sourceRecordId: uuidSchema.optional(),
    rationale: line(2000).optional(),
  })
  .refine((entry) => entry.sourceRecordId || entry.rationale, {
    message: "provenance needs a source record or a rationale",
  });
type ProvenanceEntry = z.infer<typeof itemProvenanceSchema>;

async function requireOrganization(tx: Tx, id: string): Promise<void> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  if (!row) throw new WorkflowError("NOT_FOUND", "organization");
}

async function loadSourceRecords(
  tx: Tx,
  entries: ProvenanceEntry[],
): Promise<Map<string, Record<string, unknown>>> {
  const records = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (!entry.sourceRecordId || records.has(entry.sourceRecordId)) continue;
    const [record] = await tx
      .select({
        id: inventorySourceRecords.id,
        normalizedFields: inventorySourceRecords.normalizedFields,
      })
      .from(inventorySourceRecords)
      .where(eq(inventorySourceRecords.id, entry.sourceRecordId))
      .limit(1);
    if (!record) throw new WorkflowError("NOT_FOUND", "source record");
    records.set(record.id, record.normalizedFields);
  }
  return records;
}

/**
 * A cited source record must actually show the value being stored; a human
 * rationale is the only way to record a value the source does not support.
 */
function verifySourceEvidence(
  entries: ProvenanceEntry[],
  values: Record<string, unknown>,
  records: Map<string, Record<string, unknown>>,
): void {
  for (const entry of entries) {
    if (!entry.sourceRecordId || entry.rationale) continue;
    const observed = records.get(entry.sourceRecordId)?.[entry.fieldName];
    if (JSON.stringify(observed) !== JSON.stringify(values[entry.fieldName]))
      throw new WorkflowError(
        "VALIDATION_FAILED",
        "source record does not show the stored " +
          entry.fieldName +
          " value; add a rationale",
      );
  }
}

async function lockItem(tx: Tx, catalogItemId: string) {
  const [item] = await tx
    .select()
    .from(catalogItems)
    .where(eq(catalogItems.id, catalogItemId))
    .limit(1)
    .for("update");
  if (!item) throw new WorkflowError("NOT_FOUND", "catalog item");
  return item;
}

function provenanceByField(
  changes: Record<string, unknown>,
  entries: ProvenanceEntry[],
): Map<string, ProvenanceEntry> {
  const byField = new Map<string, ProvenanceEntry>(
    entries.map((entry) => [entry.fieldName, entry]),
  );
  for (const field of Object.keys(changes)) {
    if (changes[field as ItemFieldName] === undefined) continue;
    if (!byField.has(field))
      throw new WorkflowError(
        "VALIDATION_FAILED",
        `changed field "${field}" has no provenance`,
      );
  }
  return byField;
}

/**
 * The decision governing the current stored value: the newest one at or
 * below the item's current version. Decisions above it belong to a version
 * a reset abandoned; they are evidence, not active lineage.
 */
async function latestDecisionId(
  tx: Tx,
  catalogItemId: string,
  fieldName: string,
  maxVersion: number,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: catalogFieldDecisions.id })
    .from(catalogFieldDecisions)
    .where(
      and(
        eq(catalogFieldDecisions.catalogItemId, catalogItemId),
        eq(catalogFieldDecisions.fieldName, fieldName),
        lte(catalogFieldDecisions.canonicalVersion, maxVersion),
      ),
    )
    .orderBy(desc(catalogFieldDecisions.canonicalVersion))
    .limit(1);
  return row?.id ?? null;
}

/** The newest decision per field at or below a version: the active set. */
async function activeDecisionsAt(
  tx: Tx,
  catalogItemId: string,
  version: number,
): Promise<Array<typeof catalogFieldDecisions.$inferSelect>> {
  const rows = await tx
    .select()
    .from(catalogFieldDecisions)
    .where(
      and(
        eq(catalogFieldDecisions.catalogItemId, catalogItemId),
        lte(catalogFieldDecisions.canonicalVersion, version),
      ),
    )
    .orderBy(desc(catalogFieldDecisions.canonicalVersion));
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.fieldName)) return false;
    seen.add(row.fieldName);
    return true;
  });
}

async function maxDecisionVersion(
  tx: Tx,
  catalogItemId: string,
): Promise<number> {
  const [row] = await tx
    .select({ canonicalVersion: catalogFieldDecisions.canonicalVersion })
    .from(catalogFieldDecisions)
    .where(eq(catalogFieldDecisions.catalogItemId, catalogItemId))
    .orderBy(desc(catalogFieldDecisions.canonicalVersion))
    .limit(1);
  return row?.canonicalVersion ?? 0;
}

async function writeFieldDecisions(
  tx: Tx,
  args: {
    ctx: ActorContext;
    catalogItemId: string;
    canonicalVersion: number;
    supersedeBelow: number;
    changes: Record<string, unknown>;
    provenance: Map<string, ProvenanceEntry>;
  },
): Promise<void> {
  for (const [field, value] of Object.entries(args.changes)) {
    if (value === undefined) continue;
    const entry = args.provenance.get(field);
    await tx.insert(catalogFieldDecisions).values({
      id: newId(),
      catalogItemId: args.catalogItemId,
      canonicalVersion: args.canonicalVersion,
      fieldName: field,
      value: value as unknown,
      sourceRecordId: entry?.sourceRecordId ?? null,
      decidedByActorId: args.ctx.actorId,
      rationale: entry?.rationale ?? null,
      supersedesId: await latestDecisionId(
        tx,
        args.catalogItemId,
        field,
        args.supersedeBelow,
      ),
    });
  }
}

/**
 * Apply steward-decided field values as the next canonical version. Earlier
 * versions and their field decisions remain; each decision records the
 * source record or human rationale behind the value.
 */
export interface ItemRevisionArgs {
  item: typeof catalogItems.$inferSelect;
  changes: z.infer<typeof itemChangesSchema>;
  provenance: ProvenanceEntry[];
}

export async function applyItemRevision(
  tx: Tx,
  ctx: ActorContext,
  { item, changes, provenance }: ItemRevisionArgs,
): Promise<number> {
  const byField = provenanceByField(changes, provenance);
  const records = await loadSourceRecords(tx, provenance);
  verifySourceEvidence(provenance, changes, records);
  if (changes.ownerOrganizationId)
    await requireOrganization(tx, changes.ownerOrganizationId);
  // A reset can restore current_version below preserved immutable decisions;
  // the next version always continues past every recorded decision.
  const newVersion =
    Math.max(await maxDecisionVersion(tx, item.id), item.currentVersion) + 1;
  await writeFieldDecisions(tx, {
    ctx,
    catalogItemId: item.id,
    canonicalVersion: newVersion,
    supersedeBelow: item.currentVersion,
    changes,
    provenance: byField,
  });
  // Carry the parent version's unchanged evidence into the new version, with
  // its original author and time. Every version is then a complete snapshot,
  // so the newest-per-field rule stays correct even when a reset abandoned
  // intermediate versions.
  const changedKeys = new Set(
    Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .flatMap(([key]) => [key, snakeCase(key)]),
  );
  for (const parent of await activeDecisionsAt(
    tx,
    item.id,
    item.currentVersion,
  )) {
    if (changedKeys.has(parent.fieldName)) continue;
    await tx.insert(catalogFieldDecisions).values({
      id: newId(),
      catalogItemId: item.id,
      canonicalVersion: newVersion,
      fieldName: parent.fieldName,
      value: parent.value,
      sourceRecordId: parent.sourceRecordId,
      decidedByActorId: parent.decidedByActorId,
      rationale: parent.rationale,
      supersedesId: parent.id,
      createdAt: parent.createdAt,
    });
  }
  const applied = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  );
  await tx
    .update(catalogItems)
    .set({
      ...applied,
      publicationState: "draft",
      currentVersion: newVersion,
      rowVersion: item.rowVersion + 1,
      updatedAt: nowIso(),
    })
    .where(eq(catalogItems.id, item.id));
  return newVersion;
}

const addSchema = z.object({
  itemKey: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: line(200),
  description: line(5000),
  itemType: z.enum(["software", "infrastructure", "platform"]),
  ownerOrganizationId: uuidSchema,
  vendor: line(200).optional(),
  licenseModel: line(200).optional(),
  capabilities: lines.default([]),
  dataClassifications: lines.default([]),
  integrations: lines.default([]),
  reviewDate: dateText,
  renewalDate: dateText.optional(),
  provenance: z.array(itemProvenanceSchema).min(1).max(20),
});

type AddInput = z.infer<typeof addSchema>;

/** The values the insert will store, defaults applied. The table's own
 * field types keep the evidence rows and the insert describing one object. */
function storedItemValues(
  data: AddInput,
): Pick<typeof catalogItems.$inferSelect, ItemFieldName> {
  return {
    name: data.name,
    vendor: data.vendor ?? null,
    description: data.description,
    itemType: data.itemType,
    capabilities: data.capabilities,
    dataClassifications: data.dataClassifications,
    integrations: data.integrations,
    licenseModel: data.licenseModel ?? null,
    reviewDate: data.reviewDate,
    renewalDate: data.renewalDate ?? null,
    approvalStatus: "review_required",
    ownerOrganizationId: data.ownerOrganizationId,
  };
}

/** Authored material fields need provenance; entries need a stored value. */
function requireAddProvenance(
  provenance: ProvenanceEntry[],
  stored: Record<string, unknown>,
): void {
  const covered = new Set(provenance.map((entry) => entry.fieldName));
  for (const field of authoredMaterialFields) {
    if (!covered.has(field))
      throw new WorkflowError(
        "VALIDATION_FAILED",
        'material field "' + field + '" needs provenance',
      );
  }
  for (const entry of provenance) {
    if (stored[entry.fieldName] === null)
      throw new WorkflowError(
        "VALIDATION_FAILED",
        'field "' + entry.fieldName + '" has no stored value to evidence',
      );
  }
}

/**
 * Add a canonical item as an unpublished draft needing approval. Provenance
 * must cover the authored material fields, entries may only cite fields with
 * a stored value, and every decision records the value actually stored.
 */
export async function addCatalogItem(ctx: ActorContext, input: unknown) {
  const data = parseInput(addSchema, input);
  const stored = storedItemValues(data);
  requireAddProvenance(data.provenance, stored);
  return withDb(async (db) => {
    try {
      return await db.transaction(async (tx) => {
        await requireActor(tx, ctx.actorId);
        await requireOrganization(tx, data.ownerOrganizationId);
        const records = await loadSourceRecords(tx, data.provenance);
        verifySourceEvidence(data.provenance, stored, records);
        const itemId = newId();
        await tx.insert(catalogItems).values({
          id: itemId,
          itemKey: data.itemKey,
          publicationState: "draft",
          currentVersion: 1,
          ...stored,
        });
        await writeFieldDecisions(tx, {
          ctx,
          catalogItemId: itemId,
          canonicalVersion: 1,
          supersedeBelow: 0,
          changes: Object.fromEntries(
            data.provenance.map((entry) => [
              entry.fieldName,
              stored[entry.fieldName],
            ]),
          ),
          provenance: new Map(
            data.provenance.map((entry) => [entry.fieldName, entry]),
          ),
        });
        await insertAudit(tx, {
          actorId: ctx.actorId,
          visitorId: ctx.visitorId ?? null,
          actingView: ctx.actingView,
          eventType: "catalog_item_added",
          subjectType: "catalog_item",
          subjectId: itemId,
          payload: { itemKey: data.itemKey },
        });
        return { catalogItemId: itemId, currentVersion: 1, rowVersion: 1 };
      });
    } catch (error) {
      if (isUniqueViolation(error, "item_key"))
        throw new WorkflowError("INVALID_STATE", "item key already exists");
      throw error;
    }
  });
}

const reviseSchema = z.object({
  catalogItemId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
  changes: itemChangesSchema,
  provenance: z.array(itemProvenanceSchema).min(1).max(20),
});

/** Revise a canonical item into a new version with per-field provenance. */
export async function reviseCatalogItem(ctx: ActorContext, input: unknown) {
  const data = parseInput(reviseSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const item = await lockItem(tx, data.catalogItemId);
      requireVersion(data.expectedRowVersion, item.rowVersion);
      const newVersion = await applyItemRevision(tx, ctx, {
        item,
        changes: data.changes,
        provenance: data.provenance,
      });
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "catalog_item_revised",
        subjectType: "catalog_item",
        subjectId: item.id,
        payload: {
          currentVersion: newVersion,
          changedFields: Object.keys(data.changes),
        },
      });
      return {
        catalogItemId: item.id,
        currentVersion: newVersion,
        rowVersion: item.rowVersion + 1,
      };
    }),
  );
}

const itemActionSchema = z.object({
  catalogItemId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
});

function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
}

/**
 * Publication requires current-lineage provenance whose recorded values are
 * the values actually stored. Seed decisions may use snake_case field names.
 */
async function requireMaterialProvenance(
  tx: Tx,
  item: typeof catalogItems.$inferSelect,
): Promise<void> {
  const decisions = await tx
    .select()
    .from(catalogFieldDecisions)
    .where(
      and(
        eq(catalogFieldDecisions.catalogItemId, item.id),
        lte(catalogFieldDecisions.canonicalVersion, item.currentVersion),
      ),
    )
    .orderBy(desc(catalogFieldDecisions.canonicalVersion));
  for (const field of materialFields) {
    const decision = decisions.find(
      (row) => row.fieldName === field || row.fieldName === snakeCase(field),
    );
    const storedValue = (item as unknown as Record<string, unknown>)[field];
    if (
      !decision ||
      JSON.stringify(decision.value) !== JSON.stringify(storedValue)
    )
      throw new WorkflowError(
        "INVALID_STATE",
        "provenance_missing_or_stale:" + field,
      );
  }
}

/** Publish requires explicit approval and provenance for material fields. */
export async function publishCatalogItem(ctx: ActorContext, input: unknown) {
  const data = parseInput(itemActionSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const item = await lockItem(tx, data.catalogItemId);
      requireVersion(data.expectedRowVersion, item.rowVersion);
      if (item.approvalStatus !== "approved")
        throw new WorkflowError("INVALID_STATE", "approval_required");
      await requireMaterialProvenance(tx, item);
      await tx
        .update(catalogItems)
        .set({
          publicationState: "published",
          rowVersion: item.rowVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(catalogItems.id, item.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "catalog_item_published",
        subjectType: "catalog_item",
        subjectId: item.id,
        payload: { currentVersion: item.currentVersion },
      });
      return {
        catalogItemId: item.id,
        publicationState: "published" as const,
        rowVersion: item.rowVersion + 1,
      };
    }),
  );
}

/** Retirement removes the item from future recommendations immediately. */
export async function retireCatalogItem(ctx: ActorContext, input: unknown) {
  const data = parseInput(itemActionSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const item = await lockItem(tx, data.catalogItemId);
      requireVersion(data.expectedRowVersion, item.rowVersion);
      if (item.publicationState === "retired")
        throw new WorkflowError("INVALID_STATE", "already retired");
      await tx
        .update(catalogItems)
        .set({
          publicationState: "retired",
          rowVersion: item.rowVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(catalogItems.id, item.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "catalog_item_retired",
        subjectType: "catalog_item",
        subjectId: item.id,
        payload: {},
      });
      return {
        catalogItemId: item.id,
        publicationState: "retired" as const,
        rowVersion: item.rowVersion + 1,
      };
    }),
  );
}

const confirmSchema = z.object({
  catalogItemId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
  reviewDate: dateText,
});

/** Record that a steward confirmed the item is still accurate. */
export async function confirmCatalogItemAccurate(
  ctx: ActorContext,
  input: unknown,
) {
  const data = parseInput(confirmSchema, input);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireActor(tx, ctx.actorId);
      const item = await lockItem(tx, data.catalogItemId);
      requireVersion(data.expectedRowVersion, item.rowVersion);
      await tx
        .update(catalogItems)
        .set({
          reviewDate: data.reviewDate,
          rowVersion: item.rowVersion + 1,
          updatedAt: nowIso(),
        })
        .where(eq(catalogItems.id, item.id));
      await insertAudit(tx, {
        actorId: ctx.actorId,
        visitorId: ctx.visitorId ?? null,
        actingView: ctx.actingView,
        eventType: "catalog_item_confirmed_accurate",
        subjectType: "catalog_item",
        subjectId: item.id,
        payload: { reviewDate: data.reviewDate },
      });
      return {
        catalogItemId: item.id,
        reviewDate: data.reviewDate,
        rowVersion: item.rowVersion + 1,
      };
    }),
  );
}

/** Internal read: the item, its field-decision history, and source links. */
export async function getCatalogItemRecord(catalogItemIdInput: unknown) {
  const catalogItemId = parseInput(uuidSchema, catalogItemIdInput);
  return withDb(async (db) => {
    const [item] = await db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, catalogItemId))
      .limit(1);
    if (!item) throw new WorkflowError("NOT_FOUND", "catalog item");
    const decisions = await db
      .select()
      .from(catalogFieldDecisions)
      .where(eq(catalogFieldDecisions.catalogItemId, catalogItemId))
      .orderBy(
        desc(catalogFieldDecisions.canonicalVersion),
        catalogFieldDecisions.fieldName,
      );
    // Active lineage: the newest decision per field at or below the current
    // version; later versions a reset abandoned are history only.
    const seenFields = new Set<string>();
    const currentDecisions = decisions.filter((decision) => {
      if (decision.canonicalVersion > item.currentVersion) return false;
      if (seenFields.has(decision.fieldName)) return false;
      seenFields.add(decision.fieldName);
      return true;
    });
    const sources = await db
      .select({
        sourceRecordId: catalogItemSources.sourceRecordId,
        sourceId: inventorySourceRecords.sourceId,
        sourceRecordKey: inventorySourceRecords.sourceRecordKey,
        observedAt: inventorySourceRecords.observedAt,
        normalizedFields: inventorySourceRecords.normalizedFields,
        sourceName: inventorySources.name,
      })
      .from(catalogItemSources)
      .innerJoin(
        inventorySourceRecords,
        eq(inventorySourceRecords.id, catalogItemSources.sourceRecordId),
      )
      .innerJoin(
        inventorySources,
        eq(inventorySources.id, inventorySourceRecords.sourceId),
      )
      .where(eq(catalogItemSources.catalogItemId, catalogItemId));
    const conflicts = await db
      .select({
        conflictId: inventoryConflicts.id,
        state: inventoryConflicts.state,
        currentEvidenceVersion: inventoryConflicts.currentEvidenceVersion,
        currentResolutionVersion: inventoryConflicts.currentResolutionVersion,
      })
      .from(inventoryConflicts)
      .where(eq(inventoryConflicts.catalogItemId, catalogItemId));
    return { item, decisions, currentDecisions, sources, conflicts };
  });
}
