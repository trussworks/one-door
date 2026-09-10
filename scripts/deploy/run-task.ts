// Runs one bootstrap, migration, seed, diagnostic or verification task and
// reports what it did. Recovery depends on the task's own output, so a
// confirmed exit code with no readable output is a failure here: an operator
// who cannot read what a migration printed cannot decide whether to repeat it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { isMain } from "../is-main.mjs";
import { aws, readPlatform, requireAccount, type Platform } from "./aws.ts";

const JOBS = [
  "bootstrap",
  "migration",
  "seed",
  "diagnostic",
  "verification",
  "fixture-upgrade",
];

// get-log-events returns at most 1 MB or 10,000 events per page, so a page cap
// bounds the walk.
const MAX_LOG_PAGES = 200;

// CloudWatch delivery lags the task's exit, and the stream may not exist yet.
const OUTPUT_ATTEMPTS = 6;
const OUTPUT_WAIT_MS = 5000;

export type LogPage = {
  events?: Array<{ message?: string }>;
  nextForwardToken?: string;
};

/**
 * Resolves the task definition for `job`, rejecting any definition that is not
 * exactly this platform's family for exactly this job at a pinned revision.
 * A prefix match would accept `one-door-migration` for the `seed` job.
 */
export function requireTaskDefinition(input: {
  job: string;
  definition: string | undefined;
  platformName: string;
  region: string;
  accountId: string;
}): string {
  const { job, definition, platformName, region, accountId } = input;
  if (!JOBS.includes(job))
    throw new Error(
      `Unrecognized one-off task: ${job} is not one of ${JOBS.join(", ")}`,
    );
  const family = `${platformName}-${job}`;
  const expected = new RegExp(
    `^arn:aws:ecs:${escapeForPattern(region)}:${escapeForPattern(accountId)}:task-definition/${escapeForPattern(family)}:[1-9][0-9]*$`,
  );
  if (!definition || !expected.test(definition))
    throw new Error(
      `Unrecognized one-off task: ${job} must map to arn:aws:ecs:${region}:${accountId}:task-definition/${platformName}-${job}:REVISION`,
    );
  return definition;
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walks the pages of one log stream from the head and returns the events
 * CloudWatch has delivered so far. CloudWatch ends a forward walk by returning
 * the token it was given, so the walk stops on a repeated token and fails on a
 * missing one. Reaching the end of the token chain means no more events are
 * available to read now; it is not evidence that the task emitted no further
 * output, and it does not prove that nothing was dropped or is still in
 * flight.
 */
export function collectLogEvents(
  readPage: (token: string | undefined) => LogPage,
  maxPages: number = MAX_LOG_PAGES,
): string[] {
  const messages: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const response = readPage(token);
    for (const event of response.events ?? [])
      if (event.message !== undefined) messages.push(event.message);
    const next = response.nextForwardToken;
    if (next === undefined)
      throw new Error("log page returned no forward token; output is partial");
    if (next === token) return messages;
    token = next;
  }
  throw new Error(`log stream exceeded ${maxPages} pages; output is partial`);
}

function isMissingStream(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code).startsWith("ResourceNotFound")
  );
}

/**
 * Retries only while the stream is absent or still empty, which is delivery
 * lag rather than a result. Any other failure is returned to the caller at
 * once. Retrying reads the same stream and never resubmits the task.
 */
