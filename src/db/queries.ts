import { asc, count, eq, sql } from "drizzle-orm";

import { createDatabase } from "./client.ts";
import { actors, organizations, requests, riceScores } from "./schema.ts";

export async function listRequests(requestedPage: number, pageSize = 10) {
  const { db, sql: client } = createDatabase();

  try {
    const [{ total }] = await db.select({ total: count() }).from(requests);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(1, requestedPage), totalPages);
    const daysInStage = sql
      .raw("GREATEST(0, CURRENT_DATE - requests.updated_at::date)")
      .mapWith(Number);
    const items = await db
      .select({
        id: requests.id,
        displayId: requests.displayId,
        title: requests.title,
        stage: requests.stage,
        requesterName: actors.displayName,
        organization: organizations.name,
        riceScore: riceScores.score,
        daysInStage,
      })
      .from(requests)
      .innerJoin(actors, eq(requests.requesterActorId, actors.id))
      .innerJoin(
        organizations,
        eq(requests.requestingOrganizationId, organizations.id),
      )
      .leftJoin(riceScores, eq(requests.currentRiceScoreId, riceScores.id))
      .orderBy(asc(requests.updatedAt), asc(requests.title))
      .limit(pageSize)
      .offset((currentPage - 1) * pageSize);

    return { currentPage, items, total, totalPages };
  } finally {
    await client.end();
  }
}
