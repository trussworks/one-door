import * as fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  isRecentWorkerProgress,
  recordWorkerProgress,
  workerIsLive,
  workerProgressMaxAgeMs,
} from "../src/models/worker-health.ts";

const directory = vi.hoisted(() => ({
  mode: 0o40700,
  uid: process.getuid?.() ?? 0,
  real: true,
}));
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  lstatSync: () => ({ ...directory, isDirectory: () => directory.real }),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(directory, {
    mode: 0o40700,
    uid: process.getuid?.() ?? 0,
    real: true,
  });
});
afterEach(() => vi.restoreAllMocks());

it("allows a bounded job and small clock correction but rejects stale and impossible progress", () => {
  const now = Date.now();
  expect(isRecentWorkerProgress(now - 100_000, now)).toBe(true);
  expect(isRecentWorkerProgress(now - workerProgressMaxAgeMs, now)).toBe(true);
  expect(isRecentWorkerProgress(now + 4999, now)).toBe(true);
  for (const value of [
    now - workerProgressMaxAgeMs - 1,
    now + 5001,
    null,
    "123",
    NaN,
    Infinity,
    -1,
    0,
  ])
    expect(isRecentWorkerProgress(value, now)).toBe(false);
});

it("fails a missing or malformed marker and only accepts recent complete timestamps", () => {
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(workerIsLive()).toBe(false);
  for (const value of ["", "garbage", "Infinity", "{}", "1.1", "1e20", "0"]) {
    vi.mocked(fs.readFileSync).mockReturnValue(value);
    expect(workerIsLive()).toBe(false);
  }
  vi.mocked(fs.readFileSync).mockReturnValue(String(Date.now()));
  expect(workerIsLive()).toBe(true);
});

it("publishes the timestamp atomically and fails if it cannot persist progress", () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  recordWorkerProgress("worker-health/progress");
  expect(fs.writeFileSync).toHaveBeenCalledWith(
    "worker-health/progress.next",
    String(now),
    { mode: 0o600 },
  );
  expect(fs.renameSync).toHaveBeenCalledWith(
    "worker-health/progress.next",
    "worker-health/progress",
  );
  vi.mocked(fs.writeFileSync).mockImplementation(() => {
    throw new Error("full");
  });
  expect(() => recordWorkerProgress("worker-health/progress")).toThrow("full");
});

it("refuses a shared, symlinked or foreign-owned health directory", () => {
  for (const invalid of [
    { mode: 0o40755 },
    { real: false },
    { uid: directory.uid + 1 },
  ]) {
    Object.assign(
      directory,
      { mode: 0o40700, uid: process.getuid?.() ?? 0, real: true },
      invalid,
    );
    expect(() => recordWorkerProgress("worker-health/progress")).toThrow(
      "private and owned",
    );
  }
  expect(fs.writeFileSync).not.toHaveBeenCalled();
});
