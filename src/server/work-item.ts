import { asc, eq, sql } from "drizzle-orm";
import {
  externalWorkItems,
  requests,
  requestWorkItemLinks,
  workSystems,
} from "../db/schema.ts";
import {
  parseInput,
  uuidSchema,
  withReadSnapshot,
} from "../workflow/shared.ts";
import { WorkflowError } from "../workflow/errors.ts";
import { deriveWorkItemHealth } from "../workflow/delivery.ts";

export function workItemView(id: string) {
  const workItemId = parseInput(uuidSchema, id);
  return withReadSnapshot(async (db) => {
    const [result] = await db
      .select({
        item: externalWorkItems,
        freshness: workSystems.expectedFreshnessHours,
      })
      .from(externalWorkItems)
      .innerJoin(workSystems, eq(workSystems.system, externalWorkItems.system))
      .where(eq(externalWorkItems.id, workItemId));
    if (!result) throw new WorkflowError("NOT_FOUND", "work item");
    const item = {
      ...result.item,
      derivedHealth: deriveWorkItemHealth(
        result.item,
        result.freshness,
        Date.now(),
      ),
    };
    const linked = await db
      .select({
        requestId: requests.id,
        displayId: requests.displayId,
        title: requests.title,
        relationship: requestWorkItemLinks.relationship,
        requestGeneration: requestWorkItemLinks.requestGeneration,
        current: sql<boolean>`${requestWorkItemLinks.fixtureKey} IS NOT NULL OR ${requestWorkItemLinks.requestGeneration} = ${requests.fixtureGeneration}`,
      })
      .from(requestWorkItemLinks)
      .innerJoin(requests, eq(requests.id, requestWorkItemLinks.requestId))
      .where(eq(requestWorkItemLinks.workItemId, workItemId))
      .orderBy(asc(requests.displayId));
    return {
      item,
      requests: linked.filter((link) => link.current),
      historicalRequests: linked.filter((link) => !link.current),
    };
  });
}
export type WorkItemView = Awaited<ReturnType<typeof workItemView>>;

export function workItemOptions() {
  return withReadSnapshot((db) =>
    db
      .select({
        workItemId: externalWorkItems.id,
        externalId: externalWorkItems.externalId,
        title: externalWorkItems.title,
        system: externalWorkItems.system,
      })
      .from(externalWorkItems)
      .orderBy(asc(externalWorkItems.title)),
  );
}
