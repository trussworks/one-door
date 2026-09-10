import { seedOrganizations } from "./organizations.ts";
import { contentHash, daysBefore, stableUuid } from "./stable.ts";
import type { SeedData } from "./types.ts";

type CatalogRow = SeedData["catalogItems"][number];
type SourceRow = SeedData["inventorySources"][number];
type RunRow = SeedData["inventorySyncRuns"][number];
type RecordRow = SeedData["inventorySourceRecords"][number];
type ConflictRow = SeedData["inventoryConflicts"][number];
interface RecordContext {
  item: CatalogRow;
  index: number;
  fields: Record<string, unknown>;
  sourceIds: Map<string, string>;
  referenceTime: string;
}

export type InventoryData = Pick<
  SeedData,
  | "inventorySources"
  | "inventorySyncRuns"
  | "inventorySourceRecords"
  | "inventoryAliases"
  | "inventoryConflicts"
  | "inventoryConflictMembers"
  | "catalogFieldDecisions"
  | "catalogItemSources"
>;

export function buildInventory(
  catalogItems: CatalogRow[],
  organizationIds: Map<string, string>,
  actorIds: Map<string, string>,
  referenceTime: string,
): InventoryData {
  const inventorySources = buildSources(organizationIds, referenceTime);
  const sourceIds = fixtureKeyMap(inventorySources);
  const inventorySyncRuns = buildRuns(
    sourceIds,
    catalogItems.length,
    referenceTime,
  );
  const inventorySourceRecords = buildRecords(
    catalogItems,
    sourceIds,
    organizationIds,
    referenceTime,
  );
  const latestRecords = latestRecordsByItem(inventorySourceRecords);
  const conflictItems = selectConflictItems(catalogItems, latestRecords);
  const inventoryConflicts = buildConflicts(
    conflictItems,
    inventorySyncRuns,
    referenceTime,
  );

  return {
    inventorySources,
    inventorySyncRuns,
    inventorySourceRecords,
    inventoryAliases: buildAliases(
      catalogItems,
      sourceIds,
      actorIds,
      referenceTime,
    ),
    inventoryConflicts,
    inventoryConflictMembers: buildConflictMembers(
      inventoryConflicts,
      catalogItems,
      latestRecords,
    ),
    catalogFieldDecisions: buildFieldDecisions({
      catalogItems,
      latestRecords,
      records: inventorySourceRecords,
      organizationIds,
      actorIds,
      referenceTime,
    }),
    catalogItemSources: buildCatalogSources(catalogItems, latestRecords),
  };
}

function buildSources(
  organizationIds: Map<string, string>,
  referenceTime: string,
): SourceRow[] {
  const definitions = [
    [
      "servicenow-cmdb",
      "ServiceNow CMDB",
      "servicenow_fixture",
      "configuration-management",
      24,
      0,
      null,
      "servicenow-20260903",
    ],
    [
      "architecture-registry",
      "Architecture approval registry",
      "architecture_fixture",
      "enterprise-architecture",
      168,
      10,
      null,
      "architecture-20260903",
    ],
    [
      "enterprise-licensing",
      "Enterprise licensing",
      "licensing_fixture",
      "vendor-management",
      720,
      3,
      1,
      "licensing-20260901",
    ],
  ] as const;

  return definitions.map(
    ([
      key,
      name,
      adapterKind,
      owner,
      freshness,
      successAge,
      failureAge,
      run,
    ]) => ({
      id: stableUuid("inventory-source", key),
      fixtureKey: "inventory-source:" + key,
      name,
      adapterKind,
      ownerOrganizationId: required(
        organizationIds,
        owner,
        "inventory source owner",
      ),
      expectedFreshnessHours: freshness,
      lifecycle: "active",
      lastSuccessfulAt: daysBefore(referenceTime, successAge),
      lastFailedAt:
        failureAge === null ? null : daysBefore(referenceTime, failureAge),
      currentSyncRunId: stableUuid("inventory-sync-run", run),
      rowVersion: 1,
      createdAt: daysBefore(referenceTime, 90),
      updatedAt: daysBefore(referenceTime, 1),
    }),
  );
}