export async function readAvailableOutput(
  read: () => string[],
  options: {
    attempts?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<string[]> {
  const attempts = options.attempts ?? OUTPUT_ATTEMPTS;
  const waitMs = options.waitMs ?? OUTPUT_WAIT_MS;
  const sleep = options.sleep ?? delay;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let messages: string[] = [];
    try {
      messages = read();
    } catch (error) {
      if (!isMissingStream(error)) throw error;
    }
    if (messages.length > 0) return messages;
    if (attempt < attempts) await sleep(waitMs);
  }
  throw new Error(
    `no operation output was available after ${attempts} attempts over ${Math.round((attempts - 1) * (waitMs / 1000))}s`,
  );
}

export function readOperationLog(
  p: Platform,
  stream: string,
  options: { logGroup?: string; maxPages?: number } = {},
): string[] {
  const logGroup = options.logGroup ?? p.log_groups.operations;
  return collectLogEvents(
    (token) =>
      aws<LogPage>([
        "logs",
        "get-log-events",
        "--region",
        p.region,
        "--log-group-name",
        logGroup,
        "--log-stream-name",
        stream,
        "--start-from-head",
        ...(token ? ["--next-token", token] : []),
      ]),
    options.maxPages ?? MAX_LOG_PAGES,
  );
}

export type StoppedTask = {
  taskArn?: string;
  lastStatus: string;
  stoppedReason?: string;
  containers: Array<{ name: string; exitCode?: number }>;
};

/**
 * Lists tasks whose desired state is STOPPED, optionally within one family.
 * Returns null when the response carries no task list, because an absent list
 * is not an empty one and each caller reports that differently.
 */
export function listDrainingTasks(
  p: Platform,
  family?: string,
): string[] | null {
  const listed = aws<{ taskArns?: string[] }>([
    "ecs",
    "list-tasks",
    "--region",
    p.region,
    "--cluster",
    p.cluster_arn,
    ...(family ? ["--family", family] : []),
    "--desired-status",
    "STOPPED",
  ]);
  return Array.isArray(listed.taskArns) ? listed.taskArns : null;
}

/**
 * describe-tasks accepts at most 100 identifiers, so a longer list is read in
 * batches. Each batch is yielded beside the identifiers it asked about, and the
 * next batch is requested only once the caller has accepted the current one, so
 * a later failure cannot mask an earlier rejection.
 */
export function* describeTaskBatches(
  p: Platform,
  taskArns: string[],
): Generator<{
  requested: string[];
  response: { failures?: unknown[]; tasks: StoppedTask[] };
}> {
  for (let offset = 0; offset < taskArns.length; offset += 100) {
    const requested = taskArns.slice(offset, offset + 100);
    yield {
      requested,
      response: aws<{ failures?: unknown[]; tasks: StoppedTask[] }>([
        "ecs",
        "describe-tasks",
        "--region",
        p.region,
        "--cluster",
        p.cluster_arn,
        "--tasks",
        ...requested,
      ]),
    };
  }
}

/**
 * Polls one task until it reports STOPPED. Stopping is not success: the
 * caller decides what a stopped task means, because an operation job reads
 * its exit code while the restore rehearsal compares recorded evidence.
 */
export async function waitForStoppedTask(
  p: Platform,
  taskArn: string,
  options: {
    deadlineMs: number;
    pollMs?: number;
    timeoutMessage: string;
    unconfirmedMessage?: string;
  },
): Promise<StoppedTask> {
  const pollMs = options.pollMs ?? 5000;
  const deadline = Date.now() + options.deadlineMs;
  let reported = "";
  while (Date.now() < deadline) {
    const response = aws<{ failures?: unknown[]; tasks: StoppedTask[] }>([
      "ecs",
      "describe-tasks",
      "--region",
      p.region,
      "--cluster",
      p.cluster_arn,
      "--tasks",
      taskArn,
    ]);
    if (response.failures?.length || response.tasks.length !== 1)
      throw new Error(
        (options.unconfirmedMessage ?? "Task status could not be confirmed: ") +
          taskArn,
      );
    const task = response.tasks[0];
    if (task.lastStatus !== reported) {
      reported = task.lastStatus;
      console.log("Task state:", reported);
    }
    if (task.lastStatus === "STOPPED") return task;
    await delay(pollMs);
  }
  throw new Error(options.timeoutMessage + taskArn);
}

/**
 * Decides what to report about a stopped task. A confirmed zero exit whose
 * output could not be read is still a failure: an exit code alone does not
 * tell an operator whether repeating the operation is safe.
 */
export function taskOutcomeError(input: {
  taskArn: string;
  stoppedReason?: string;
  exitCode?: number;
  outputFailure: string;
  stream: string;
  logGroup: string;
}): string | undefined {
  const { taskArn, stoppedReason, exitCode, outputFailure, stream, logGroup } =
    input;
  if (exitCode !== 0)
    return (
      `Task failed: ${taskArn} (${stoppedReason ?? "exit unconfirmed"})` +
      (outputFailure ? `; output also unrecoverable: ${outputFailure}` : "")
    );
  if (outputFailure)
    return `Task exit confirmed as 0 but its output could not be recovered (${outputFailure}); do not repeat this operation, read log stream ${stream} in log group ${logGroup}: ${taskArn}`;
  return undefined;
}

async function finishStoppedTask(
  p: Platform,
  task: StoppedTask,
  taskArn: string,
  job: string,
): Promise<void> {
  const stream = "ecs/" + job + "/" + taskArn.split("/").at(-1);
  let outputFailure = "";
  try {
    const messages = await readAvailableOutput(() =>
      readOperationLog(p, stream, { logGroup: p.log_groups.operations }),
    );
    for (const message of messages) console.log(message);
  } catch (error) {
    outputFailure =
      error instanceof Error ? error.message : "log retrieval failed";
  }
  const failure = taskOutcomeError({
    taskArn,
    stoppedReason: task.stoppedReason,
    exitCode: task.containers.find((c) => c.name === job)?.exitCode,
    outputFailure,
    stream,
    logGroup: p.log_groups.operations,
  });
  if (failure) throw new Error(failure);
  console.log(
    "Task completion confirmed, with the output available at read time:",
    taskArn,
  );
}

async function awaitTaskCompletion(
  p: Platform,
  taskArn: string,
  job: string,
): Promise<void> {
  const task = await waitForStoppedTask(p, taskArn, {
    deadlineMs: 45 * 60_000,
    timeoutMessage:
      "Task is still unconfirmed and may be running; do not repeat with a new operation ID: ",
  });
  return finishStoppedTask(p, task, taskArn, job);
}

export function requireInitializationStopped(p: Platform): void {
  const names = [p.name + "-web", p.name + "-worker"];
  const response = aws<{
    failures?: Array<{ arn: string; reason: string }>;
    services: Array<{
      serviceName: string;
      status: string;
      desiredCount: number;
      runningCount: number;
      pendingCount: number;
    }>;
  }>([
    "ecs",
    "describe-services",
    "--region",
    p.region,
    "--cluster",
    p.cluster_arn,
    "--services",
    ...names,
  ]);
  const missing = response.failures ?? [];
  assert.ok(
    missing.every((failure) => failure.reason === "MISSING"),
    "Service status could not be confirmed",
  );
  assert.deepEqual(
    [
      ...response.services.map((service) => service.serviceName),
      ...missing.map((failure) => failure.arn.split("/").at(-1)),
    ].sort(),
    names.sort(),
  );
  for (const service of response.services) {
    assert.equal(
      service.status,
      "ACTIVE",
      "Service state is not stable for initialization",
    );
    assert.deepEqual(
      [service.desiredCount, service.runningCount, service.pendingCount],
      [0, 0, 0],
      "Initialization cannot stop a running application",
    );
  }
  requireTasksStopped(p);
}

function requireTasksStopped(p: Platform): void {
  const active = aws<{ taskArns: string[] }>([
    "ecs",
    "list-tasks",
    "--region",
    p.region,
    "--cluster",
    p.cluster_arn,
    "--desired-status",
    "RUNNING",
  ]);
  assert.deepEqual(
    active.taskArns,
    [],
    "A task is still running or provisioning",
  );
  const draining = listDrainingTasks(p);
  assert.ok(draining !== null);
  for (const { requested, response } of describeTaskBatches(p, draining)) {
    assert.equal(
      response.failures?.length ?? 0,
      0,
      "Task shutdown is unconfirmed",
    );
    assert.deepEqual(
      response.tasks.map((task) => task.taskArn).sort(),
      [...requested].sort(),
    );
    assert.ok(
      response.tasks.every((task) => task.lastStatus === "STOPPED"),
      "Task process shutdown is incomplete",
    );
  }
}

if (isMain(import.meta)) {
  const [platformFile, tasksFile, job, operationId] = process.argv.slice(2);
  if (!platformFile || !tasksFile || !job || !operationId)
    throw new Error(
      "Usage: run-task.ts PLATFORM_JSON TASKS_JSON JOB OPERATION_ID",
    );
  const p = readPlatform(platformFile);
  requireAccount(p);
  const tasks = JSON.parse(readFileSync(tasksFile, "utf8")) as {
    jobs: Record<string, string>;
  };
  const definition = requireTaskDefinition({
    job,
    definition: tasks.jobs[job],
    platformName: p.name,
    region: p.region,
    accountId: p.account_id,
  });
  if (job === "bootstrap" || job === "seed") requireInitializationStopped(p);
  // The request carries no secret value, so --cli-input-json in argv is safe.
  // A stdin route is not available here: the AWS CLI cannot read /dev/stdin
  // twice, and aws() reserves stdin for secret payloads.
  const request = {
    cluster: p.cluster_arn,
    taskDefinition: definition,
    launchType: "FARGATE",
    platformVersion: "1.4.0",
    enableECSManagedTags: true,
    propagateTags: "TASK_DEFINITION",
    count: 1,
    clientToken: createHash("sha256")
      .update(p.name + definition + operationId)
      .digest("hex"),
    startedBy: "one-door-deploy",
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: p.subnet_ids,
        securityGroups: [p.worker_security_group_id],
        assignPublicIp: "DISABLED",
      },
    },
  };
  const result = aws<{
    failures?: Array<{ reason?: string }>;
    tasks?: Array<{ taskArn: string }>;
  }>([
    "ecs",
    "run-task",
    "--region",
    p.region,
    "--cli-input-json",
    JSON.stringify(request),
  ]);
  if (result.failures?.length || result.tasks?.length !== 1)
    throw new Error("Task submission did not start exactly one task");
  const taskArn = result.tasks[0].taskArn;
  console.log("Task submitted:", taskArn);
  await awaitTaskCompletion(p, taskArn, job);
  process.exit(0);
}
