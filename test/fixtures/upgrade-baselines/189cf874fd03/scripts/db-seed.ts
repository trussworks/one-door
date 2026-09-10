import { eq, sql } from "drizzle-orm";

import { createDatabase } from "../src/db/client.ts";
import {
  actors,
  assetAssessments,
  assetCandidateDecisions,
  assetCandidates,
  auditEvents,
  catalogFieldDecisions,
  catalogItems,
  catalogItemSources,
  draftTurns,
  drafts,
  externalWorkItems,
  fixtureSeedManifests,
  inventoryAliases,
  inventoryConflictMembers,
  inventoryConflicts,
  inventorySourceRecords,
  inventorySources,
  inventorySyncRuns,
  modelCalls,
  organizations,
  policyRules,
  requestWorkItemLinks,
  requests,
  reviewTasks,
  riceScores,
  riskAssessments,
  riskFindingDecisions,
  riskFindings,
  serviceCandidates,
  serviceOfferings,
  taskCompletions,
  visitors,
  wip,
  workSyncRuns,
  workSystems,
} from "../src/db/schema.ts";
import { buildSeedData } from "../src/seed/build.ts";
import { contentHash } from "../src/seed/stable.ts";

const seed = buildSeedData();
const seedHash = contentHash(seed);
const { db, sql: client } = createDatabase();
type SeedTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

let inserted = false;
try {
  inserted = await db.transaction(async (transaction) => {
    await transaction.execute(sql.raw("SELECT pg_advisory_xact_lock(9248662)"));
    if (await fixtureAlreadyInstalled(transaction)) return false;
    await insertCore(transaction);
    await insertInventory(transaction);
    await insertReview(transaction);
    await insertMonitoring(transaction);
    await transaction.insert(auditEvents).values(seed.auditEvents);
    await transaction.insert(fixtureSeedManifests).values({
      name: "reference",
      contentHash: seedHash,
    });
    return true;
  });
} finally {
  await client.end();
}

console.log(
  inserted
    ? [
        "Seeded the production-MVP reference fixture.",
        "organizations=" + seed.organizations.length,
        "actors=" + seed.actors.length,
        "services=" + seed.serviceOfferings.length,
        "catalog=" + seed.catalogItems.length,
        "requests=" + seed.requests.length,
      ].join(" ")
    : "Reference fixture already matches; no rows changed.",
);

async function fixtureAlreadyInstalled(
  transaction: SeedTransaction,
): Promise<boolean> {
  const [existing] = await transaction
    .select({ contentHash: fixtureSeedManifests.contentHash })
    .from(fixtureSeedManifests)
    .where(eq(fixtureSeedManifests.name, "reference"))
    .limit(1);
  if (!existing) return false;
  if (existing.contentHash !== seedHash) {
    throw new Error(
      "The installed reference fixture differs from this seed. Use a clean database or the explicit fixture-reset path.",
    );
  }
  return true;
}

async function insertCore(transaction: SeedTransaction): Promise<void> {
  await transaction.insert(organizations).values(seed.organizations);
  await transaction.insert(actors).values(seed.actors);
  if (seed.visitors.length)
    await transaction.insert(visitors).values(seed.visitors);
  if (seed.wip.length) await transaction.insert(wip).values(seed.wip);
  await transaction.insert(serviceOfferings).values(seed.serviceOfferings);
  await transaction.insert(drafts).values(seed.drafts);
  await transaction.insert(modelCalls).values(seed.modelCalls);
  await transaction.insert(draftTurns).values(seed.draftTurns);
  await transaction.insert(serviceCandidates).values(seed.serviceCandidates);
  await transaction.insert(requests).values(
    seed.requests.map((request) => ({
      ...request,
      currentRiceScoreId: null,
    })),
  );
  await transaction.insert(taskCompletions).values(seed.taskCompletions);
}