function buildRuns(
  sourceIds: Map<string, string>,
  catalogCount: number,
  referenceTime: string,
): RunRow[] {
  return [
    run({
      key: "servicenow-20260903",
      sourceKey: "servicenow-cmdb",
      sourceVersion: "2026-09-03",
      recordCount: catalogCount,
      sourceIds,
      at: referenceTime,
    }),
    run({
      key: "architecture-20260824",
      sourceKey: "architecture-registry",
      sourceVersion: "2026-08-24",
      recordCount: 3,
      sourceIds,
      at: daysBefore(referenceTime, 10),
    }),
    run({
      key: "architecture-20260903",
      sourceKey: "architecture-registry",
      sourceVersion: "2026-09-03",
      recordCount: 30,
      sourceIds,
      at: referenceTime,
    }),
    run({
      key: "licensing-20260801",
      sourceKey: "enterprise-licensing",
      sourceVersion: "2026-08-01",
      recordCount: 1,
      sourceIds,
      at: daysBefore(referenceTime, 33),
    }),
    run({
      key: "licensing-20260901",
      sourceKey: "enterprise-licensing",
      sourceVersion: "2026-09-01",
      recordCount: 19,
      sourceIds,
      at: daysBefore(referenceTime, 3),
    }),
    run({
      key: "licensing-20260903-failed",
      sourceKey: "enterprise-licensing",
      sourceVersion: "2026-09-03-failed",
      recordCount: 0,
      sourceIds,
      at: daysBefore(referenceTime, 1),
      error: "The fixture file ended before the header row.",
    }),
  ];
}

function run({
  key,
  sourceKey,
  sourceVersion,
  recordCount,
  sourceIds,
  at,
  error = null,
}: {
  key: string;
  sourceKey: string;
  sourceVersion: string;
  recordCount: number;
  sourceIds: Map<string, string>;
  at: string;
  error?: string | null;
}): RunRow {
  return {
    id: stableUuid("inventory-sync-run", key),
    fixtureKey: "inventory-sync-run:" + key,
    sourceId: required(sourceIds, sourceKey, "inventory source"),
    sourceVersion,
    status: error ? "failed" : "succeeded",
    recordCount,
    contentHash: error
      ? null
      : contentHash({ sourceKey, sourceVersion, recordCount }),
    sanitizedError: error,
    startedAt: shiftMinutes(at, -5),
    completedAt: at,
  };
}

function buildRecords(
  catalogItems: CatalogRow[],
  sourceIds: Map<string, string>,
  organizationIds: Map<string, string>,
  referenceTime: string,
): RecordRow[] {
  const organizationNames = new Map(
    seedOrganizations.map((organization) => [
      required(organizationIds, organization.key, "organization"),
      organization.name,
    ]),
  );
  return catalogItems.flatMap((item, index) =>
    recordsForItem({
      item,
      index,
      sourceIds,
      organizationNames,
      referenceTime,
    }),
  );
}

function recordsForItem({
  item,
  index,
  sourceIds,
  organizationNames,
  referenceTime,
}: {
  item: CatalogRow;
  index: number;
  sourceIds: Map<string, string>;
  organizationNames: Map<string, string>;
  referenceTime: string;
}): RecordRow[] {
  const fields = sourceFields(item, organizationNames);
  const context = { item, index, fields, sourceIds, referenceTime };
  const records = [
    record({
      sourceKey: "servicenow-cmdb",
      runKey: "servicenow-20260903",
      recordKey: "CI-" + String(index + 1).padStart(4, "0"),
      item,
      state: "present",
      fields,
      sourceIds,
      observedAt: referenceTime,
    }),
  ];
  const architectureSpecial = isArchitectureSpecial(item.itemKey);
  if (architectureSpecial) records.push(architecturePriorRecord(context));
  if (index % 2 === 0 || architectureSpecial)
    records.push(architectureCurrentRecord(context, architectureSpecial));
  if (index % 3 === 0) records.push(...licensingRecords(context));
  return records;
}

