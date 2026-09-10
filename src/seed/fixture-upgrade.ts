import { and, eq, isNull, notExists, sql } from "drizzle-orm";

import type { createDatabase } from "../db/client.ts";
import {
  assetAssessments,
  assetCandidateDecisions,
  assetCandidates,
  auditEvents,
  clarificationRequests,
  deliveryHandoffs,
  draftTurns,
  drafts,
  fixtureSeedManifests,
  modelCalls,
  requestContentRevisions,
  requestResolutions,
  requests,
  reviewTasks,
  riceScores,
  riskAssessments,
  riskFindingDecisions,
  riskFindings,
  serviceCandidates,
  taskCompletions,
} from "../db/schema.ts";
import { buildSeedData } from "./build.ts";
import { demoCoordinatorKey } from "./actors.ts";
import { ensureLifecycleEvidence } from "./lifecycle-evidence.ts";
import { contentHash, stableUuid } from "./stable.ts";

type Db = ReturnType<typeof createDatabase>["db"];
type UpgradeTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SeedData = ReturnType<typeof buildSeedData>;

/**
 * contentHash(buildSeedData()) of the last seed before the fixture
 * coherence corrections (corpus-hash formula, versioned evidence
 * identities, completed-review RICE scores, completed-area evidence pins).
 * This is the only installed manifest the upgrade knows how to correct;
 * anything else fails closed.
 */
const PRE_CORRECTION_SEED_HASH =
  "995a3ecefa56131d1d051e094b5a3bf8bb8ba993c1222c9e7decb67473d8f20e";
// Later known-good seeds the upgrade also advances to the current build. Each
// upgrade step is append-only or null-guarded, so applying every step from any
// of these installs converges on the current seed without touching live rows.
// 4e19bb48…: added delivery-owner columns and lifecycle examples were absent.
const PRE_OWNER_SEED_HASH =
  "4e19bb4890b0fdba5279d0ba2c6f08adfc77df1d0f1797259ea665cff390e3db";
// 6466fa43…: delivery-owner columns present; lifecycle examples still absent.
const PRE_LIFECYCLE_SEED_HASH =
  "6466fa4336be805ac0b133cada9b62fe90016340fb0ac2711038bc8a67c347e7";
// The build before seeded requests drew a coordinator from everyone holding
// the first-review capability, when every example named the same person.
const PRE_COORDINATOR_VARIETY_SEED_HASH =
  "6949e8409740b25126b167799d9324be92d786151a5e7b80a4ee991ba4f03fba";

const KNOWN_PRIOR_SEED_HASHES = new Set([
  PRE_CORRECTION_SEED_HASH,
  PRE_OWNER_SEED_HASH,
  PRE_LIFECYCLE_SEED_HASH,
  PRE_COORDINATOR_VARIETY_SEED_HASH,
]);

export interface UpgradeOutcome {
  status: "upgraded" | "already-current";
  insertedRows: number;
}

/**
 * Upgrade an installed pre-correction reference fixture to the corrected
 * seed without rewriting any immutable row. The corrected evidence carries
 * versioned identities inside the seed itself, so the upgrade only inserts
 * the seed's immutable rows a database is missing; fixture reset then owns
 * the corrected evidence exactly as it does on a freshly seeded database.
 * Mutable fixture pointers move only where they still hold the
 * pre-correction value (null), so a live human pointer is never clobbered.
 */
export async function upgradeFixtureState(db: Db): Promise<UpgradeOutcome> {
  const seed = buildSeedData();
  const targetHash = contentHash(seed);
  return db.transaction(async (transaction) => {
    // The same advisory lock as resetFixtureState, so an upgrade and a
    // reset can never interleave.
    await transaction.execute(sql.raw("SELECT pg_advisory_xact_lock(9248663)"));
    const [manifest] = await transaction
      .select({ contentHash: fixtureSeedManifests.contentHash })
      .from(fixtureSeedManifests)
      .where(eq(fixtureSeedManifests.name, "reference"))
      .limit(1);
    if (!manifest)
      throw new Error(
        "Fixture upgrade refused: no reference fixture is installed; seed the database instead.",
      );
    if (manifest.contentHash === targetHash)
      return { status: "already-current" as const, insertedRows: 0 };
    if (!KNOWN_PRIOR_SEED_HASHES.has(manifest.contentHash))
      throw new Error(
        "Fixture upgrade refused: the installed reference fixture is not a known prior build.",
      );
    // Every step below is append-only or null-guarded, so the order handles a
    // database from any known prior: an already-corrected or already-populated
    // step simply inserts nothing and moves no live pointer.
    const insertedRows =
      (await insertLifecycleBase(transaction, seed)) +
      (await insertMissingEvidence(transaction, seed)) +
      (await insertAbsent(transaction, draftTurns, seed.draftTurns)) +
      (await appendReplyTurns(transaction, seed)) +
      (await ensureLifecycleEvidence(transaction, seed));
    await pointCompletedReviews(transaction, seed);
    await pointCurrentRiceScores(transaction, seed);
    await backfillDeliveryOwners(transaction, seed);
    await spreadSeededCoordinators(transaction, seed);
    await transaction
      .update(fixtureSeedManifests)
      .set({ contentHash: targetHash })
      .where(eq(fixtureSeedManifests.name, "reference"));
    return { status: "upgraded" as const, insertedRows };
  });
}

