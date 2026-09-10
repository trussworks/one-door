import { asc, eq } from "drizzle-orm";
import { actors, organizations } from "../db/schema.ts";

import { withReadSnapshot } from "../workflow/shared.ts";

export async function metadata(context: {
  visitorId: string;
  actorId: string;
}) {
  return withReadSnapshot(async (tx) => {
    const [people, offices] = await Promise.all([
      tx
        .select({
          id: actors.id,
          displayName: actors.displayName,
          kind: actors.kind,
          capabilities: actors.capabilities,
        })
        .from(actors)
        .orderBy(asc(actors.displayName)),
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          kind: organizations.kind,
        })
        .from(organizations)
        .orderBy(asc(organizations.name)),
    ]);
    return {
      visitor: context,
      actors: people,
      organizations: offices,
      // For labeling the demo "me" queue; null on an unseeded database.
      // The shared tx keeps the lookup on this snapshot's connection.
      demoReviewPersona: await demoReviewPersona(demoReviewPersonaKey, tx),
    };
  });
}

export type Metadata = Awaited<ReturnType<typeof metadata>>;

/** The seeded persona whose example assignments back the demo "me" scope. */
export const demoReviewPersonaKey = "actor:elena-castellanos";

/**
 * The demo review persona's identity for scope and labeling. Null when the
 * fixture is absent (an unseeded database), which disables the demo scope
 * rather than failing the queue.
 */
export async function demoReviewPersona(
  fixtureKey = demoReviewPersonaKey,
  reader?: Parameters<typeof withReadSnapshot>[1],
): Promise<{ actorId: string; name: string } | null> {
  return withReadSnapshot(async (tx) => {
    const [row] = await tx
      .select({ actorId: actors.id, name: actors.displayName })
      .from(actors)
      .where(eq(actors.fixtureKey, fixtureKey))
      .limit(1);
    return row ?? null;
  }, reader);
}