function architecturePriorRecord(context: RecordContext): RecordRow {
  return record({
    sourceKey: "architecture-registry",
    runKey: "architecture-20260824",
    recordKey: "AR-" + String(context.index + 1).padStart(4, "0"),
    item: context.item,
    state: "present",
    fields: context.fields,
    sourceIds: context.sourceIds,
    observedAt: daysBefore(context.referenceTime, 10),
  });
}

function architectureCurrentRecord(
  context: RecordContext,
  hasPrior: boolean,
): RecordRow {
  const changed =
    context.item.itemKey === "colorado-azure-landing-zone"
      ? {
          ...context.fields,
          name: "Azure Application Landing Zone",
          owner: "Platform Enablement",
        }
      : context.fields;
  return record({
    sourceKey: "architecture-registry",
    runKey: "architecture-20260903",
    recordKey: "AR-" + String(context.index + 1).padStart(4, "0"),
    item: context.item,
    state: "present",
    fields: changed,
    sourceIds: context.sourceIds,
    observedAt: context.referenceTime,
    priorRecordId: hasPrior
      ? stableUuid(
          "inventory-record",
          "architecture-20260824:" + context.item.itemKey,
        )
      : null,
  });
}

function licensingRecords(context: RecordContext): RecordRow[] {
  const stale = context.item.itemKey === "event-relay-bus";
  const recordKey = "LIC-" + String(context.index + 1).padStart(4, "0");
  const prior = stale
    ? record({
        sourceKey: "enterprise-licensing",
        runKey: "licensing-20260801",
        recordKey,
        item: context.item,
        state: "present",
        fields: context.fields,
        sourceIds: context.sourceIds,
        observedAt: daysBefore(context.referenceTime, 33),
      })
    : null;
  const current = record({
    sourceKey: "enterprise-licensing",
    runKey: "licensing-20260901",
    recordKey,
    item: context.item,
    state: stale ? "stale" : "present",
    fields: context.fields,
    sourceIds: context.sourceIds,
    observedAt: daysBefore(context.referenceTime, 3),
    priorRecordId: prior?.id ?? null,
  });
  return prior ? [prior, current] : [current];
}

function record({
  sourceKey,
  runKey,
  recordKey,
  item,
  state,
  fields,
  sourceIds,
  observedAt,
  priorRecordId = null,
}: {
  sourceKey: string;
  runKey: string;
  recordKey: string;
  item: CatalogRow;
  state: "present" | "stale";
  fields: Record<string, unknown>;
  sourceIds: Map<string, string>;
  observedAt: string;
  priorRecordId?: string | null;
}): RecordRow {
  const identity = runKey + ":" + item.itemKey;
  return {
    id: stableUuid("inventory-record", identity),
    fixtureKey: "inventory-record:" + identity,
    runId: stableUuid("inventory-sync-run", runKey),
    sourceId: required(sourceIds, sourceKey, "source record source"),
    sourceRecordKey: recordKey,
    state,
    rawPayload: {
      recordKey,
      productName: fields.name,
      owner: fields.owner,
      approval: fields.approvalStatus,
      license: fields.licenseModel,
    },
    normalizedFields: fields,
    contentHash: contentHash({ state, fields }),
    priorRecordId,
    observedAt,
  };
}

function latestRecordsByItem(records: RecordRow[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of records) {
    const key = (row.normalizedFields as { itemKey?: string }).itemKey;
    if (!key || isPriorRun(row.runId)) continue;
    result.set(key, [...(result.get(key) ?? []), row.id]);
  }
  return result;
}

function buildAliases(
  catalogItems: CatalogRow[],
  sourceIds: Map<string, string>,
  actorIds: Map<string, string>,
  referenceTime: string,
): SeedData["inventoryAliases"] {
  return catalogItems.slice(0, 12).map((item, index) => ({
    id: stableUuid("inventory-alias", item.itemKey),
    fixtureKey: "inventory-alias:" + item.itemKey,
    alias: item.name.replaceAll(" ", ""),
    normalizedAlias: item.name.toLowerCase().replaceAll(/[^a-z0-9]/g, ""),
    sourceId:
      index % 2 === 0
        ? required(sourceIds, "architecture-registry", "alias source")
        : null,
    catalogItemId: item.id,
    createdByActorId: required(actorIds, "maya-chen", "catalog steward"),
    createdAt: daysBefore(referenceTime, 30),
  }));
}

