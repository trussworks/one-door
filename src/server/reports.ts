import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { getQuotaStatus } from "../models/jobs.ts";
import {
  parseInput,
  withDb,
  withReadSnapshot,
  type Tx,
  type VisitorContext,
} from "../workflow/shared.ts";

export async function reportView(
  context: VisitorContext,
  options: ReportOptions = {},
) {
  const [rows, quota, report] = await Promise.all([
    withDb((db) =>
      db.execute(sql`
      SELECT task_type, origin, count(*)::int AS responses,
        count(*) FILTER (WHERE rating >= 4)::int AS satisfied
      FROM task_completions GROUP BY task_type, origin ORDER BY task_type, origin
    `),
    ),
    getQuotaStatus(context.visitorId),
    reportMetrics(options),
  ]);
  return { satisfaction: rows, quota, report };
}

/**
 * Satisfaction counts immutable ratings by their own origin and date.
 * Request-event metrics use the request's origin and generation; events from
 * before a fixture reset stay historical.
 */
export async function reportMetrics(optionsInput: unknown = {}) {
  const options = parseInput(reportOptionsSchema, optionsInput ?? {});
  const scope = scopeOf(options);
  return withReadSnapshot(async (db) => {
    const [
      requester,
      reviewer,
      resolutions,
      firstReviews,
      submissions,
      completedReviews,
    ] = await Promise.all([
      satisfactionMetric(
        db,
        scope,
        "requester_submission",
        requesterSatisfactionTarget,
      ),
      satisfactionMetric(db, scope, "contributor_first_review", null),
      resolutionCounts(db, scope),
      firstReviewRecords(db, scope),
      requestEventCount(db, scope, sql`r.created_at`, sql`TRUE`),
      requestEventCount(
        db,
        scope,
        sql`r.first_review_completed_at`,
        sql`r.first_review_completed_at IS NOT NULL`,
      ),
    ]);
    const fulfilled = mergeCounts(
      resolutions.fulfilled_reuse,
      resolutions.fulfilled_new,
      resolutions.fulfilled_mixed,
    );
    return {
      dataset: scope.dataset,
      fromDate: options.fromDate ?? null,
      toDate: options.toDate ?? null,
      requesterSatisfaction: requester,
      reviewerSatisfaction: reviewer,
      reuse: {
        fulfilledTotal: fulfilled.count,
        reuseOnly: resolutions.fulfilled_reuse.count,
        mixed: resolutions.fulfilled_mixed.count,
        newWork: resolutions.fulfilled_new.count,
        reuseRate:
          fulfilled.count === 0
            ? null
            : resolutions.fulfilled_reuse.count / fulfilled.count,
        fulfilledRequestIds: fulfilled.requestIds,
      },
      closures: {
        count: resolutions.closed_without_fulfillment.count,
        requestIds: resolutions.closed_without_fulfillment.requestIds,
      },
      timeToFirstReview: {
        startEvent: "request_submitted",
        endEvent: "first_saved_review_decision",
        sampleCount: firstReviews.length,
        medianSeconds: median(firstReviews.map((record) => record.seconds)),
        records: firstReviews,
      },
      volume: {
        submissions,
        firstReviewsCompleted: completedReviews,
        fulfilled,
        closedWithoutFulfillment: {
          count: resolutions.closed_without_fulfillment.count,
          requestIds: resolutions.closed_without_fulfillment.requestIds,
        },
      },
    };
  });
}

export const requesterSatisfactionTarget = 0.9;

const reportOptionsSchema = z
  .object({
    dataset: z.enum(["live", "seed"]).optional(),
    fromDate: z.iso.date().optional(),
    toDate: z.iso.date().optional(),
  })
  .refine(
    (options) =>
      !options.fromDate ||
      !options.toDate ||
      options.fromDate <= options.toDate,
    {
      message: "The start date must be on or before the end date",
      path: ["fromDate"],
    },
  );

export type ReportOptions = z.infer<typeof reportOptionsSchema>;

interface ReportScope {
  dataset: "live" | "seed";
  completionOrigin: "live" | "fixture";
  fromTs: string | null;
  toTs: string | null;
}

const dayMs = 86_400_000;

