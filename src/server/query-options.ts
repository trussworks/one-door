import { parseSort, queueHeadingKeys } from "../domain/sorting.ts";
import type { QueueOptions } from "./queue.ts";
import type { ReportOptions } from "./reports.ts";

export function pageNumber(value: string | null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}
/**
 * "unassigned" is a scope of its own: no coordinator on the request,
 * regardless of area task assignments. It must not fall through to the
 * by-actor branch, whose value is validated as a UUID.
 */
function reviewerScope(
  reviewer: string,
  actorId: string,
): Partial<QueueOptions> {
  if (reviewer === "unassigned") return { unassigned: true };
  if (reviewer === "all") return {};
  if (reviewer === "me")
    // The demo review persona's seeded examples join the session's own
    // assignments; explicit by-actor scopes stay exact.
    return { assigneeActorId: actorId, demoExamples: true };
  return { assigneeActorId: reviewer };
}

export function queueOptions(
  query: URLSearchParams,
  actorId: string,
): QueueOptions {
  return {
    ...reviewerScope(query.get("reviewer") ?? "me", actorId),
    ...(query.get("phase") && {
      phase: query.get("phase") as QueueOptions["phase"],
    }),
    ...(query.get("action") && {
      actionNeeded: query.get("action") as QueueOptions["actionNeeded"],
    }),
    ...(query.get("origin") && {
      origin: query.get("origin") as QueueOptions["origin"],
    }),
    ...(query.get("scored") && { scored: query.get("scored") === "yes" }),
    ...(query.get("risk") && {
      risk: query.get("risk") as QueueOptions["risk"],
    }),
    sort: (query.get("order") || "waiting") as QueueOptions["sort"],
    ...headingOption(query),
    page: pageNumber(query.get("page")),
  };
}
/** A clicked heading (sort + dir) outranks the order select while present. */
function headingOption(query: URLSearchParams): Pick<QueueOptions, "heading"> {
  const state = parseSort(query, queueHeadingKeys);
  if (!state) return {};
  return {
    heading: {
      key: state.key,
      direction: state.direction,
    },
  };
}

export function reportOptions(query: URLSearchParams): ReportOptions {
  return {
    ...(query.get("dataset") && {
      dataset: query.get("dataset") as ReportOptions["dataset"],
    }),
    ...(query.get("from") && { fromDate: query.get("from")! }),
    ...(query.get("to") && { toDate: query.get("to")! }),
  };
}