function selectConflictItems(
  catalogItems: CatalogRow[],
  latestRecords: Map<string, string[]>,
): CatalogRow[] {
  const candidates = catalogItems.filter(
    (item) => (latestRecords.get(item.itemKey)?.length ?? 0) > 1,
  );
  const keys = [
    "colorado-azure-landing-zone",
    "notify-stream",
    "datalake-foundry",
    ...candidates.map((item) => item.itemKey),
  ].filter((key, index, all) => all.indexOf(key) === index);
  return keys
    .map((key) => candidates.find((item) => item.itemKey === key))
    .filter((item): item is CatalogRow => Boolean(item))
    .slice(0, 12);
}

function buildConflicts(
  items: CatalogRow[],
  runs: RunRow[],
  referenceTime: string,
): ConflictRow[] {
  const serviceNowRun = requiredRun(runs, "servicenow-20260903");
  const architectureRun = requiredRun(runs, "architecture-20260903");
  return items.map((item, index) => {
    const state = conflictState(index);
    return {
      id: stableUuid("inventory-conflict", item.itemKey),
      fixtureKey: "inventory-conflict:" + item.itemKey,
      catalogItemId: item.id,
      state,
      openedByRunId: serviceNowRun.id,
      reopenedByRunId: state === "reopened" ? architectureRun.id : null,
      currentEvidenceVersion: 1,
      currentResolutionVersion: state === "open" ? null : 1,
      rowVersion: 1,
      createdAt: daysBefore(referenceTime, 20),
      updatedAt:
        state === "reopened" ? referenceTime : daysBefore(referenceTime, 7),
    };
  });
}

function buildConflictMembers(
  conflicts: ConflictRow[],
  catalogItems: CatalogRow[],
  latestRecords: Map<string, string[]>,
): SeedData["inventoryConflictMembers"] {
  const itemKeyById = new Map(
    catalogItems.map((item) => [item.id, item.itemKey]),
  );
  return conflicts.flatMap((conflict) => {
    const itemKey = required(
      itemKeyById,
      conflict.catalogItemId ?? "",
      "conflict catalog item",
    );
    return (latestRecords.get(itemKey) ?? []).map((sourceRecordId, index) => ({
      id: stableUuid(
        "inventory-conflict-member",
        conflict.id + ":" + sourceRecordId,
      ),
      fixtureKey: "inventory-conflict-member:" + conflict.id + ":1:" + index,
      conflictId: conflict.id,
      evidenceVersion: 1,
      sourceRecordId,
      groupingReason:
        index === 0
          ? "Exact normalized product name"
          : "Configured alias with conflicting governed fields",
    }));
  });
}

function buildFieldDecisions({
  catalogItems,
  latestRecords,
  records,
  organizationIds,
  actorIds,
  referenceTime,
}: {
  catalogItems: CatalogRow[];
  latestRecords: Map<string, string[]>;
  records: RecordRow[];
  organizationIds: Map<string, string>;
  actorIds: Map<string, string>;
  referenceTime: string;
}): SeedData["catalogFieldDecisions"] {
  const recordIds = new Set(records.map((row) => row.id));
  const organizationNames = new Map(
    seedOrganizations.map((organization) => [
      required(organizationIds, organization.key, "organization"),
      organization.name,
    ]),
  );
  return catalogItems.flatMap((item) => {
    const sourceRecordId = latestRecords.get(item.itemKey)?.[0];
    if (!sourceRecordId || !recordIds.has(sourceRecordId))
      throw new Error("Catalog item has no source record: " + item.itemKey);
    const fields: Array<[string, unknown]> = [
      ["name", item.name],
      [
        "owner",
        required(
          organizationNames,
          item.ownerOrganizationId,
          "catalog owner name",
        ),
      ],
      ["approvalStatus", item.approvalStatus],
      ["description", item.description],
      ["itemType", item.itemType],
      ["ownerOrganizationId", item.ownerOrganizationId],
      ["capabilities", item.capabilities],
      ["dataClassifications", item.dataClassifications],
    ];
    return fields.map(([fieldName, value]) =>
      decision({
        item,
        fieldName,
        value,
        sourceRecordId,
        actorIds,
        referenceTime,
      }),
    );
  });
}

