import { z } from "zod";
import { actors } from "../db/schema.ts";
import { defaultWaitThresholds } from "../domain/business-days.ts";
import { riskSeverities } from "../domain/constants.ts";
import { paginate } from "../domain/pagination.ts";
import {
  compareValues,
  queueHeadingKeys,
  type SortValue,
} from "../domain/sorting.ts";
import { actionLabels, phaseLabels } from "../ui/status-labels.ts";
import {
  parseInput,
  uuidSchema,
  withReadSnapshot,
} from "../workflow/shared.ts";
import { demoReviewPersona } from "./metadata.ts";
import {
  actionNeededTokens,
  enrichedRequests,
  requestPhaseTokens,
  severityRank,
  thresholdsSchema,
  type EnrichedRequestRow,
  type RiskFacts,
} from "./read-model.ts";

/**
 * Reviewer queue with filters, sorting, and pagination. Phase and action are
 * derived per row, so filtering happens in memory; fine at pilot volumes,
 * revisit with a materialized phase column if requests reach the thousands.
 */
export async function queueView(optionsInput: unknown = {}) {
  const options = parseInput(queueOptionsSchema, optionsInput ?? {});
  const thresholds = options.thresholds ?? defaultWaitThresholds;
  const demoActorId = options.demoExamples
    ? ((await demoReviewPersona())?.actorId ?? null)
    : null;
  const rows = (await enrichedRequests(thresholds))
    .filter(queueFilter(options, demoActorId))
    .sort(await queueSortOrder(options));
  return {
    ...paginate(rows, options.page ?? 1),
    thresholds,
    // Ranking scores whose Reach basis differs needs a warning; the flag
    // covers the whole filtered queue, not only the visible page.
    mixedReachBasis: mixedReachBasis(rows),
  };
}

export function requestQueue(): Promise<EnrichedRequestRow[]> {
  return enrichedRequests();
}

const queueOptionsSchema = z.object({
  phase: z.enum(requestPhaseTokens).optional(),
  actionNeeded: z.enum(actionNeededTokens).optional(),
  assigneeActorId: uuidSchema.optional(),
  /** "Me" scope only: seeded examples assigned to the demo review persona
   * count as mine, so a fresh demo session has a populated queue. */
  demoExamples: z.boolean().optional(),
  unassigned: z.boolean().optional(),
  scored: z.boolean().optional(),
  origin: z.enum(["live", "seed"]).optional(),
  risk: z.enum([...riskSeverities, "unassessed", "information_gap"]).optional(),
  sort: z.enum(["waiting", "score", "risk", "oldest"]).optional(),
  /** A heading sort overrides `sort` and orders the whole filtered set. */
  heading: z
    .object({
      key: z.enum(queueHeadingKeys),
      direction: z.enum(["asc", "desc"]),
    })
    .optional(),
  page: z.number().int().min(1).optional(),
  thresholds: thresholdsSchema.optional(),
});

export type QueueOptions = z.infer<typeof queueOptionsSchema>;

function matchesRequestFields(
  row: EnrichedRequestRow,
  options: QueueOptions,
): boolean {
  if (options.phase && row.phase !== options.phase) return false;
  if (options.actionNeeded && row.actionNeeded !== options.actionNeeded)
    return false;
  if (options.origin && row.origin !== options.origin) return false;
  if (options.scored !== undefined && (row.score !== null) !== options.scored)
    return false;
  return true;
}

function matchesAssignment(
  row: EnrichedRequestRow,
  options: QueueOptions,
  demoActorId: string | null,
): boolean {
  // Unassigned means no coordinator on the request; an area task assignee
  // does not make the request assigned.
  if (options.unassigned && row.coordinatorActorId !== null) return false;
  if (!options.assigneeActorId) return true;
  if (assignedTo(row, options.assigneeActorId)) return true;
  // Demo review identity: seeded examples assigned to the demo persona are
  // part of "me", but only fixture rows — a live request someone assigned
  // to the persona never sweeps into every visitor's queue.
  return Boolean(
    demoActorId && row.fixtureKey !== null && assignedTo(row, demoActorId),
  );
}

function assignedTo(row: EnrichedRequestRow, actorId: string): boolean {
  return (
    row.coordinatorActorId === actorId ||
    row.reviewTasks.some((task) => task.assigneeActorId === actorId) ||
    row.inputRequests.some(
      (input) =>
        (input.audience === "internal" && input.assigneeActorId === actorId) ||
        (input.askedByActorId === actorId && input.latestResponse !== null),
    )
  );
}

/**
 * Severity values filter at-or-above among assessed rows only; "unassessed"
 * collects every row without a usable current assessment — never prepared,
 * preparing, failed, or corpus-stale — so obsolete results cannot pass a
 * severity filter as if current.
 */
