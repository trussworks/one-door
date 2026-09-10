export type SortDirection = "asc" | "desc";
export type SortState<Key extends string = string> = {
  key: Key;
  direction: SortDirection;
} | null;

// Browser headings and server query parsing must accept the same keys.
export const queueHeadingKeys = [
  "title",
  "organization",
  "action",
  "coordinator",
  "waiting",
  "submitted",
  "risk",
  "score",
] as const;

export function queueDefaultSort(
  query: Pick<URLSearchParams, "get">,
): NonNullable<SortState<(typeof queueHeadingKeys)[number]>> {
  const order = query.get("order");
  if (order === "oldest") return { key: "submitted", direction: "asc" };
  return {
    key: order === "score" || order === "risk" ? order : "waiting",
    direction: "desc",
  };
}

export type SortValue = string | number | null;

// Missing values stay last in both directions.
export function compareValues(
  a: SortValue,
  b: SortValue,
  direction: SortDirection,
): number {
  if (a === null || b === null)
    return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  const order =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), "en", {
          numeric: true,
          sensitivity: "base",
        });
  return direction === "desc" ? -order : order;
}

export function sortRows<Row, Key extends string>(
  rows: readonly Row[],
  state: SortState<Key>,
  value: (row: Row, key: Key) => SortValue,
): Row[] {
  if (!state) return [...rows];
  return [...rows].sort((a, b) =>
    compareValues(value(a, state.key), value(b, state.key), state.direction),
  );
}

export function nextSort<Key extends string>(
  state: SortState<Key>,
  key: Key,
): NonNullable<SortState<Key>> {
  const direction =
    state?.key === key && state.direction === "asc" ? "desc" : "asc";
  return { key, direction };
}

export function parseSort<Key extends string>(
  query: Pick<URLSearchParams, "get">,
  keys: readonly Key[],
): SortState<Key> {
  const requested = query.get("sort");
  if (!requested) return null;
  const key = keys.find((candidate) => candidate === requested);
  if (key === undefined) return null;
  return { key, direction: query.get("dir") === "desc" ? "desc" : "asc" };
}