function decision({
  item,
  fieldName,
  value,
  sourceRecordId,
  actorIds,
  referenceTime,
}: {
  item: CatalogRow;
  fieldName: string;
  value: unknown;
  sourceRecordId: string;
  actorIds: Map<string, string>;
  referenceTime: string;
}): SeedData["catalogFieldDecisions"][number] {
  return {
    id: stableUuid("catalog-field-decision", item.itemKey + ":1:" + fieldName),
    fixtureKey: "catalog-field-decision:" + item.itemKey + ":1:" + fieldName,
    catalogItemId: item.id,
    canonicalVersion: 1,
    fieldName,
    value,
    sourceRecordId,
    decidedByActorId: required(actorIds, "maya-chen", "catalog field steward"),
    rationale: null,
    supersedesId: null,
    createdAt: daysBefore(referenceTime, 14),
  };
}

function buildCatalogSources(
  items: CatalogRow[],
  latestRecords: Map<string, string[]>,
): SeedData["catalogItemSources"] {
  return items.flatMap((item) =>
    (latestRecords.get(item.itemKey) ?? []).map((sourceRecordId) => ({
      catalogItemId: item.id,
      sourceRecordId,
      fixtureKey: "catalog-item-source:" + item.itemKey + ":" + sourceRecordId,
    })),
  );
}

function sourceFields(
  item: CatalogRow,
  organizationNames: Map<string, string>,
): Record<string, unknown> {
  return {
    itemKey: item.itemKey,
    name: item.name,
    vendor: item.vendor,
    owner: required(
      organizationNames,
      item.ownerOrganizationId,
      "catalog owner",
    ),
    approvalStatus: item.approvalStatus,
    publicationState: item.publicationState,
    itemType: item.itemType,
    licenseModel: item.licenseModel,
    reviewDate: item.reviewDate,
    renewalDate: item.renewalDate,
    description: item.description,
    ownerOrganizationId: item.ownerOrganizationId,
    capabilities: item.capabilities,
    dataClassifications: item.dataClassifications,
  };
}

function isArchitectureSpecial(itemKey: string): boolean {
  return [
    "colorado-azure-landing-zone",
    "notify-stream",
    "datalake-foundry",
  ].includes(itemKey);
}

function isPriorRun(runId: string): boolean {
  return [
    stableUuid("inventory-sync-run", "architecture-20260824"),
    stableUuid("inventory-sync-run", "licensing-20260801"),
  ].includes(runId);
}

function conflictState(index: number): "open" | "resolved" | "reopened" {
  if (index < 3) return "reopened";
  if (index < 7) return "open";
  return "resolved";
}

function requiredRun(runs: RunRow[], key: string): RunRow {
  const runRow = runs.find(
    (candidate) => candidate.fixtureKey === "inventory-sync-run:" + key,
  );
  if (!runRow) throw new Error("Missing inventory run: " + key);
  return runRow;
}

function fixtureKeyMap<T extends { id: string; fixtureKey?: string | null }>(
  rows: T[],
): Map<string, string> {
  return new Map(
    rows.map((row) => {
      if (!row.fixtureKey) throw new Error("Fixture key is missing");
      return [row.fixtureKey.slice(row.fixtureKey.indexOf(":") + 1), row.id];
    }),
  );
}

function required<K, V>(values: Map<K, V>, key: K, label: string): V {
  const value = values.get(key);
  if (value === undefined) throw new Error("Missing " + label + ": " + key);
  return value;
}

function shiftMinutes(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}
