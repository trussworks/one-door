import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { visitors, wip } from "../db/schema.ts";
import { actingViews } from "../domain/constants.ts";
import { WorkflowError } from "./errors.ts";
import {
  isUniqueViolation,
  newId,
  nowIso,
  parseInput,
  requireVersion,
  requireVisitor,
  withDb,
  type VisitorContext,
} from "./shared.ts";

const scopeSchema = z.object({
  actingView: z.enum(actingViews),
  pageKey: z.string().min(1).max(64),
  subjectKey: z.string().min(1).max(200),
});
const saveSchema = scopeSchema.extend({
  payload: z.record(z.string().max(100), z.unknown()),
  expectedRowVersion: z.number().int().nonnegative(),
  route: z
    .string()
    .max(500)
    .regex(/^\/(?!\/)/)
    .optional(),
});

function scope(visitorId: string, data: z.infer<typeof scopeSchema>) {
  return and(
    eq(wip.visitorId, visitorId),
    eq(wip.actingView, data.actingView),
    eq(wip.pageKey, data.pageKey),
    eq(wip.subjectKey, data.subjectKey),
  );
}

export function loadWip(ctx: VisitorContext, input: unknown) {
  const data = parseInput(scopeSchema, input);
  return withDb(async (db) => {
    await requireVisitor(db, ctx.visitorId);
    const [row] = await db.select().from(wip).where(scope(ctx.visitorId, data));
    return row ?? null;
  });
}

export async function saveWip(ctx: VisitorContext, input: unknown) {
  const data = parseInput(saveSchema, input);
  try {
    return await withDb(async (db) =>
      db.transaction(async (tx) => {
        await requireVisitor(tx, ctx.visitorId);
        const predicate = scope(ctx.visitorId, data);
        const [existing] = await tx
          .select()
          .from(wip)
          .where(predicate)
          .for("update");
        requireVersion(data.expectedRowVersion, existing?.rowVersion ?? 0);
        const values = {
          payload: data.payload,
          savedAt: nowIso(),
          rowVersion: data.expectedRowVersion + 1,
        };
        const [saved] = existing
          ? await tx.update(wip).set(values).where(predicate).returning()
          : await tx
              .insert(wip)
              .values({
                id: newId(),
                visitorId: ctx.visitorId,
                actingView: data.actingView,
                pageKey: data.pageKey,
                subjectKey: data.subjectKey,
                ...values,
              })
              .returning();
        if (data.route)
          await tx
            .update(visitors)
            .set({ lastMeaningfulRoute: data.route })
            .where(eq(visitors.id, ctx.visitorId));
        return saved;
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error, "wip_scope_unique"))
      throw new WorkflowError("VERSION_CONFLICT");
    throw error;
  }
}
