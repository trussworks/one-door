import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const workerHealthFile = join(tmpdir(), "one-door-worker", "progress");
export const workerProgressMaxAgeMs = 300_000;

export function recordWorkerProgress(file: string): void {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = lstatSync(parent);
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    (process.getuid && directory.uid !== process.getuid())
  )
    throw new Error(
      "Worker health directory must be private and owned by the worker",
    );
  // The checker must never observe a partially written timestamp.
  writeFileSync(file + ".next", String(Date.now()), { mode: 0o600 });
  renameSync(file + ".next", file);
}

export function isRecentWorkerProgress(
  value: unknown,
  now = Date.now(),
): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    now - value >= -5000 &&
    now - value <= workerProgressMaxAgeMs
  );
}

export function workerIsLive(file = workerHealthFile): boolean {
  try {
    const timestamp = readFileSync(file, "utf8").trim();
    return /^\d+$/.test(timestamp) && isRecentWorkerProgress(Number(timestamp));
  } catch {
    return false;
  }
}