/**
 * Base rows a newly seeded example needs, in dependency order: its draft, the
 * model calls a service candidate and later evidence reference, the service
 * candidate, the request, and the request's task, review, and audit rows.
 * Requests insert with a null RICE pointer, exactly as db-seed does, and
 * pointCurrentRiceScores restores any real pointer afterward.
 */
async function insertLifecycleBase(
  transaction: UpgradeTransaction,
  seed: SeedData,
): Promise<number> {
  let inserted = 0;
  inserted += await insertAbsent(transaction, drafts, seed.drafts);
  inserted += await insertAbsent(transaction, modelCalls, seed.modelCalls);
  inserted += await insertAbsent(
    transaction,
    serviceCandidates,
    seed.serviceCandidates,
  );
  inserted += await insertAbsent(
    transaction,
    requests,
    seed.requests.map((row) => ({ ...row, currentRiceScoreId: null })),
  );
  inserted += await insertAbsent(
    transaction,
    taskCompletions,
    seed.taskCompletions,
  );
  inserted += await insertAbsent(transaction, reviewTasks, seed.reviewTasks);
  inserted += await insertAbsent(transaction, auditEvents, seed.auditEvents);
  return inserted;
}

/** Lock before checking assignment history so a concurrent choice cannot be overwritten. */
async function spreadSeededCoordinators(
  transaction: UpgradeTransaction,
  seed: SeedData,
): Promise<void> {
  const previous = seed.actors.find(
    (actor) => actor.fixtureKey === "actor:" + demoCoordinatorKey,
  );
  if (!previous) throw new Error("The reference coordinator is missing");
  for (const request of seed.requests) {
    const intended = request.coordinatingActorId;
    if (!intended || intended === previous.id) continue;
    const [eligible] = await transaction
      .select({ id: requests.id })
      .from(requests)
      .where(
        and(
          eq(requests.id, request.id),
          eq(requests.fixtureKey, request.fixtureKey!),
          eq(requests.coordinatingActorId, previous.id),
        ),
      )
      .for("update");
    if (!eligible) continue;
    const assigned = transaction
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.subjectType, "request"),
          eq(auditEvents.subjectId, request.id),
          eq(auditEvents.eventType, "review_assigned"),
        ),
      );
    await transaction
      .update(requests)
      .set({
        coordinatingActorId: intended,
        rowVersion: sql.raw("row_version + 1"),
      })
      .where(and(eq(requests.id, request.id), notExists(assigned)));
  }
}

/**
 * Fill the delivery owner only while it is unset, preserving a live hand-off.
 */
async function backfillDeliveryOwners(
  transaction: UpgradeTransaction,
  seed: SeedData,
): Promise<void> {
  for (const request of seed.requests) {
    if (!request.deliveryOwnerActorId && !request.nextOwner) continue;
    await transaction
      .update(requests)
      .set({
        nextOwner: request.nextOwner ?? null,
        deliveryOwnerActorId: request.deliveryOwnerActorId ?? null,
        nextTask: request.nextTask ?? null,
        rowVersion: sql.raw("row_version + 1"),
      })
      .where(
        and(
          eq(requests.id, request.id),
          isNull(requests.deliveryOwnerActorId),
          isNull(requests.nextOwner),
        ),
      );
  }
}

/**
 * Insert every immutable evidence row of the corrected seed that the
 * database does not hold yet, in dependency order. Candidates and findings
 * insert without their decision pointer first, exactly as db-seed does,
 * and receive the seed pointer once the decisions exist — but only rows
 * whose pointer is still unset, so pre-existing rows keep recorded state.
 */
async function insertMissingEvidence(
  transaction: UpgradeTransaction,
  seed: SeedData,
): Promise<number> {
  // Model calls are inserted with the lifecycle base, before the assessments
  // and service candidates that reference them.
  let inserted = 0;
  inserted += await insertAbsent(
    transaction,
    assetAssessments,
    seed.assetAssessments,
  );
  inserted += await insertAbsent(
    transaction,
    assetCandidates,
    seed.assetCandidates.map((row) => ({ ...row, currentDecisionId: null })),
  );
  inserted += await insertAbsent(
    transaction,
    assetCandidateDecisions,
    seed.assetCandidateDecisions,
  );
  await restoreUnsetPointers(
    transaction,
    assetCandidates,
    seed.assetCandidates,
  );
  inserted += await insertAbsent(
    transaction,
    riskAssessments,
    seed.riskAssessments,
  );
  inserted += await insertAbsent(
    transaction,
    riskFindings,
    seed.riskFindings.map((row) => ({ ...row, currentDecisionId: null })),
  );
  inserted += await insertAbsent(
    transaction,
    riskFindingDecisions,
    seed.riskFindingDecisions,
  );
  await restoreUnsetPointers(transaction, riskFindings, seed.riskFindings);
  inserted += await insertAbsent(transaction, riceScores, seed.riceScores);
  return inserted;
}

