import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { createDatabase } from "../db/client.ts";
import type { ActorContext } from "../workflow/shared.ts";
import {
  assetCandidates,
  auditEvents,
  catalogItems,
  externalWorkItems,
  fixtureSeedManifests,
  inventoryConflicts,
  inventorySources,
  requests,
  reviewTasks,
  riskFindings,
  serviceCandidates,
  workSystems,
} from "../db/schema.ts";
import { buildSeedData } from "./build.ts";
import { ensureLifecycleEvidence } from "./lifecycle-evidence.ts";
import { contentHash } from "./stable.ts";

type Db = ReturnType<typeof createDatabase>["db"];
type ResetTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SeedData = ReturnType<typeof buildSeedData>;

export interface ResetOutcome {
  advancedGenerations: number;
  supersededModelJobs: number;
}

/**
 * Restore the shared fixture-derived current state in one transaction while
 * preserving every live row: visitor requests, WIP, answers, completions,
 * ratings, spend, and immutable evidence. Fixture requests bound by live
 * terminal rows advance a generation instead of losing that evidence, and
 * undone model jobs on fixture subjects are superseded so no worker can
 * repopulate the restored state.
 */
export async function resetFixtureState(
  db: Db,
  actor?: ActorContext,
): Promise<ResetOutcome> {
  const seed = buildSeedData();
  const systemActorId = seed.actors.find(
    (actor) => actor.fixtureKey === "actor:one-door-system",
  )?.id;
  if (!systemActorId)
    throw new Error("Seed is missing the One Door system actor");
  const resetAt = new Date().toISOString();

  return db.transaction(async (transaction) => {
    await transaction.execute(sql.raw("SELECT pg_advisory_xact_lock(9248663)"));
    await requireMatchingManifest(transaction, contentHash(seed));
    const supersededModelJobs = await supersedeFixtureModelJobs(transaction);
    const advancedGenerations = await advanceStrandedGenerations(transaction);
    await resetRequests(transaction, seed);
    await resetInventory(transaction, seed);
    await resetCatalog(transaction, seed);
    await resetReview(transaction, seed);
    // Re-materialize seeded delivery, resolved, and waiting evidence at each
    // request's current generation, so an example a live action pushed to a new
    // generation returns to its reference phase while the live rows stay history.
    await ensureLifecycleEvidence(transaction, seed);
    await resetMonitoring(transaction, seed);
    await recordReset(
      transaction,
      actor ?? { actorId: systemActorId, actingView: "administrator" },
      resetAt,
      {
        advancedGenerations,
        supersededModelJobs,
      },
    );
    return { advancedGenerations, supersededModelJobs };
  });
}

async function requireMatchingManifest(
  transaction: ResetTransaction,
  expectedSeedHash: string,
): Promise<void> {
  const [manifest] = await transaction
    .select({ contentHash: fixtureSeedManifests.contentHash })
    .from(fixtureSeedManifests)
    .where(eq(fixtureSeedManifests.name, "reference"))
    .limit(1);
  if (!manifest || manifest.contentHash !== expectedSeedHash) {
    throw new Error(
      "Fixture reset refused because the installed reference fixture does not match this build.",
    );
  }
}

/**
 * A queued or leased model job on a fixture draft or request must never
 * finalize into the restored state. Superseding under the same lease rules
 * the worker checks makes a late finalize settle as lease_lost; the
 * interrupted reservation is reconciled as failed, never assumed free.
 */
async function supersedeFixtureModelJobs(
  transaction: ResetTransaction,
): Promise<number> {
  const superseded = (await transaction.execute(
    sql.raw(`
      UPDATE model_jobs SET
        status = 'superseded',
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = now()
      WHERE status IN ('queued', 'leased')
        AND (
          draft_id IN (SELECT id FROM drafts WHERE fixture_key IS NOT NULL)
          OR request_id IN (SELECT id FROM requests WHERE fixture_key IS NOT NULL)
        )
      RETURNING current_model_call_id
    `),
  )) as unknown as Array<{ current_model_call_id: string | null }>;
  const callIds = superseded
    .map((row) => row.current_model_call_id)
    .filter((id): id is string => id !== null);
  if (callIds.length > 0) {
    await transaction.execute(
      sql.raw(`
        UPDATE model_calls SET
          status = 'failed',
          sanitized_error = 'fixture_reset_superseded',
          completed_at = now()
        WHERE status = 'reserved'
          AND id IN (${callIds.map((id) => `'${id}'`).join(", ")})
      `),
    );
  }
  return superseded.length;
}

/**
 * A fixture request with a live completion, resolution, handoff, open
 * question, or live assessment at its current generation cannot replay the
 * scenario: the once-per-request rules, immutable rows, and currency rules
 * still bind. Advancing the generation frees the restored scenario while
 * every prior row remains untouched evidence.
 */
