import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ aws: vi.fn() }));
vi.mock("../../scripts/deploy/aws.ts", async (original) => ({
  ...(await original<typeof import("../../scripts/deploy/aws.ts")>()),
  aws: mocked.aws,
}));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));

import { AwsError } from "../../scripts/deploy/aws.ts";
import {
  readWorkerProgress,
  waitForWorkerProgress,
} from "../../scripts/deploy/worker-progress.ts";
import type { TaskState } from "../../scripts/deploy/verify-release.ts";

const now = Date.now();
const task = {
  taskArn: "arn:aws:ecs:us-west-2:845191826742:task/one-door-personal/task-one",
  startedAt: new Date(now - 60_000).toISOString(),
} as TaskState;
const platform = {
  environment: "personal",
  region: "us-west-2",
  log_groups: { worker: "/one-door/personal/worker" },
};
const record = {
  Service: "one-door-worker",
  Environment: "personal",
  Heartbeat: 1,
  LastSuccessfulPollAt: now,
};
const event = { timestamp: now, message: JSON.stringify(record) };
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("accepts only a recent successful poll from this task's lifetime and environment", () => {
  expect(readWorkerProgress(event, task, "personal", now)).toEqual({
    taskArn: task.taskArn,
    lastSuccessfulPollAt: now,
    logTimestamp: now,
  });
  for (const changed of [
    { ...record, LastSuccessfulPollAt: null },
    { ...record, LastSuccessfulPollAt: now - 300_001 },
    { ...record, LastSuccessfulPollAt: now - 61_000 },
    { ...record, LastSuccessfulPollAt: now + 6000 },
    { ...record, Environment: "truss" },
    { ...record, Heartbeat: 0 },
  ])
    expect(
      readWorkerProgress(
        { ...event, message: JSON.stringify(changed) },
        task,
        "personal",
        now,
      ),
    ).toBeNull();
  expect(
    readWorkerProgress(
      { ...event, message: "malformed" },
      task,
      "personal",
      now,
    ),
  ).toBeNull();
  expect(
    readWorkerProgress(
      event,
      { ...task, startedAt: undefined },
      "personal",
      now,
    ),
  ).toBeNull();
});

it("waits for both task streams and does not let one worker's record cover its sibling", async () => {
  const sibling = {
    ...task,
    taskArn: task.taskArn.replace("task-one", "task-two"),
  };
  let reads = 0;
  mocked.aws.mockImplementation((args: string[]) => {
    reads++;
    const events =
      args.includes("ecs/worker/task-one") || reads > 2 ? [event] : [];
    return { events };
  });
  const progress = await waitForWorkerProgress(platform, [task, sibling]);
  expect(progress.map((row) => row.taskArn)).toEqual([
    task.taskArn,
    sibling.taskArn,
  ]);
  expect(reads).toBe(4);
});

it("bounds incomplete or delayed evidence and distinguishes access denial from ingestion delay", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocked.aws.mockReturnValue({ events: [] });
  await expect(waitForWorkerProgress(platform, [task])).rejects.toThrow(
    "not confirmed within ten minutes",
  );
  expect(mocked.aws).toHaveBeenCalledTimes(40);
  mocked.aws.mockClear().mockImplementation(() => {
    throw new AwsError("AccessDeniedException", "logs filter-log-events");
  });
  await expect(waitForWorkerProgress(platform, [task])).rejects.toThrow(
    "AccessDeniedException",
  );
  expect(mocked.aws).toHaveBeenCalledOnce();
  await expect(waitForWorkerProgress(platform, [])).rejects.toThrow(
    "No worker tasks",
  );
});

it("retries a temporarily absent log stream without recording success prematurely", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocked.aws
    .mockImplementationOnce(() => {
      throw new AwsError("ResourceNotFoundException", "logs filter-log-events");
    })
    .mockReturnValue({ events: [event] });
  expect(await waitForWorkerProgress(platform, [task])).toHaveLength(1);
  expect(mocked.aws).toHaveBeenCalledTimes(2);
});
