import { and, eq, inArray } from "drizzle-orm";

import type { createDatabase } from "../db/client.ts";
import {
  clarificationRequests,
  deliveryHandoffs,
  requestContentRevisions,
  requestResolutions,
  requests,
} from "../db/schema.ts";
import { buildSeedData } from "./build.ts";
import { stableUuid } from "./stable.ts";

type Db = ReturnType<typeof createDatabase>["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SeedData = ReturnType<typeof buildSeedData>;
type Handoff = SeedData["deliveryHandoffs"][number];
type Resolution = SeedData["requestResolutions"][number];
type Clarification = SeedData["clarificationRequests"][number];

/**
 * Re-materialize each seeded lifecycle example at its request's current
 * generation. A live action advances a fixture request's generation and strands
 * the seeded gen-1 evidence, so a delivery, resolved, or waiting example would
 * fall back to approved after the first reset. Each handoff, resolution, or
 * clarification is inserted at the request's current generation, stamped with a
 * generation-specific key so it never collides with the seeded row. The insert
 * is guarded on the (request, generation) key, so a live human handoff or
 * resolution already recorded at that generation is preserved and the live
 * evidence at older generations stays as history.
 */
export async function ensureLifecycleEvidence(
  tx: Tx,
  seed: SeedData,
): Promise<number> {
  const ids = new Set<string>();
  for (const row of seed.deliveryHandoffs) ids.add(row.requestId);
  for (const row of seed.requestResolutions) ids.add(row.requestId);
  for (const row of seed.clarificationRequests) ids.add(row.requestId);
  const generation = await currentGenerations(tx, [...ids]);
  return (
    (await ensureRevisions(tx, seed)) +
    (await ensureHandoffs(tx, seed, generation)) +
    (await ensureResolutions(tx, seed, generation)) +
    (await ensureClarifications(tx, seed, generation))
  );
}

// Revisions are generation-independent and referenced by clarifications.
async function ensureRevisions(tx: Tx, seed: SeedData): Promise<number> {
  let inserted = 0;
  for (const revision of seed.requestContentRevisions) {
    if (await hasId(tx, requestContentRevisions, revision.id)) continue;
    await tx.insert(requestContentRevisions).values(revision);
    inserted += 1;
  }
  return inserted;
}

async function ensureHandoffs(
  tx: Tx,
  seed: SeedData,
  generation: Map<string, number>,
): Promise<number> {
  let inserted = 0;
  for (const row of seed.deliveryHandoffs) {
    const gen = generation.get(row.requestId);
    if (gen === undefined || (await handoffAt(tx, row.requestId, gen)))
      continue;
    await tx.insert(deliveryHandoffs).values(stampHandoff(row, gen));
    inserted += 1;
  }
  return inserted;
}

async function ensureResolutions(
  tx: Tx,
  seed: SeedData,
  generation: Map<string, number>,
): Promise<number> {
  let inserted = 0;
  for (const row of seed.requestResolutions) {
    const gen = generation.get(row.requestId);
    if (gen === undefined || (await resolutionAt(tx, row.requestId, gen)))
      continue;
    await tx.insert(requestResolutions).values(stampResolution(row, gen));
    inserted += 1;
  }
  return inserted;
}

async function ensureClarifications(
  tx: Tx,
  seed: SeedData,
  generation: Map<string, number>,
): Promise<number> {
  let inserted = 0;
  for (const row of seed.clarificationRequests) {
    const gen = generation.get(row.requestId);
    if (gen === undefined || (await clarificationAt(tx, row.requestId, gen)))
      continue;
    await tx.insert(clarificationRequests).values(stampClarification(row, gen));
    inserted += 1;
  }
  return inserted;
}

async function currentGenerations(
  tx: Tx,
  ids: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const rows = await tx
    .select({ id: requests.id, generation: requests.fixtureGeneration })
    .from(requests)
    .where(inArray(requests.id, ids));
  for (const row of rows) map.set(row.id, row.generation);
  return map;
}

async function hasId(
  tx: Tx,
  table: typeof requestContentRevisions,
  id: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return Boolean(row);
}

async function handoffAt(tx: Tx, requestId: string, gen: number) {
  const [row] = await tx
    .select({ id: deliveryHandoffs.id })
    .from(deliveryHandoffs)
    .where(
      and(
        eq(deliveryHandoffs.requestId, requestId),
        eq(deliveryHandoffs.requestGeneration, gen),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function resolutionAt(tx: Tx, requestId: string, gen: number) {
  const [row] = await tx
    .select({ id: requestResolutions.id })
    .from(requestResolutions)
    .where(
      and(
        eq(requestResolutions.requestId, requestId),
        eq(requestResolutions.requestGeneration, gen),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function clarificationAt(tx: Tx, requestId: string, gen: number) {
  const [row] = await tx
    .select({ id: clarificationRequests.id })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.requestId, requestId),
        eq(clarificationRequests.requestGeneration, gen),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function suffix(gen: number): string {
  return ":g" + gen;
}

function stampHandoff(row: Handoff, gen: number): Handoff {
  if (gen === row.requestGeneration) return row;
  return {
    ...row,
    id: stableUuid("lifecycle-handoff", row.fixtureKey + ":" + gen),
    fixtureKey: (row.fixtureKey ?? "") + suffix(gen),
    retryKey: row.retryKey + suffix(gen),
    requestGeneration: gen,
  };
}

function stampResolution(row: Resolution, gen: number): Resolution {
  if (gen === row.requestGeneration) return row;
  return {
    ...row,
    id: stableUuid("lifecycle-resolution", row.fixtureKey + ":" + gen),
    fixtureKey: (row.fixtureKey ?? "") + suffix(gen),
    requestGeneration: gen,
  };
}

function stampClarification(row: Clarification, gen: number): Clarification {
  if (gen === row.requestGeneration) return row;
  return {
    ...row,
    id: stableUuid("lifecycle-clarification", row.fixtureKey + ":" + gen),
    fixtureKey: (row.fixtureKey ?? "") + suffix(gen),
    requestGeneration: gen,
  };
}
