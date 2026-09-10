import { asc, eq } from "drizzle-orm";
import {
  catalogItems,
  inventoryConflicts,
  inventorySourceRecords,
  inventorySources,
} from "../db/schema.ts";
import { WorkflowError } from "../workflow/errors.ts";
import { parseInput, uuidSchema, withDb } from "../workflow/shared.ts";

export function inventoryOverview() {
  return withDb(async (db) => {
    const [items, sources, conflicts] = await Promise.all([
      db.select().from(catalogItems).orderBy(asc(catalogItems.name)),
      db.select().from(inventorySources).orderBy(asc(inventorySources.name)),
      db.select().from(inventoryConflicts),
    ]);
    return { items, sources, conflicts };
  });
}

export function sourceObservation(id: string) {
  const recordId = parseInput(uuidSchema, id);
  return withDb(async (db) => {
    const [row] = await db
      .select()
      .from(inventorySourceRecords)
      .where(eq(inventorySourceRecords.id, recordId));
    if (!row) throw new WorkflowError("NOT_FOUND", "source observation");
    return row;
  });
}

export type InventoryOverview = Awaited<ReturnType<typeof inventoryOverview>>;

export function catalogView() {
  return withDb((db) =>
    db.select().from(catalogItems).orderBy(asc(catalogItems.name)),
  );
}