async function insertInventory(transaction: SeedTransaction): Promise<void> {
  await transaction.insert(inventorySources).values(
    seed.inventorySources.map((source) => ({
      ...source,
      currentSyncRunId: null,
    })),
  );
  await transaction.insert(inventorySyncRuns).values(seed.inventorySyncRuns);
  await restoreInventoryRunPointers(transaction);
  await transaction
    .insert(inventorySourceRecords)
    .values(orderSourceRecords(seed.inventorySourceRecords));
  await transaction.insert(catalogItems).values(seed.catalogItems);
  await transaction.insert(inventoryAliases).values(seed.inventoryAliases);
  await transaction.insert(inventoryConflicts).values(seed.inventoryConflicts);
  await transaction
    .insert(inventoryConflictMembers)
    .values(seed.inventoryConflictMembers);
  await transaction
    .insert(catalogFieldDecisions)
    .values(seed.catalogFieldDecisions);
  await transaction.insert(catalogItemSources).values(seed.catalogItemSources);
}

async function restoreInventoryRunPointers(
  transaction: SeedTransaction,
): Promise<void> {
  for (const source of seed.inventorySources) {
    if (!source.currentSyncRunId) continue;
    await transaction
      .update(inventorySources)
      .set({ currentSyncRunId: source.currentSyncRunId })
      .where(eq(inventorySources.id, source.id));
  }
}

async function insertReview(transaction: SeedTransaction): Promise<void> {
  await transaction.insert(reviewTasks).values(seed.reviewTasks);
  await transaction.insert(assetAssessments).values(seed.assetAssessments);
  await transaction.insert(assetCandidates).values(
    seed.assetCandidates.map((candidate) => ({
      ...candidate,
      currentDecisionId: null,
    })),
  );
  await transaction
    .insert(assetCandidateDecisions)
    .values(seed.assetCandidateDecisions);
  await restoreAssetDecisionPointers(transaction);
  await transaction.insert(policyRules).values(seed.policyRules);
  await transaction.insert(riskAssessments).values(seed.riskAssessments);
  await transaction.insert(riskFindings).values(
    seed.riskFindings.map((finding) => ({
      ...finding,
      currentDecisionId: null,
    })),
  );
  await transaction
    .insert(riskFindingDecisions)
    .values(seed.riskFindingDecisions);
  await restoreRiskDecisionPointers(transaction);
  await transaction.insert(riceScores).values(seed.riceScores);
  await restoreRicePointers(transaction);
}

async function restoreAssetDecisionPointers(
  transaction: SeedTransaction,
): Promise<void> {
  for (const candidate of seed.assetCandidates) {
    if (!candidate.currentDecisionId) continue;
    await transaction
      .update(assetCandidates)
      .set({ currentDecisionId: candidate.currentDecisionId })
      .where(eq(assetCandidates.id, candidate.id));
  }
}

async function restoreRiskDecisionPointers(
  transaction: SeedTransaction,
): Promise<void> {
  for (const finding of seed.riskFindings) {
    if (!finding.currentDecisionId) continue;
    await transaction
      .update(riskFindings)
      .set({ currentDecisionId: finding.currentDecisionId })
      .where(eq(riskFindings.id, finding.id));
  }
}

async function restoreRicePointers(
  transaction: SeedTransaction,
): Promise<void> {
  for (const request of seed.requests) {
    if (!request.currentRiceScoreId) continue;
    await transaction
      .update(requests)
      .set({ currentRiceScoreId: request.currentRiceScoreId })
      .where(eq(requests.id, request.id));
  }
}

async function insertMonitoring(transaction: SeedTransaction): Promise<void> {
  await transaction.insert(workSystems).values(seed.workSystems);
  await transaction.insert(workSyncRuns).values(seed.workSyncRuns);
  await transaction.insert(externalWorkItems).values(seed.externalWorkItems);
  await transaction
    .insert(requestWorkItemLinks)
    .values(seed.requestWorkItemLinks);
}

function orderSourceRecords(
  records: typeof seed.inventorySourceRecords,
): typeof seed.inventorySourceRecords {
  const remaining = new Map(records.map((record) => [record.id, record]));
  const ordered: typeof seed.inventorySourceRecords = [];
  const inserted = new Set<string>();

  while (remaining.size) {
    const ready = [...remaining.values()].filter(
      (record) => !record.priorRecordId || inserted.has(record.priorRecordId),
    );
    if (!ready.length)
      throw new Error("Inventory source records contain a prior-version cycle");
    for (const record of ready) {
      ordered.push(record);
      inserted.add(record.id);
      remaining.delete(record.id);
    }
  }
  return ordered;
}