type EvidenceTable =
  | typeof modelCalls
  | typeof assetAssessments
  | typeof assetCandidates
  | typeof assetCandidateDecisions
  | typeof riskAssessments
  | typeof riskFindings
  | typeof riskFindingDecisions
  | typeof riceScores
  | typeof drafts
  | typeof serviceCandidates
  | typeof requests
  | typeof taskCompletions
  | typeof reviewTasks
  | typeof auditEvents
  | typeof draftTurns
  | typeof requestContentRevisions
  | typeof clarificationRequests
  | typeof deliveryHandoffs
  | typeof requestResolutions;

async function insertAbsent(
  transaction: UpgradeTransaction,
  table: EvidenceTable,
  rows: Array<{ id: string }>,
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    const [present] = await transaction
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, row.id))
      .limit(1);
    if (present) continue;
    await transaction.insert(table).values(row);
    inserted += 1;
  }
  return inserted;
}

/** Seed decision pointers land only where the pointer is still unset, so
 * freshly inserted rows are completed and recorded live state survives. */
async function restoreUnsetPointers(
  transaction: UpgradeTransaction,
  table: typeof assetCandidates | typeof riskFindings,
  rows: Array<{ id: string; currentDecisionId?: string | null }>,
): Promise<void> {
  for (const row of rows) {
    if (!row.currentDecisionId) continue;
    await transaction
      .update(table)
      .set({ currentDecisionId: row.currentDecisionId })
      .where(and(eq(table.id, row.id), isNull(table.currentDecisionId)));
  }
}

/**
 * Draft turns are append-only, so a pre-correction conversation cannot gain
 * its reply links in place. For every seed answer whose question has no
 * recorded reply yet, append a versioned copy of the same transcript text
 * that carries the link. Old turns stay; the dialogue read model shows a
 * question's answer once because at most one turn may reply to it.
 */
async function appendReplyTurns(
  transaction: UpgradeTransaction,
  seed: SeedData,
): Promise<number> {
  let inserted = 0;
  for (const turn of seed.draftTurns) {
    const reply = (turn as { replyToTurnId?: string | null }).replyToTurnId;
    if (!reply) continue;
    const [wired] = await transaction
      .select({ id: draftTurns.id })
      .from(draftTurns)
      .where(eq(draftTurns.replyToTurnId, reply))
      .limit(1);
    if (wired) continue;
    const [next] = await transaction
      .select({ ordinal: sql<number>`coalesce(max(ordinal), -1) + 1` })
      .from(draftTurns)
      .where(eq(draftTurns.draftId, turn.draftId));
    await transaction.insert(draftTurns).values({
      ...turn,
      id: stableUuid("fixture-upgrade", (turn.fixtureKey as string) + ":u2"),
      fixtureKey: turn.fixtureKey + ":u2",
      ordinal: Number(next.ordinal),
    });
    inserted += 1;
  }
  return inserted;
}

/** Completed areas gain their seed evidence pin only where none exists, so
 * a pin recorded by a live review is preserved. */
async function pointCompletedReviews(
  transaction: UpgradeTransaction,
  seed: SeedData,
): Promise<void> {
  for (const task of seed.reviewTasks) {
    const pinned = (task as { completedAssessmentId?: string | null })
      .completedAssessmentId;
    if (!pinned) continue;
    await transaction
      .update(reviewTasks)
      .set({
        completedAssessmentId: pinned,
        rowVersion: sql.raw("row_version + 1"),
      })
      .where(
        and(
          eq(reviewTasks.id, task.id),
          isNull(reviewTasks.completedAssessmentId),
          eq(reviewTasks.state, "completed"),
          sql`exists (select 1 from requests where id = ${task.requestId} and current_revision_id is null)`,
        ),
      );
  }
}

/** Newly scored requests point at their seed RICE row only while unscored,
 * so a live human score saved on the old build stays authoritative. */
async function pointCurrentRiceScores(
  transaction: UpgradeTransaction,
  seed: SeedData,
): Promise<void> {
  for (const request of seed.requests) {
    if (!request.currentRiceScoreId) continue;
    await transaction
      .update(requests)
      .set({
        currentRiceScoreId: request.currentRiceScoreId,
        rowVersion: sql.raw("row_version + 1"),
      })
      .where(
        and(
          eq(requests.id, request.id),
          isNull(requests.currentRiceScoreId),
          isNull(requests.currentRevisionId),
        ),
      );
  }
}