async function advanceStrandedGenerations(
  transaction: ResetTransaction,
): Promise<number> {
  const advanced = (await transaction.execute(
    sql.raw(`
      UPDATE requests r SET fixture_generation = fixture_generation + 1
      WHERE r.fixture_key IS NOT NULL
        AND (
          EXISTS (
            SELECT 1 FROM task_completions c
            WHERE c.request_id = r.id
              AND c.request_generation = r.fixture_generation
              AND c.fixture_key IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM request_resolutions x
            WHERE x.request_id = r.id
              AND x.request_generation = r.fixture_generation
              AND x.fixture_key IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM delivery_handoffs h
            WHERE h.request_id = r.id
              AND h.request_generation = r.fixture_generation
              AND (h.fixture_key IS NULL OR h.row_version > 1)
          )
          OR EXISTS (
            SELECT 1 FROM clarification_requests q
            WHERE q.request_id = r.id
              AND q.request_generation = r.fixture_generation
              AND (q.fixture_key IS NULL OR q.answered_at IS NOT NULL)
          )
          OR EXISTS (
            SELECT 1 FROM asset_assessments a
            WHERE a.draft_id = r.source_draft_id
              AND a.origin <> 'fixture'
              AND a.request_generation = r.fixture_generation
          )
          OR EXISTS (
            SELECT 1 FROM risk_assessments s
            WHERE s.draft_id = r.source_draft_id
              AND s.origin <> 'fixture'
              AND s.request_generation = r.fixture_generation
          )
        )
      RETURNING r.id
    `),
  )) as unknown as Array<{ id: string }>;
  return advanced.length;
}

async function resetRequests(
  transaction: ResetTransaction,
  seed: SeedData,
): Promise<void> {
  for (const candidate of seed.serviceCandidates) {
    await expectOne(
      transaction
        .update(serviceCandidates)
        .set({
          decision: candidate.decision,
          decidedByActorId: candidate.decidedByActorId,
          decisionReason: candidate.decisionReason,
          decidedAt: candidate.decidedAt,
        })
        .where(eq(serviceCandidates.id, candidate.id))
        .returning({ id: serviceCandidates.id }),
      candidate.fixtureKey ?? candidate.id,
    );
  }
  for (const request of seed.requests) {
    await restoreRequest(transaction, request);
  }
}

async function restoreRequest(
  transaction: ResetTransaction,
  request: SeedData["requests"][number],
): Promise<void> {
  const reference = request as typeof request & {
    nextOwner?: string | null;
    deliveryOwnerActorId?: string | null;
    nextTask?: string | null;
    currentRevisionId?: string | null;
  };
  await expectOne(
    transaction
      .update(requests)
      .set({
        selectedServiceCandidateId: request.selectedServiceCandidateId,
        routingState: request.routingState,
        title: request.title,
        problem: request.problem,
        affectedPeople: request.affectedPeople,
        acceptanceCriteria: request.acceptanceCriteria,
        requirements: request.requirements,
        constraints: request.constraints,
        unknowns: request.unknowns,
        stage: request.stage,
        coordinatingActorId: request.coordinatingActorId,
        currentRiceScoreId: request.currentRiceScoreId,
        currentRevisionId: reference.currentRevisionId ?? null,
        nextOwner: reference.nextOwner ?? null,
        // The structured pair resets with the legacy text; leaving a stale
        // pair beside a restored nextOwner would misattribute ownership.
        deliveryOwnerActorId: reference.deliveryOwnerActorId ?? null,
        nextTask: reference.nextTask ?? null,
        rowVersion: sql.raw("row_version + 1"),
        updatedAt: request.updatedAt,
        firstReviewCompletedAt: request.firstReviewCompletedAt,
      })
      .where(eq(requests.id, request.id))
      .returning({ id: requests.id }),
    request.fixtureKey ?? request.id,
  );
}

async function resetInventory(
  transaction: ResetTransaction,
  seed: SeedData,
): Promise<void> {
  for (const source of seed.inventorySources) {
    await expectOne(
      transaction
        .update(inventorySources)
        .set({
          name: source.name,
          adapterKind: source.adapterKind,
          ownerOrganizationId: source.ownerOrganizationId,
          expectedFreshnessHours: source.expectedFreshnessHours,
          lifecycle: source.lifecycle,
          lastSuccessfulAt: source.lastSuccessfulAt,
          lastFailedAt: source.lastFailedAt,
          currentSyncRunId: source.currentSyncRunId,
          rowVersion: sql.raw("row_version + 1"),
          updatedAt: source.updatedAt,
        })
        .where(eq(inventorySources.id, source.id))
        .returning({ id: inventorySources.id }),
      source.fixtureKey ?? source.id,
    );
  }
  for (const conflict of seed.inventoryConflicts) {
    await restoreConflict(transaction, conflict);
  }
}

