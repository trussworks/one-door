import { describe, expect, it } from "vitest";

import { PAGE_SIZE, paginate } from "../src/domain/pagination.ts";

const items = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

describe("paginate", () => {
  it("returns one whole page at exactly the page size", () => {
    const result = paginate(items(PAGE_SIZE), 1);
    expect(result.rows).toHaveLength(PAGE_SIZE);
    expect(result.total).toBe(PAGE_SIZE);
    expect(result.pageCount).toBe(1);
    expect(result.page).toBe(1);
  });

  it("splits one row past the page size onto a second page", () => {
    const all = items(PAGE_SIZE + 1);
    const first = paginate(all, 1);
    const second = paginate(all, 2);
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(second.rows).toEqual([PAGE_SIZE + 1]);
    expect(first.pageCount).toBe(2);
    expect(first.total).toBe(PAGE_SIZE + 1);
    expect([...first.rows, ...second.rows]).toEqual(all);
  });

  it("clamps a page beyond the end to the last page", () => {
    const result = paginate(items(PAGE_SIZE + 1), 9);
    expect(result.page).toBe(2);
    expect(result.rows).toEqual([PAGE_SIZE + 1]);
  });

  it("treats zero, negative, and non-numeric pages as the first page", () => {
    for (const input of [0, -3, Number.NaN, 0.9]) {
      const result = paginate(items(5), input);
      expect(result.page).toBe(1);
      expect(result.pageCount).toBe(1);
      expect(result.rows).toEqual(items(5));
    }
  });

  it("truncates a fractional page before clamping", () => {
    expect(paginate(items(PAGE_SIZE + 1), 2.9).page).toBe(2);
  });

  it("keeps an empty set on a single empty page", () => {
    const result = paginate([], 3);
    expect(result).toEqual({
      rows: [],
      total: 0,
      page: 1,
      pageCount: 1,
      pageSize: PAGE_SIZE,
    });
  });

  it("slices the prepared order, not a reordered slice", () => {
    const sorted = items(205).reverse();
    expect(paginate(sorted, 2).rows).toEqual(sorted.slice(100, 200));
    expect(paginate(sorted, 3).rows).toEqual(sorted.slice(200));
  });
});
