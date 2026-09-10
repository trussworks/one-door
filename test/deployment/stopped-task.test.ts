import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ aws: vi.fn() }));
vi.mock("../../scripts/deploy/aws.ts", async (original) => ({
  ...(await original<typeof import("../../scripts/deploy/aws.ts")>()),
  aws: mocks.aws,
}));
import type { Platform } from "../../scripts/deploy/aws.ts";
import {
  describeTaskBatches,
  listDrainingTasks,
  waitForStoppedTask,
} from "../../scripts/deploy/run-task.ts";

const p = {
  region: "us-west-2",
  cluster_arn: "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal",
  name: "one-door-personal",
} as Platform;

const stopped = { taskArn: "task-a", lastStatus: "STOPPED", containers: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

it("returns the stopped task itself, so the caller decides what stopping means", async () => {
  mocks.aws.mockReturnValueOnce({ tasks: [{ ...stopped }] });
  const task = await waitForStoppedTask(p, "task-a", {
    deadlineMs: 60_000,
    timeoutMessage: "unused: ",
  });
  expect(task.lastStatus).toBe("STOPPED");
  expect(mocks.aws).toHaveBeenCalledTimes(1);
});

it("keeps polling while the task is still running, then reports the stop", async () => {
  mocks.aws
    .mockReturnValueOnce({ tasks: [{ ...stopped, lastStatus: "PENDING" }] })
    .mockReturnValueOnce({ tasks: [{ ...stopped, lastStatus: "RUNNING" }] })
    .mockReturnValueOnce({ tasks: [{ ...stopped }] });
  const task = await waitForStoppedTask(p, "task-a", {
    deadlineMs: 60_000,
    pollMs: 1,
    timeoutMessage: "unused: ",
  });
  expect(task.lastStatus).toBe("STOPPED");
  expect(mocks.aws).toHaveBeenCalledTimes(3);
});

it("reports the caller's uncertainty message with the task when the deadline passes", async () => {
  mocks.aws.mockReturnValue({ tasks: [{ ...stopped, lastStatus: "RUNNING" }] });
  await expect(
    waitForStoppedTask(p, "task-a", {
      deadlineMs: 5,
      pollMs: 1,
      timeoutMessage: "Rehearsal is still unconfirmed; do not resubmit: ",
    }),
  ).rejects.toThrow("Rehearsal is still unconfirmed; do not resubmit: task-a");
});

it("refuses a failed or incomplete describe response", async () => {
  mocks.aws.mockReturnValue({ failures: [{}], tasks: [] });
  await expect(
    waitForStoppedTask(p, "task-a", {
      deadlineMs: 60_000,
      timeoutMessage: "unused: ",
    }),
  ).rejects.toThrow("Task status could not be confirmed: task-a");
});

it("separates an absent task list from an empty one", () => {
  mocks.aws.mockReturnValueOnce({});
  expect(listDrainingTasks(p)).toBeNull();
  mocks.aws.mockReturnValueOnce({ taskArns: [] });
  expect(listDrainingTasks(p)).toEqual([]);
});

it("scopes the listing to one family only when asked", () => {
  mocks.aws.mockReturnValue({ taskArns: [] });
  listDrainingTasks(p);
  expect(mocks.aws.mock.calls.at(-1)?.[0]).not.toContain("--family");
  listDrainingTasks(p, "one-door-personal-web");
  expect(mocks.aws.mock.calls.at(-1)?.[0]).toContain("one-door-personal-web");
});

it("describes more than one hundred tasks in batches, naming what each asked about", () => {
  const arns = Array.from({ length: 250 }, (_, index) => "task-" + index);
  mocks.aws.mockImplementation((args: string[]) => ({
    tasks: args.slice(args.indexOf("--tasks") + 1).map((taskArn) => ({
      taskArn,
      lastStatus: "STOPPED",
      containers: [],
    })),
  }));
  const batches = [...describeTaskBatches(p, arns)];
  expect(batches.map((batch) => batch.requested.length)).toEqual([
    100, 100, 50,
  ]);
  expect(batches.flatMap((batch) => batch.requested)).toEqual(arns);
  for (const batch of batches)
    expect(batch.response.tasks.map((task) => task.taskArn)).toEqual(
      batch.requested,
    );
});

it("does not request a later batch after the caller rejects an earlier one", () => {
  const arns = Array.from({ length: 250 }, (_, index) => "task-" + index);
  mocks.aws.mockImplementation((args: string[]) => ({
    tasks: args.slice(args.indexOf("--tasks") + 1).map((taskArn) => ({
      taskArn,
      lastStatus: taskArn === "task-0" ? "DEACTIVATING" : "STOPPED",
      containers: [],
    })),
  }));
  expect(() => {
    for (const { response } of describeTaskBatches(p, arns))
      if (response.tasks.some((task) => task.lastStatus !== "STOPPED"))
        throw new Error("Task process shutdown is incomplete");
  }).toThrow("Task process shutdown is incomplete");
  // A later batch must not be requested once the first one is rejected, or a
  // second failure could replace the one the operator has to act on.
  expect(mocks.aws).toHaveBeenCalledTimes(1);
});
