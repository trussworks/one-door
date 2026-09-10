import { describe, expect, it } from "vitest";

import {
  businessDaysBetween,
  defaultWaitThresholds,
} from "../src/domain/business-days.ts";

// 2026-01-05 is a Monday.
describe("businessDaysBetween", () => {
  it("returns 0 for the same moment and for a reversed range", () => {
    expect(
      businessDaysBetween("2026-01-05T09:00:00Z", "2026-01-05T09:00:00Z"),
    ).toBe(0);
    expect(
      businessDaysBetween("2026-01-06T09:00:00Z", "2026-01-05T09:00:00Z"),
    ).toBe(0);
  });

  it("counts 0 within the same calendar day", () => {
    expect(
      businessDaysBetween("2026-01-05T01:00:00Z", "2026-01-05T23:00:00Z"),
    ).toBe(0);
  });

  it("counts each weekday boundary crossed", () => {
    expect(
      businessDaysBetween("2026-01-05T09:00:00Z", "2026-01-06T08:00:00Z"),
    ).toBe(1);
    expect(
      businessDaysBetween("2026-01-05T09:00:00Z", "2026-01-09T17:00:00Z"),
    ).toBe(4);
  });

  it("skips weekends", () => {
    // Friday 2026-01-09 to Monday 2026-01-12: Saturday and Sunday do not count.
    expect(
      businessDaysBetween("2026-01-09T15:00:00Z", "2026-01-12T09:00:00Z"),
    ).toBe(1);
    // Saturday to Sunday crosses no business day.
    expect(
      businessDaysBetween("2026-01-10T09:00:00Z", "2026-01-11T21:00:00Z"),
    ).toBe(0);
    // One full week is five business days.
    expect(
      businessDaysBetween("2026-01-05T09:00:00Z", "2026-01-12T09:00:00Z"),
    ).toBe(5);
    // Two full weeks are ten.
    expect(
      businessDaysBetween("2026-01-05T09:00:00Z", "2026-01-19T09:00:00Z"),
    ).toBe(10);
  });

  it("rejects invalid timestamps", () => {
    expect(() =>
      businessDaysBetween("not-a-time", "2026-01-05T00:00:00Z"),
    ).toThrow();
    expect(() => businessDaysBetween("2026-01-05T00:00:00Z", "")).toThrow();
  });
});

describe("defaultWaitThresholds", () => {
  it("carries the demo defaults from the plan", () => {
    expect(defaultWaitThresholds).toEqual({
      internalBusinessDays: 3,
      requesterBusinessDays: 5,
    });
  });
});
