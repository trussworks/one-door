/**
 * Business-day arithmetic for wait clocks: Monday–Friday, no holiday
 * calendar, computed on UTC calendar dates. Demo defaults, not OIT policy;
 * callers may pass their own thresholds and readers see which were used.
 */

export interface WaitThresholds {
  /** Business days a request may wait on an internal reviewer. */
  internalBusinessDays: number;
  /** Business days a request may wait on its requester. */
  requesterBusinessDays: number;
}

export const defaultWaitThresholds: WaitThresholds = {
  internalBusinessDays: 3,
  requesterBusinessDays: 5,
};

const dayMs = 86_400_000;

/**
 * Count the weekday calendar-date boundaries crossed from start to end.
 * A Friday-afternoon start reaches 1 on Monday, so thresholds read as
 * "has waited N business days". Returns 0 when end is not after start.
 */
export function businessDaysBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("businessDaysBetween needs two valid timestamps");
  }
  const startDay = Math.floor(start / dayMs);
  const endDay = Math.floor(end / dayMs);
  let count = 0;
  for (let day = startDay + 1; day <= endDay; day += 1) {
    const weekday = new Date(day * dayMs).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}