function scopeOf(options: ReportOptions): ReportScope {
  const dataset = options.dataset ?? "live";
  return {
    dataset,
    completionOrigin: dataset === "live" ? "live" : "fixture",
    fromTs: options.fromDate ? `${options.fromDate}T00:00:00.000Z` : null,
    toTs: options.toDate
      ? new Date(
          Date.parse(`${options.toDate}T00:00:00.000Z`) + dayMs,
        ).toISOString()
      : null,
  };
}

/** Half-open UTC day range: from 00:00 on fromDate up to 00:00 after toDate. */
function inRange(scope: ReportScope, column: SQL): SQL {
  const parts: SQL[] = [sql`TRUE`];
  if (scope.fromTs) parts.push(sql`${column} >= ${scope.fromTs}::timestamptz`);
  if (scope.toTs) parts.push(sql`${column} < ${scope.toTs}::timestamptz`);
  return sql.join(parts, sql` AND `);
}

function requestOrigin(scope: ReportScope): SQL {
  return scope.dataset === "live"
    ? sql`r.fixture_key IS NULL`
    : sql`r.fixture_key IS NOT NULL`;
}

export interface SatisfactionRecord {
  completionId: string;
  requestId: string;
  requestGeneration: number;
  rating: number;
  completedAt: string;
}

interface SatisfactionMetric {
  responses: number;
  satisfied: number;
  rate: number | null;
  target: number | null;
  records: SatisfactionRecord[];
}

/**
 * A survey response is immutable measurement evidence: once recorded, it
 * counts for its origin and date forever. A fixture reset that advances a
 * request's generation never removes a live response from these totals, and
 * each record keeps the generation it was given in so drilldowns stay
 * unambiguous when one fixture request spans several generations.
 */
async function satisfactionMetric(
  db: Tx,
  scope: ReportScope,
  taskType: "requester_submission" | "contributor_first_review",
  target: number | null,
): Promise<SatisfactionMetric> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS responses,
      count(*) FILTER (WHERE tc.rating >= 4)::int AS satisfied,
      coalesce(json_agg(json_build_object(
        'completionId', tc.id, 'requestId', tc.request_id,
        'requestGeneration', tc.request_generation,
        'rating', tc.rating, 'completedAt', tc.completed_at
      ) ORDER BY tc.completed_at, tc.id), '[]'::json) AS records
    FROM task_completions tc
    WHERE tc.task_type = ${taskType}
      AND tc.origin = ${scope.completionOrigin}
      AND ${inRange(scope, sql`tc.completed_at`)}
  `)) as Array<{
    responses: number;
    satisfied: number;
    records: SatisfactionRecord[];
  }>;
  const row = rows[0] ?? { responses: 0, satisfied: 0, records: [] };
  return {
    responses: row.responses,
    satisfied: row.satisfied,
    rate: row.responses === 0 ? null : row.satisfied / row.responses,
    target,
    records: row.records,
  };
}

interface EventCount {
  count: number;
  requestIds: string[];
}

async function requestEventCount(
  db: Tx,
  scope: ReportScope,
  column: SQL,
  extra: SQL,
): Promise<EventCount> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS count,
      coalesce(array_agg(r.id::text ORDER BY ${column}, r.id), '{}') AS ids
    FROM requests r
    WHERE ${requestOrigin(scope)} AND ${extra}
      AND ${inRange(scope, column)}
  `)) as Array<{ count: number; ids: string[] }>;
  const row = rows[0] ?? { count: 0, ids: [] };
  return { count: row.count, requestIds: row.ids };
}

interface ResolutionBuckets {
  fulfilled_reuse: EventCount;
  fulfilled_new: EventCount;
  fulfilled_mixed: EventCount;
  closed_without_fulfillment: EventCount;
}