function matchesRisk(row: EnrichedRequestRow, risk: QueueOptions["risk"]) {
  if (!risk) return true;
  if (risk === "unassessed") return row.risk.status !== "assessed";
  // Unresolved information gaps on a current assessment: distinct from
  // missing or stale preparation, which "unassessed" collects.
  if (risk === "information_gap")
    return row.risk.status === "assessed" && row.risk.missingInformation > 0;
  return (
    row.risk.status === "assessed" &&
    row.risk.highestSeverity !== null &&
    severityRank[row.risk.highestSeverity] >= severityRank[risk]
  );
}

function queueFilter(options: QueueOptions, demoActorId: string | null) {
  return (row: EnrichedRequestRow): boolean =>
    matchesRequestFields(row, options) &&
    matchesAssignment(row, options, demoActorId) &&
    matchesRisk(row, options.risk);
}

/** Assessed rows rank by severity; every non-current state ranks below. */
function riskWeight(risk: RiskFacts): number {
  if (risk.status === "assessed")
    return 40 + (risk.highestSeverity ? severityRank[risk.highestSeverity] : 0);
  if (risk.status === "stale") return 30;
  if (risk.status === "failed") return 20;
  if (risk.status === "preparing") return 10;
  return 0;
}

function scoreValue(row: EnrichedRequestRow): number | null {
  return row.score === null ? null : Number(row.score);
}

function queueOrder(sort: QueueOptions["sort"]) {
  return (a: EnrichedRequestRow, b: EnrichedRequestRow): number => {
    if (sort === "waiting")
      return (
        a.phaseSince.localeCompare(b.phaseSince) ||
        a.requestId.localeCompare(b.requestId)
      );
    if (sort === "risk") {
      return (
        riskWeight(b.risk) - riskWeight(a.risk) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.requestId.localeCompare(b.requestId)
      );
    }
    if (sort === "score") {
      return (
        compareValues(scoreValue(a), scoreValue(b), "desc") ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.requestId.localeCompare(b.requestId)
      );
    }
    return (
      a.createdAt.localeCompare(b.createdAt) ||
      a.requestId.localeCompare(b.requestId)
    );
  };
}

/**
 * Compound columns compare the values a reader sees, in display order;
 * risk keeps its meaningful severity ranking rather than label text.
 */
function headingValues(
  row: EnrichedRequestRow,
  key: (typeof queueHeadingKeys)[number],
  coordinators: Map<string, string>,
): SortValue[] {
  if (key === "title") return [row.title];
  if (key === "organization") return [row.requesterName, row.organizationName];
  if (key === "action")
    return [actionLabels[row.actionNeeded], phaseLabels[row.phase]];
  if (key === "coordinator")
    return [
      row.coordinatorActorId
        ? (coordinators.get(row.coordinatorActorId) ?? null)
        : null,
    ];
  const numeric = {
    waiting: -Date.parse(row.phaseSince),
    submitted: Date.parse(row.createdAt),
    risk: riskWeight(row.risk),
    score: scoreValue(row),
  };
  return [numeric[key]];
}

function headingOrder(
  heading: NonNullable<QueueOptions["heading"]>,
  coordinators: Map<string, string>,
) {
  return (a: EnrichedRequestRow, b: EnrichedRequestRow): number => {
    const left = headingValues(a, heading.key, coordinators);
    const right = headingValues(b, heading.key, coordinators);
    for (const [index, value] of left.entries()) {
      const order = compareValues(value, right[index], heading.direction);
      if (order !== 0) return order;
    }
    return a.requestId.localeCompare(b.requestId);
  };
}

/** Actor display names, loaded only when a heading sorts by coordinator. */
async function coordinatorNames(
  heading: QueueOptions["heading"],
): Promise<Map<string, string>> {
  if (heading?.key !== "coordinator") return new Map();
  const rows = await withReadSnapshot((tx) =>
    tx.select({ id: actors.id, name: actors.displayName }).from(actors),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** A heading sort outranks the order select for the whole filtered set. */
async function queueSortOrder(options: QueueOptions) {
  if (options.heading)
    return headingOrder(
      options.heading,
      await coordinatorNames(options.heading),
    );
  return queueOrder(options.sort ?? "oldest");
}

function mixedReachBasis(rows: EnrichedRequestRow[]): boolean {
  const bases = new Set<string>();
  for (const row of rows)
    if (row.score !== null)
      bases.add(`${row.reachUnit ?? ""}|${row.reachPeriod ?? ""}`);
  return bases.size > 1;
}

export type QueueView = Awaited<ReturnType<typeof queueView>>;

export type QueueRow = Awaited<ReturnType<typeof requestQueue>>[number];
