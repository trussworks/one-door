import { setTimeout as delay } from "node:timers/promises";

import { isRecentWorkerProgress } from "../../src/models/worker-health.ts";
import { aws, AwsError, type Platform } from "./aws.ts";
import type { TaskState } from "./verify-release.ts";

type WorkerPlatform = Pick<Platform, "environment" | "region" | "log_groups">;
type WorkerTask = Pick<TaskState, "taskArn" | "startedAt">;

interface LogEvent {
  timestamp: number;
  message: string;
}

export interface WorkerProgress {
  taskArn: string;
  lastSuccessfulPollAt: number;
  logTimestamp: number;
}

export function readWorkerProgress(
  event: LogEvent,
  task: WorkerTask,
  environment: string,
  now = Date.now(),
): WorkerProgress | null {
  let record;
  try {
    record = JSON.parse(event.message);
  } catch {
    return null;
  }
  if (
    !record ||
    record.Service !== "one-door-worker" ||
    record.Environment !== environment ||
    record.Heartbeat !== 1 ||
    !validPollTiming(
      task.startedAt,
      record.LastSuccessfulPollAt,
      event.timestamp,
      now,
    )
  )
    return null;
  return {
    taskArn: task.taskArn,
    lastSuccessfulPollAt: record.LastSuccessfulPollAt,
    logTimestamp: event.timestamp,
  };
}

function validPollTiming(
  startedAt: string | undefined,
  poll: number,
  log: number,
  now: number,
): boolean {
  const start = Date.parse(startedAt ?? "");
  return (
    Number.isFinite(start) &&
    isRecentWorkerProgress(poll, now) &&
    poll >= start &&
    isRecentWorkerProgress(log, now) &&
    poll <= log + 5000
  );
}

function latestProgress(
  p: WorkerPlatform,
  task: WorkerTask,
): WorkerProgress | null {
  const id = task.taskArn.split("/").at(-1);
  if (!id || !Number.isFinite(Date.parse(task.startedAt ?? "")))
    throw new Error("Worker startup identity is unconfirmed");
  const response = aws<{ events: LogEvent[] }>([
    "logs",
    "filter-log-events",
    "--region",
    p.region,
    "--log-group-name",
    p.log_groups.worker,
    "--log-stream-names",
    "ecs/worker/" + id,
    "--start-time",
    String(Math.max(Date.parse(task.startedAt!), Date.now() - 300_000)),
    "--filter-pattern",
    '{ $.Service = "one-door-worker" && $.Heartbeat = 1 }',
    "--cli-connect-timeout",
    "5",
    "--cli-read-timeout",
    "10",
  ]);
  return (
    response.events
      .map((event) => readWorkerProgress(event, task, p.environment))
      .filter((event): event is WorkerProgress => event !== null)
      .sort((a, b) => b.lastSuccessfulPollAt - a.lastSuccessfulPollAt)[0] ??
    null
  );
}

export async function waitForWorkerProgress(
  p: WorkerPlatform,
  tasks: WorkerTask[],
): Promise<WorkerProgress[]> {
  if (tasks.length === 0)
    throw new Error("No worker tasks were supplied for progress verification");
  const deadline = Date.now() + 600_000;
  for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt++) {
    try {
      const progress = tasks.map((task) => latestProgress(p, task));
      if (progress.every((row): row is WorkerProgress => row !== null))
        return progress;
    } catch (error) {
      if (
        !(error instanceof AwsError) ||
        ![
          "ThrottlingException",
          "ServiceUnavailableException",
          "ResourceNotFoundException",
        ].includes(error.code)
      )
        throw error;
    }
    if (attempt % 4 === 0)
      console.log(
        "Waiting for recent successful polling from every worker task.",
      );
    if (attempt < 39) await delay(15_000);
  }
  throw new Error(
    "Fresh worker progress was not confirmed within ten minutes; log delivery or worker processing may be impaired",
  );
}
