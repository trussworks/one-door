import { randomBytes } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import nextConfig from "../next.config.ts";
import { GET as live } from "../src/app/api/live/route.ts";
import { resolveApiKey } from "../src/models/provider.ts";
import { emitWorkerMetrics, runWorkerLoop } from "../src/models/worker.ts";

const workerState = vi.hoisted(() => ({
  pollFails: false,
  metricsFail: false,
  missingMetrics: false,
}));
vi.mock("../src/workflow/shared.ts", async (original) => ({
  ...(await original<typeof import("../src/workflow/shared.ts")>()),
  withDb: async (
    action: (db: {
      execute: () => Promise<Array<{ queued: number; oldest_seconds: number }>>;
      transaction: () => Promise<null>;
    }) => Promise<unknown>,
  ) =>
    action({
      execute: async () => {
        if (workerState.metricsFail) throw new Error("private-query-details");
        return workerState.missingMetrics
          ? []
          : [{ queued: 3, oldest_seconds: 42 }];
      },
      transaction: async () => {
        if (workerState.pollFails) throw new Error("private-query-details");
        return null;
      },
    }),
}));

afterEach(() => {
  Object.assign(workerState, {
    pollFails: false,
    metricsFail: false,
    missingMetrics: false,
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("keeps local builds untouched and rejects a malformed release id", () => {
  vi.stubEnv("RELEASE_ID", "");
  vi.stubEnv("ONE_DOOR_BUILD_DIR", "");
  const local = nextConfig();
  expect(local.distDir).toBe(".next");
  expect(local.deploymentId).toBeUndefined();
  expect(local.assetPrefix).toBeUndefined();

  vi.stubEnv("ONE_DOOR_BUILD_DIR", ".harness/check");
  vi.stubEnv("RELEASE_ID", "abc123-42-1");
  const release = nextConfig();
  expect(release.distDir).toBe(".harness/check");
  expect(release.deploymentId).toBe("abc123-42-1");
  expect(release.assetPrefix).toBe("/_assets/abc123-42-1");

  for (const bad of ["../escape", "a b", "a/b", "-lead", "id_underscore"]) {
    vi.stubEnv("RELEASE_ID", bad);
    expect(() => nextConfig(), bad).toThrow(/RELEASE_ID/);
  }
});

it("answers liveness from configuration alone, without a database", async () => {
  vi.stubEnv("DEMO_ACCESS_CODE", randomBytes(12).toString("hex"));
  vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
  const ok = live();
  expect(ok.status).toBe(200);
  expect((await ok.json()).status).toBe("live");
  expect(ok.headers.get("Cache-Control")).toBe("no-store");

  vi.stubEnv("DEMO_ACCESS_CODE", "");
  const unconfigured = live();
  expect(unconfigured.status).toBe(503);
});

it("fails a missing model credential safely, without keychain on linux", async () => {
  const key = randomBytes(16).toString("hex");
  vi.stubEnv("ANTHROPIC_API_KEY", `  ${key}  `);
  await expect(resolveApiKey()).resolves.toBe(key);

  vi.stubEnv("ANTHROPIC_API_KEY", "");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    await expect(resolveApiKey()).rejects.toThrow(
      "model credentials unavailable: set ANTHROPIC_API_KEY or store Keychain item 'anthropic-api'",
    );
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

it("emits one bounded EMF line with stable dimensions and no job ids", async () => {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logged.push(line);
  });
  await emitWorkerMetrics(
    {
      succeeded: 2,
      retry_queued: 0,
      failed: 1,
      capped: 0,
      superseded: 0,
      lease_lost: 0,
      poll_error: 3,
    },
    Date.now(),
  );
  expect(logged).toHaveLength(1);
  const metric = JSON.parse(logged[0]);
  expect(metric._aws.CloudWatchMetrics[0].Namespace).toBe("OneDoor/Worker");
  expect(metric._aws.CloudWatchMetrics[0].Dimensions).toEqual([
    ["Service", "Environment"],
  ]);
  expect(metric.Service).toBe("one-door-worker");
  expect(metric.Heartbeat).toBe(1);
  expect(metric.QueuedJobs).toBe(3);
  expect(metric.OldestQueuedAgeSeconds).toBe(42);
  expect(metric.JobsSucceeded).toBe(2);
  expect(metric.JobsFailed).toBe(1);
  expect(metric.WorkerPollErrors).toBe(3);
  expect(metric.QueueCollectionSucceeded).toBe(1);
  expect(JSON.stringify(metric)).not.toMatch(/jobId/i);
});

it("emits metrics once per interval while the loop idles", async () => {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logged.push(line);
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await runWorkerLoop({
    provider: {
      complete: async () => {
        throw new Error("Provider must not run");
      },
    },
    idleDelayMs: 1,
    metricsIntervalMs: 60_000,
    signal: controller.signal,
  });
  const emf = logged.filter((line) => line.includes('"_aws"'));
  expect(emf).toHaveLength(1);
  expect(JSON.parse(emf[0]).Heartbeat).toBe(1);
  expect(JSON.parse(emf[0]).LastSuccessfulPollAt).toBeGreaterThan(0);
  expect(logged.filter((line) => line.includes("model_job_outcome"))).toEqual(
    [],
  );
});

it.each(["metricsFail", "missingMetrics"] as const)(
  "reports %s without inventing a healthy queue or losing errors",
  async (failure) => {
    workerState[failure] = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await emitWorkerMetrics(
      {
        succeeded: 0,
        retry_queued: 0,
        failed: 0,
        capped: 0,
        superseded: 0,
        lease_lost: 0,
        poll_error: 2,
      },
      null,
    );
    const metric = JSON.parse(String(log.mock.calls[0][0]));
    expect(metric.WorkerPollErrors).toBe(2);
    expect(metric.QueueCollectionSucceeded).toBe(0);
    expect(metric.Heartbeat).toBe(0);
    expect(metric).not.toHaveProperty("QueuedJobs");
    expect(metric).not.toHaveProperty("OldestQueuedAgeSeconds");
    expect(JSON.stringify(metric)).not.toContain("private-query-details");
  },
);

it("keeps a failed claim distinct from idle even when queue measurements succeed", async () => {
  workerState.pollFails = true;
  const controller = new AbortController();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi
    .spyOn(console, "log")
    .mockImplementation(() => controller.abort());
  await runWorkerLoop({
    provider: {
      complete: async () => {
        throw new Error("Provider must not run");
      },
    },
    signal: controller.signal,
  });
  const metric = JSON.parse(String(log.mock.calls[0][0]));
  expect(metric.QueueCollectionSucceeded).toBe(1);
  expect(metric.WorkerPollErrors).toBe(1);
  expect(metric.Heartbeat).toBe(0);
  expect(metric.LastSuccessfulPollAt).toBeNull();
});
