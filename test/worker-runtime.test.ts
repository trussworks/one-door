import { afterEach, expect, it, vi } from "vitest";
import { runWorkerLoop, verifyWorkerDatabase } from "../src/models/worker.ts";

const state = vi.hoisted(() => ({ jobs: null as string | null, fail: false }));
vi.mock("../src/workflow/shared.ts", async (original) => ({
  ...(await original<typeof import("../src/workflow/shared.ts")>()),
  withDb: async (
    action: (db: {
      execute: () => Promise<Array<{ jobs: string | null }>>;
    }) => Promise<unknown>,
  ) => {
    if (state.fail) throw new Error("do-not-log-customer-text");
    return action({ execute: async () => [{ jobs: state.jobs }] });
  },
}));
afterEach(() => {
  state.jobs = null;
  state.fail = false;
  vi.restoreAllMocks();
});

it("refuses a worker database without migrations before reporting readiness", async () => {
  await expect(verifyWorkerDatabase()).rejects.toThrow("run db:migrate");
  state.jobs = "model_jobs";
  await expect(verifyWorkerDatabase()).resolves.toBeUndefined();
});

it("does not log SQL parameters or request text on a worker-loop failure", async () => {
  state.fail = true;
  const controller = new AbortController();
  const logger = vi
    .spyOn(console, "error")
    .mockImplementation(() => controller.abort());
  await runWorkerLoop({
    signal: controller.signal,
    provider: {
      complete: async () => {
        throw new Error("Provider must not run");
      },
    },
  });
  expect(logger).toHaveBeenCalledWith("model worker pass failed", {
    kind: "Error",
  });
  expect(JSON.stringify(logger.mock.calls)).not.toContain(
    "do-not-log-customer-text",
  );
});
