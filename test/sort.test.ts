import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  compareValues,
  nextSort,
  parseSort,
  queueHeadingKeys,
  queueDefaultSort,
  sortRows,
} from "../src/domain/sorting";
import { SortableHeader } from "../src/ui/sort";
import { queueOptions } from "../src/server/query-options";
import { catalogPage } from "../src/ui/catalog";
import type { InventoryOverview } from "../src/server/catalog-views";

it("compares numbers numerically and text with numeric awareness", () => {
  expect(compareValues(2, 10, "asc")).toBeLessThan(0);
  expect(compareValues(2, 10, "desc")).toBeGreaterThan(0);
  expect(compareValues("OD-2", "OD-10", "asc")).toBeLessThan(0);
  expect(compareValues("alpha", "Beta", "asc")).toBeLessThan(0);
  expect(compareValues("alpha", "Beta", "desc")).toBeGreaterThan(0);
});

it("keeps empty values after real values in both directions", () => {
  expect(compareValues(null, 5, "asc")).toBeGreaterThan(0);
  expect(compareValues(null, 5, "desc")).toBeGreaterThan(0);
  expect(compareValues("z", null, "asc")).toBeLessThan(0);
  expect(compareValues("z", null, "desc")).toBeLessThan(0);
  expect(compareValues(null, null, "asc")).toBe(0);
});

it("sorts a copy, keeps ties in their incoming order, and passes nulls last", () => {
  const rows = [
    { id: "a", score: 3 as number | null },
    { id: "b", score: null },
    { id: "c", score: 3 },
    { id: "d", score: 1 },
  ];
  const asc = sortRows(
    rows,
    { key: "score", direction: "asc" },
    (row) => row.score,
  );
  expect(asc.map((row) => row.id)).toEqual(["d", "a", "c", "b"]);
  const desc = sortRows(
    rows,
    { key: "score", direction: "desc" },
    (row) => row.score,
  );
  expect(desc.map((row) => row.id)).toEqual(["a", "c", "d", "b"]);
  expect(rows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  expect(sortRows(rows, null, (row) => row.score)).not.toBe(rows);
});

it("cycles a heading from unsorted to ascending to descending and back", () => {
  const first = nextSort(null, "title");
  expect(first).toEqual({ key: "title", direction: "asc" });
  const second = nextSort(first, "title");
  expect(second).toEqual({ key: "title", direction: "desc" });
  expect(nextSort(second, "title")).toEqual({
    key: "title",
    direction: "asc",
  });
  expect(nextSort(second, "risk")).toEqual({ key: "risk", direction: "asc" });
});

it("parses only known sort keys from the address", () => {
  const keys = ["title", "score"];
  expect(parseSort(new URLSearchParams("sort=title&dir=desc"), keys)).toEqual({
    key: "title",
    direction: "desc",
  });
  expect(parseSort(new URLSearchParams("sort=title"), keys)).toEqual({
    key: "title",
    direction: "asc",
  });
  expect(parseSort(new URLSearchParams("sort=constructor"), keys)).toBeNull();
  expect(parseSort(new URLSearchParams(""), keys)).toBeNull();
});

it("keeps queue order presets available through their corresponding columns", () => {
  expect(queueDefaultSort(new URLSearchParams())).toEqual({
    key: "waiting",
    direction: "desc",
  });
  expect(queueDefaultSort(new URLSearchParams("order=oldest"))).toEqual({
    key: "submitted",
    direction: "asc",
  });
  for (const key of ["score", "risk"])
    expect(queueDefaultSort(new URLSearchParams("order=" + key))).toEqual({
      key,
      direction: "desc",
    });
  expect(queueDefaultSort(new URLSearchParams("order=constructor"))).toEqual({
    key: "waiting",
    direction: "desc",
  });
});

it("carries a queue heading sort through page changes and past the order select", () => {
  const actor = "0f9c2d4e-0000-4000-8000-000000000001";
  const page1 = queueOptions(
    new URLSearchParams("sort=coordinator&dir=desc&order=score"),
    actor,
  );
  expect(page1.heading).toEqual({ key: "coordinator", direction: "desc" });
  expect(page1.sort).toBe("score");
  const page3 = queueOptions(
    new URLSearchParams("sort=coordinator&dir=desc&page=3"),
    actor,
  );
  expect(page3.heading).toEqual({ key: "coordinator", direction: "desc" });
  expect(page3.page).toBe(3);
  expect(
    queueOptions(new URLSearchParams("sort=nonsense&dir=desc"), actor).heading,
  ).toBeUndefined();
  for (const key of queueHeadingKeys)
    expect(
      queueOptions(new URLSearchParams(`sort=${key}`), actor).heading?.key,
    ).toBe(key);
});

function catalogItem(
  overrides: Partial<InventoryOverview["items"][number]> & { id: string },
) {
  return {
    name: "Item " + overrides.id,
    itemType: "software",
    currentVersion: 1,
    publicationState: "published",
    approvalStatus: "approved",
    ownerOrganizationId: null,
    reviewDate: "2026-01-01",
    ...overrides,
  } as InventoryOverview["items"][number];
}

it("sorts the whole catalog before slicing a page", () => {
  // 105 items: one full 100-row page plus five overflow rows. Zero-padded
  // names keep the text sort equal to the numeric order.
  const name = (index: number) => "Item " + String(index).padStart(3, "0");
  const items = Array.from({ length: 105 }, (_, index) =>
    catalogItem({ id: String(index + 1), name: name(index + 1) }),
  );
  const context = { conflicts: [], organizations: [] };
  const pageTwo = catalogPage(
    items,
    { key: "name", direction: "desc" },
    2,
    context,
  );
  expect(pageTwo.map((item) => item.name)).toEqual([
    name(5),
    name(4),
    name(3),
    name(2),
    name(1),
  ]);
  const unsorted = catalogPage(items, null, 2, context);
  expect(unsorted.map((item) => item.name)).toEqual(
    [101, 102, 103, 104, 105].map(name),
  );
  const singlePage = catalogPage(items.slice(0, 100), null, 1, context);
  expect(singlePage).toHaveLength(100);
});

it("keeps items without an owning team after named teams in both directions", () => {
  const organizations = [{ id: "org-1", name: "Office of IT" }];
  const items = [
    catalogItem({ id: "1", ownerOrganizationId: "org-1" }),
    catalogItem({ id: "2", ownerOrganizationId: "missing" }),
  ];
  const context = { conflicts: [], organizations };
  for (const direction of ["asc", "desc"] as const) {
    const rows = catalogPage(items, { key: "owner", direction }, 1, context);
    expect(rows[rows.length - 1].id).toBe("2");
  }
});

it("marks the active heading for assistive technology", () => {
  const sort = {
    state: { key: "title", direction: "asc" as const },
    toggle: () => {},
  };
  const active = renderToStaticMarkup(
    createElement(SortableHeader, { label: "Request", sortKey: "title", sort }),
  );
  expect(active).toContain('aria-sort="ascending"');
  expect(active).toContain("Sort by ");
  expect(active).toContain("Request");
  expect(active).toContain('aria-hidden="true"');
  const inactive = renderToStaticMarkup(
    createElement(SortableHeader, { label: "Risk", sortKey: "risk", sort }),
  );
  expect(inactive).not.toContain("aria-sort");
  const descending = renderToStaticMarkup(
    createElement(SortableHeader, {
      label: "Request",
      sortKey: "title",
      sort: { ...sort, state: { key: "title", direction: "desc" } },
    }),
  );
  expect(descending).toContain('aria-sort="descending"');
});
