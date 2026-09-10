import { and, eq, inArray } from "drizzle-orm";
import { modelCalls, wip } from "../db/schema.ts";
import { defaultWaitThresholds } from "../domain/business-days.ts";
import { WorkflowError } from "../workflow/errors.ts";
import { currentJobWithFallback } from "../workflow/intake.ts";
import { listOwnWork } from "../workflow/requester.ts";
import type { VisitorContext } from "../workflow/shared.ts";
import { withReadSnapshot, type Tx } from "../workflow/shared.ts";
import { enrichedRequests, phaseFields } from "./read-model.ts";

/**
 * Own drafts and requests, each request carrying its derived phase. The
 * listing and the enrichment read one shared snapshot.
 */
export async function myWork(context: VisitorContext) {
  return withReadSnapshot(async (tx) => {
    const work = await listOwnWork(context, tx);
    const saved = await tx
      .select()
      .from(wip)
      .where(
        and(
          eq(wip.visitorId, context.visitorId),
          inArray(wip.pageKey, ["start-request", "requester-requirements"]),
          eq(wip.actingView, "requester"),
        ),
      );
    // ponytail: reuse per-draft identity reads; batch if large personal draft lists become slow.
    const displayedDrafts = await Promise.all(
      work.drafts.map((draft) => draftForList(tx, draft, saved)),
    );
    const ids = work.requests.map((row) => row.requestId);
    const enriched = await enrichedRequests(defaultWaitThresholds, ids, tx);
    const byId = new Map(enriched.map((row) => [row.requestId, row]));
    return {
      drafts: displayedDrafts,
      startedDrafts: saved
        .filter(
          (row) =>
            row.pageKey === "start-request" &&
            typeof row.payload.rawNeed === "string" &&
            row.payload.rawNeed.trim() &&
            !row.payload.draftId,
        )
        .map((row) => ({
          route: "/new?start=" + encodeURIComponent(row.subjectKey),
          title: String(row.payload.rawNeed),
          savedAt: row.savedAt,
        })),
      requests: work.requests.map((row) => {
        const facts = byId.get(row.requestId);
        if (!facts) throw new WorkflowError("NOT_FOUND", "request status");
        return {
          ...row,
          ...phaseFields(facts),
          answerNeeded:
            row.answerNeeded ||
            facts.inputRequests.some(
              (input) =>
                input.audience === "requester" && input.state === "open",
            ),
          priorityPending: facts.priorityPending,
        };
      }),
      thresholds: defaultWaitThresholds,
    };
  });
}

async function draftForList(
  tx: Tx,
  draft: Awaited<ReturnType<typeof listOwnWork>>["drafts"][number],
  saved: Array<typeof wip.$inferSelect>,
) {
  // The workspace follows logical identity, not newest creation time after A → B → A.
  const found = await currentJobWithFallback(
    tx,
    draft.draftId,
    "intake_interpret",
  );
  const scope = draft.draftId + ":" + (found.job?.id ?? "manual");
  const work = saved.find(
    (row) =>
      row.pageKey === "requester-requirements" && row.subjectKey === scope,
  );
  const title = [
    work?.payload.title,
    await preparedDraftTitle(tx, found),
    draft.content.title,
    draft.rawNeed,
  ].find((value) => typeof value === "string" && value.trim());
  return {
    ...draft,
    displayTitle: typeof title === "string" ? title : "New request",
    workSavedAt: work?.savedAt ?? draft.updatedAt,
  };
}

async function preparedDraftTitle(
  tx: Tx,
  found: Awaited<ReturnType<typeof currentJobWithFallback>>,
) {
  const job = found.job;
  if (!found.current || job?.status !== "succeeded" || !job.currentModelCallId)
    return undefined;
  const [call] = await tx
    .select({ output: modelCalls.validatedOutput })
    .from(modelCalls)
    .where(eq(modelCalls.id, job.currentModelCallId))
    .limit(1);
  const proposal = call?.output as
    { content?: { title?: unknown } } | undefined;
  return proposal?.content?.title;
}

export type MyWork = Awaited<ReturnType<typeof myWork>>;