async function restoreConflict(
  transaction: ResetTransaction,
  conflict: SeedData["inventoryConflicts"][number],
): Promise<void> {
  await expectOne(
    transaction
      .update(inventoryConflicts)
      .set({
        catalogItemId: conflict.catalogItemId,
        state: conflict.state,
        openedByRunId: conflict.openedByRunId,
        reopenedByRunId: conflict.reopenedByRunId,
        currentEvidenceVersion: conflict.currentEvidenceVersion,
        currentResolutionVersion: conflict.currentResolutionVersion,
        rowVersion: sql.raw("row_version + 1"),
        updatedAt: conflict.updatedAt,
      })
      .where(eq(inventoryConflicts.id, conflict.id))
      .returning({ id: inventoryConflicts.id }),
    conflict.fixtureKey ?? conflict.id,
  );
}

async function resetCatalog(
  transaction: ResetTransaction,
  seed: SeedData,
): Promise<void> {
  for (const item of seed.catalogItems) {
    await expectOne(
      transaction
        .update(catalogItems)
        .set({
          publicationState: item.publicationState,
          approvalStatus: item.approvalStatus,
          itemType: item.itemType,
          currentVersion: item.currentVersion,
          name: item.name,
          vendor: item.vendor,
          description: item.description,
          capabilities: item.capabilities,
          ownerOrganizationId: item.ownerOrganizationId,
          licenseModel: item.licenseModel,
          dataClassifications: item.dataClassifications,
          integrations: item.integrations,
          reviewDate: item.reviewDate,
          renewalDate: item.renewalDate,
          rowVersion: sql.raw("row_version + 1"),
          updatedAt: item.updatedAt,
        })
        .where(eq(catalogItems.id, item.id))
        .returning({ id: catalogItems.id }),
      item.fixtureKey ?? item.id,
    );
  }
}

async function resetReview(
  transaction: ResetTransaction,
  seed: SeedData,
): Promise<void> {
  for (const task of seed.reviewTasks) {
    await expectOne(
      transaction
        .update(reviewTasks)
        .set({
          responsibleCapability: task.responsibleCapability,
          assigneeActorId: task.assigneeActorId,
          state: task.state,
          completedAssessmentId: task.completedAssessmentId ?? null,
          rowVersion: sql.raw("row_version + 1"),
          updatedAt: task.updatedAt,
          completedAt: task.completedAt,
        })
        .where(eq(reviewTasks.id, task.id))
        .returning({ id: reviewTasks.id }),
      task.fixtureKey ?? task.id,
    );
  }
  await restorePointers(transaction, assetCandidates, seed.assetCandidates);
  await restorePointers(transaction, riskFindings, seed.riskFindings);
}

async function restorePointers(
  transaction: ResetTransaction,
  table: typeof assetCandidates | typeof riskFindings,
  rows: Array<{ id: string; currentDecisionId?: string | null }>,
): Promise<void> {
  for (const row of rows) {
    await transaction
      .update(table)
      .set({ currentDecisionId: row.currentDecisionId })
      .where(eq(table.id, row.id));
  }
}

async function resetMonitoring(
  transaction: ResetTransaction,
  seed: SeedData,
): Promise<void> {
  for (const system of seed.workSystems) {
    await transaction
      .update(workSystems)
      .set({
        name: system.name,
        authoritativeBaseUrl: system.authoritativeBaseUrl,
        expectedFreshnessHours: system.expectedFreshnessHours,
        lastSuccessfulAt: system.lastSuccessfulAt,
        syncHealth: system.syncHealth,
      })
      .where(eq(workSystems.system, system.system));
  }
  for (const item of seed.externalWorkItems) {
    const reference = item as typeof item & { closedAt?: string | null };
    await transaction
      .update(externalWorkItems)
      .set({
        title: item.title,
        sourceStatus: item.sourceStatus,
        sourceOwner: item.sourceOwner,
        sourceUrl: item.sourceUrl,
        sourceUpdatedAt: item.sourceUpdatedAt,
        lastSynchronizedAt: item.lastSynchronizedAt,
        syncHealth: item.syncHealth,
        closedAt: reference.closedAt ?? null,
      })
      .where(eq(externalWorkItems.id, item.id));
  }
}

async function recordReset(
  transaction: ResetTransaction,
  actor: ActorContext,
  resetAt: string,
  outcome: ResetOutcome,
): Promise<void> {
  await transaction.insert(auditEvents).values({
    id: randomUUID(),
    actorId: actor.actorId,
    visitorId: actor.visitorId ?? null,
    actingView: actor.actingView,
    eventType: "fixture_reset_completed",
    subjectType: "fixture",
    subjectId: null,
    payload: {
      resetAt,
      advancedGenerations: outcome.advancedGenerations,
      supersededModelJobs: outcome.supersededModelJobs,
      preserved: [
        "visitor work",
        "live requests",
        "task completions",
        "model usage",
        "audit history",
      ],
    },
    origin: actor.visitorId ? "live" : "system",
    createdAt: resetAt,
  });
}

async function expectOne(
  operation: Promise<Array<{ id?: string; system?: string }>>,
  label: string,
): Promise<void> {
  const rows = await operation;
  if (rows.length !== 1)
    throw new Error("Fixture reset could not restore " + label);
}
