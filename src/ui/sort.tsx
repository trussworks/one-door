"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { nextSort, parseSort, type SortState } from "../domain/sorting";
import styles from "./sort.module.css";

export interface SortControl<Key extends string = string> {
  state: NonNullable<SortState<Key>>;
  toggle: (key: Key) => void;
}

export function useSort<Key extends string = string>(
  initial: NonNullable<SortState<NoInfer<Key>>>,
): SortControl<Key> {
  const [state, setState] = useState(initial);
  return {
    state,
    toggle: (key) => setState((current) => nextSort(current, key)),
  };
}

// Query changes preserve the chosen order across reloads and return links.
export function useUrlSort<Key extends string = string>(
  basePath: string,
  keys: readonly Key[],
  navigate: "push" | "replace" = "replace",
  initial: NonNullable<SortState<NoInfer<Key>>> = {
    key: keys[0],
    direction: "asc",
  },
): SortControl<Key> {
  const search = useSearchParams();
  const router = useRouter();
  const state = parseSort(search, keys) ?? initial;
  return {
    state,
    toggle: (key) => {
      const params = new URLSearchParams(search);
      const next = nextSort(state, key);
      params.set("sort", next.key);
      params.set("dir", next.direction);
      params.delete("page");
      params.delete("order");
      router[navigate](basePath + "?" + params, { scroll: false });
    },
  };
}

export function SortableHeader<Key extends string>({
  label,
  sortKey,
  sort,
}: {
  label: string;
  sortKey: Key;
  sort: SortControl<Key>;
}) {
  const active = sort.state?.key === sortKey ? sort.state.direction : null;
  return (
    <th
      className={styles.header}
      scope="col"
      data-column={sortKey}
      aria-sort={active === null ? undefined : ariaSort[active]}
    >
      <button type="button" onClick={() => sort.toggle(sortKey)}>
        <span className="usa-sr-only">Sort by </span>
        <span>{label}</span>
        <span className={styles.arrow} aria-hidden="true">
          {active && sortArrows[active]}
        </span>
      </button>
    </th>
  );
}

export function SortSummary({
  state,
  label,
}: {
  state: SortControl["state"];
  label: string;
}) {
  return (
    <>
      Sorted by {label}{" "}
      <span aria-hidden="true">{sortArrows[state.direction]}</span>
      <span className="usa-sr-only">{ariaSort[state.direction]}</span>
    </>
  );
}

const ariaSort = { asc: "ascending", desc: "descending" } as const;
const sortArrows = { asc: "↑", desc: "↓" } as const;