async function resolutionCounts(
  db: Tx,
  scope: ReportScope,
): Promise<ResolutionBuckets> {
  const rows = (await db.execute(sql`
    SELECT res.outcome AS outcome, count(*)::int AS count,
      coalesce(array_agg(r.id::text ORDER BY res.created_at, r.id), '{}') AS ids
    FROM request_resolutions res
    JOIN requests r ON r.id = res.request_id
      AND res.request_generation = r.fixture_generation
    WHERE ${requestOrigin(scope)} AND ${inRange(scope, sql`res.created_at`)}
    GROUP BY res.outcome
  `)) as Array<{ outcome: string; count: number; ids: string[] }>;
  const empty = (): EventCount => ({ count: 0, requestIds: [] });
  const buckets: ResolutionBuckets = {
    fulfilled_reuse: empty(),
    fulfilled_new: empty(),
    fulfilled_mixed: empty(),
    closed_without_fulfillment: empty(),
  };
  for (const row of rows) {
    if (row.outcome in buckets)
      buckets[row.outcome as keyof ResolutionBuckets] = {
        count: row.count,
        requestIds: row.ids,
      };
  }
  return buckets;
}

interface FirstReviewRecord {
  requestId: string;
  displayId: string;
  submittedAt: string;
  firstDecisionAt: string;
  seconds: number;
}

/**
 * A saved human review decision is an asset-candidate decision, a risk
 * finding decision, a saved RICE score, or an explicit risk or asset
 * outcome recording (audited area completions, generation-bound through
 * their payloads; outcome events written before the payload carried a
 * generation stay uncounted rather than guessed). Every decision row
 * carries its
 * own origin and generation (0010): fixture-origin decisions are the seeded
 * baseline and stay valid at any generation, while live decisions count
 * only in the generation they were made in, uniformly across all three
 * decision kinds.
 */
async function firstReviewRecords(
  db: Tx,
  scope: ReportScope,
): Promise<FirstReviewRecord[]> {
  const decisionCurrent = sql`(d.origin = 'fixture' OR d.request_generation = r.fixture_generation)`;
  return (await db.execute(sql`
    WITH decision_events AS (
      SELECT r.id AS request_id, d.created_at
      FROM asset_candidate_decisions d
      JOIN asset_candidates c ON c.id = d.candidate_id
      JOIN asset_assessments a ON a.id = c.assessment_id
      JOIN requests r ON r.source_draft_id = a.draft_id
      WHERE ${requestOrigin(scope)} AND ${decisionCurrent}
      UNION ALL
      SELECT r.id, d.created_at
      FROM risk_finding_decisions d
      JOIN risk_findings f ON f.id = d.finding_id
      JOIN risk_assessments a ON a.id = f.assessment_id
      JOIN requests r ON r.source_draft_id = a.draft_id
      WHERE ${requestOrigin(scope)} AND ${decisionCurrent}
      UNION ALL
      SELECT d.request_id, d.created_at
      FROM rice_scores d
      JOIN requests r ON r.id = d.request_id
      WHERE ${requestOrigin(scope)} AND ${decisionCurrent}
      UNION ALL
      SELECT a.subject_id, a.created_at
      FROM audit_events a
      JOIN requests r ON r.id = a.subject_id
      WHERE a.event_type IN ('risk_outcome_recorded', 'asset_outcome_recorded')
        AND ${requestOrigin(scope)}
        AND (a.origin = 'fixture'
          OR (a.payload ->> 'requestGeneration')::int = r.fixture_generation)
    ),
    firsts AS (
      SELECT request_id, min(created_at) AS first_decision_at
      FROM decision_events GROUP BY request_id
    )
    SELECT f.request_id::text AS "requestId", r.display_id AS "displayId",
      r.created_at AS "submittedAt", f.first_decision_at AS "firstDecisionAt",
      extract(epoch FROM f.first_decision_at - r.created_at)::float8 AS seconds
    FROM firsts f
    JOIN requests r ON r.id = f.request_id
    WHERE ${inRange(scope, sql`f.first_decision_at`)}
    ORDER BY f.first_decision_at, f.request_id
  `)) as unknown as FirstReviewRecord[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mergeCounts(...counts: EventCount[]): EventCount {
  return {
    count: counts.reduce((sum, entry) => sum + entry.count, 0),
    requestIds: counts.flatMap((entry) => entry.requestIds),
  };
}

export type ReportMetrics = Awaited<ReturnType<typeof reportMetrics>>;

export type ReportView = Awaited<ReturnType<typeof reportView>>;
