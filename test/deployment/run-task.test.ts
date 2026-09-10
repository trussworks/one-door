import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  collectLogEvents,
  readAvailableOutput,
  requireTaskDefinition,
  taskOutcomeError,
  type LogPage,
} from "../../scripts/deploy/run-task.ts";

const platform = {
  platformName: "one-door",
  region: "us-west-2",
  accountId: "845191826742",
};

const arn = (family: string, revision = "7") =>
  `arn:aws:ecs:us-west-2:845191826742:task-definition/${family}:${revision}`;

it("accepts only this platform's family for exactly this job", () => {
  for (const job of [
    "bootstrap",
    "migration",
    "seed",
    "diagnostic",
    "verification",
    "fixture-upgrade",
  ])
    expect(
      requireTaskDefinition({
        ...platform,
        job,
        definition: arn(`one-door-${job}`),
      }),
    ).toBe(arn(`one-door-${job}`));
});

it("refuses a sibling family that shares the platform prefix", () => {
  // The defect a prefix match allowed: running the migration task for a job
  // the operator asked to seed.
  expect(() =>
    requireTaskDefinition({
      ...platform,
      job: "seed",
      definition: arn("one-door-migration"),
    }),
  ).toThrow("Unrecognized one-off task");
  expect(() =>
    requireTaskDefinition({
      ...platform,
      job: "seed",
      definition: arn("one-door-seed-extra"),
    }),
  ).toThrow("Unrecognized one-off task");
});

it("refuses an unknown job, a missing mapping and an unpinned revision", () => {
  expect(() =>
    requireTaskDefinition({
      ...platform,
      job: "shell",
      definition: arn("one-door-shell"),
    }),
  ).toThrow("not one of bootstrap, migration, seed, diagnostic");
  expect(() =>
    requireTaskDefinition({ ...platform, job: "seed", definition: undefined }),
  ).toThrow("Unrecognized one-off task");
  for (const bad of [
    "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-seed",
    "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-seed:0",
    "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-seed:latest",
  ])
    expect(
      () =>
        requireTaskDefinition({ ...platform, job: "seed", definition: bad }),
      bad,
    ).toThrow("Unrecognized one-off task");
});

it("refuses another region or another account", () => {
  expect(() =>
    requireTaskDefinition({
      ...platform,
      job: "seed",
      definition:
        "arn:aws:ecs:us-east-1:845191826742:task-definition/one-door-seed:7",
    }),
  ).toThrow("Unrecognized one-off task");
  expect(() =>
    requireTaskDefinition({
      ...platform,
      job: "seed",
      definition:
        "arn:aws:ecs:us-west-2:111122223333:task-definition/one-door-seed:7",
    }),
  ).toThrow("Unrecognized one-off task");
});

it("reads every page of a log stream in order, not only the first", () => {
  const pages: Record<string, LogPage> = {
    start: { events: [{ message: "one" }], nextForwardToken: "t1" },
    t1: { events: [{ message: "two" }], nextForwardToken: "t2" },
    t2: { events: [{ message: "three" }], nextForwardToken: "t2" },
  };
  const asked: Array<string | undefined> = [];
  const messages = collectLogEvents((token) => {
    asked.push(token);
    return pages[token ?? "start"];
  });
  expect(messages).toEqual(["one", "two", "three"]);
  expect(asked).toEqual([undefined, "t1", "t2"]);
});

it("treats a missing forward token as partial output, never as the end", () => {
  expect(() =>
    collectLogEvents(() => ({ events: [{ message: "only" }] })),
  ).toThrow("output is partial");
});

it("fails rather than truncating a stream that never terminates", () => {
  let issued = 0;
  expect(() =>
    collectLogEvents(() => {
      issued += 1;
      return { events: [{ message: "line" }], nextForwardToken: `t${issued}` };
    }, 3),
  ).toThrow("exceeded 3 pages");
  expect(issued).toBe(3);
});

it("propagates a log retrieval failure instead of returning a short read", () => {
  expect(() =>
    collectLogEvents((token) => {
      if (token === undefined)
        return { events: [{ message: "one" }], nextForwardToken: "t1" };
      throw new Error("AccessDeniedException");
    }),
  ).toThrow("AccessDeniedException");
});

it("tolerates an empty page and an event carrying no message", () => {
  const pages: Record<string, LogPage> = {
    start: { nextForwardToken: "t1" },
    t1: { events: [{}, { message: "kept" }], nextForwardToken: "t2" },
    t2: { events: [], nextForwardToken: "t2" },
  };
  expect(collectLogEvents((token) => pages[token ?? "start"])).toEqual([
    "kept",
  ]);
});

const outcome = {
  taskArn: "arn:aws:ecs:us-west-2:845191826742:task/one-door/abc",
  stream: "ecs/migration/abc",
  logGroup: "/one-door/operations",
};

it("reports success only when the exit is zero and the output was read", () => {
  expect(
    taskOutcomeError({ ...outcome, exitCode: 0, outputFailure: "" }),
  ).toBeUndefined();
});

it("fails a zero exit whose output could not be recovered", () => {
  const message = taskOutcomeError({
    ...outcome,
    exitCode: 0,
    outputFailure: "output is partial",
  });
  expect(message).toContain("exit confirmed as 0");
  expect(message).toContain("could not be recovered");
  expect(message).toContain("do not repeat this operation");
  expect(message).toContain(outcome.stream);
  expect(message).toContain(outcome.logGroup);
});

it("separates a task failure from an unreadable output, and names both", () => {
  expect(
    taskOutcomeError({
      ...outcome,
      exitCode: 1,
      stoppedReason: "Essential container exited",
      outputFailure: "",
    }),
  ).toBe(`Task failed: ${outcome.taskArn} (Essential container exited)`);
  expect(
    taskOutcomeError({
      ...outcome,
      exitCode: 1,
      stoppedReason: "Essential container exited",
      outputFailure: "AccessDeniedException",
    }),
  ).toContain("output also unrecoverable: AccessDeniedException");
});

it("treats a missing exit code as a failure, never as success", () => {
  const message = taskOutcomeError({
    ...outcome,
    exitCode: undefined,
    outputFailure: "",
  });
  expect(message).toContain("exit unconfirmed");
});

// ── The command end to end, against a fake AWS executable ────────────────────
// resolveTool honours ONE_DOOR_AWS, so the real CLI is never reached. These
// exercise submission arguments, which no helper-level test can observe.

const runner = fileURLToPath(
  new URL("../../scripts/deploy/run-task.ts", import.meta.url),
);

const platformFixture = {
  account_id: "845191826742",
  region: "us-west-2",
  environment: "personal",
  name: "one-door-personal",
  cluster_arn: "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal",
  cluster_name: "one-door-personal",
  subnet_ids: ["subnet-0a1", "subnet-0b2"],
  worker_security_group_id: "sg-0c3",
  database_host: "one-door.cluster-abc.us-west-2.rds.amazonaws.com",
  database_identifier: "one-door-personal",
  secret_arns: Object.fromEntries(
    ["runtime", "migration", "diagnostic", "gate", "session", "anthropic"].map(
      (name) => [
        name,
        `arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/${name}-AbCdEf`,
      ],
    ),
  ),
  log_groups: { operations: "/one-door/personal/operations" },
  repository_url:
    "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal",
  app_origin: "https://dexample.cloudfront.net",
  assets_bucket: "one-door-personal-assets",
  distribution_id: "E1EXAMPLE",
};

const verificationArn =
  "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-verification:3";

function stageRunner(jobs: Record<string, string>, job = "verification") {
  const dir = mkdtempSync(path.join(tmpdir(), "one-door-run-task-"));
  writeFileSync(
    path.join(dir, "platform.json"),
    JSON.stringify(platformFixture),
  );
  writeFileSync(path.join(dir, "tasks.json"), JSON.stringify({ jobs }));
  const log = path.join(dir, "argv.log");
  const fake = path.join(dir, "aws");
  writeFileSync(
    fake,
    `#!/bin/bash
printf '%s\\t' "$@" >> "$ARGV_LOG"
printf '\\n' >> "$ARGV_LOG"
case "$1 $2" in
  "sts get-caller-identity") echo '{"Account":"845191826742"}' ;;
  "ecs describe-services") echo '{"services":[{"serviceName":"one-door-personal-web","status":"ACTIVE","desiredCount":2,"runningCount":2,"pendingCount":0},{"serviceName":"one-door-personal-worker","status":"ACTIVE","desiredCount":2,"runningCount":2,"pendingCount":0}]}' ;;
  "ecs run-task") echo '{"tasks":[{"taskArn":"arn:aws:ecs:us-west-2:845191826742:task/one-door-personal/abc123"}]}' ;;
  "ecs describe-tasks") echo '{"tasks":[{"lastStatus":"STOPPED","containers":[{"name":"${job}","exitCode":0}]}]}' ;;
  "logs get-log-events")
    if [[ "$*" == *--next-token* ]]; then
      echo '{"events":[],"nextForwardToken":"f/1"}'
    else
      echo '{"events":[{"message":"acceptance complete"}],"nextForwardToken":"f/1"}'
    fi ;;
  *) echo '{}' ;;
esac
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      runner,
      path.join(dir, "platform.json"),
      path.join(dir, "tasks.json"),
      job,
      "release-42-database-verification",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ONE_DOOR_AWS: fake, ARGV_LOG: log },
    },
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t").filter(Boolean))
    : [];
  return { result, calls, dir };
}

it("submits the verification task with the exact intended request", () => {
  const { result, calls } = stageRunner({ verification: verificationArn });
  expect(result.status, result.stderr).toBe(0);

  const submission = calls.find((c) => c[0] === "ecs" && c[1] === "run-task");
  expect(submission).toBeDefined();
  expect(submission).toContain("--region");
  expect(submission).toContain("us-west-2");
  expect(submission).toContain("--cli-input-json");

  const request = JSON.parse(
    submission![submission!.indexOf("--cli-input-json") + 1],
  );
  expect(request.taskDefinition).toBe(verificationArn);
  expect(request.cluster).toBe(platformFixture.cluster_arn);
  expect(request.count).toBe(1);
  expect(request.launchType).toBe("FARGATE");
  expect(request.platformVersion).toBe("1.4.0");
  expect(request.enableECSManagedTags).toBe(true);
  expect(request.propagateTags).toBe("TASK_DEFINITION");
  expect(request.startedBy).toBe("one-door-deploy");
  expect(request.networkConfiguration.awsvpcConfiguration).toEqual({
    subnets: platformFixture.subnet_ids,
    securityGroups: [platformFixture.worker_security_group_id],
    assignPublicIp: "DISABLED",
  });
  expect(request.clientToken).toBe(
    createHash("sha256")
      .update(
        platformFixture.name +
          verificationArn +
          "release-42-database-verification",
      )
      .digest("hex"),
  );
  expect(result.stdout).toContain("acceptance complete");
});

it("confirms the account before it submits anything", () => {
  const { calls } = stageRunner({ verification: verificationArn });
  expect(calls[0]?.slice(0, 2)).toEqual(["sts", "get-caller-identity"]);
});

it("refuses a mismatched family without submitting a task", () => {
  const { result, calls } = stageRunner({
    verification:
      "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-migration:3",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Unrecognized one-off task");
  expect(calls.some((c) => c[0] === "ecs" && c[1] === "run-task")).toBe(false);
});

// ── Delivery lag, which is not the same as an empty result ───────────────────

const noWait = { waitMs: 0, sleep: async () => undefined };

it("waits for a stream that CloudWatch has not created yet", async () => {
  let attempt = 0;
  const messages = await readAvailableOutput(() => {
    attempt += 1;
    if (attempt < 3)
      throw Object.assign(new Error("get-log-events failed"), {
        code: "ResourceNotFoundException",
      });
    return ["migration applied"];
  }, noWait);
  expect(messages).toEqual(["migration applied"]);
  expect(attempt).toBe(3);
});

it("waits while the stream exists but has delivered nothing yet", async () => {
  let attempt = 0;
  const messages = await readAvailableOutput(() => {
    attempt += 1;
    return attempt < 2 ? [] : ["late line"];
  }, noWait);
  expect(messages).toEqual(["late line"]);
  expect(attempt).toBe(2);
});

it("fails when a stopped task produced no output at all", async () => {
  let attempt = 0;
  await expect(
    readAvailableOutput(() => {
      attempt += 1;
      return [];
    }, noWait),
  ).rejects.toThrow("no operation output was available");
  expect(attempt).toBe(6);
});

it("reads the same stream on every retry and never resubmits", async () => {
  let reads = 0;
  await expect(
    readAvailableOutput(
      () => {
        reads += 1;
        return [];
      },
      { ...noWait, attempts: 3 },
    ),
  ).rejects.toThrow("after 3 attempts");
  expect(reads).toBe(3);
});

it("returns a non-transient failure at once, without burning retries", async () => {
  let attempt = 0;
  await expect(
    readAvailableOutput(() => {
      attempt += 1;
      throw Object.assign(new Error("get-log-events failed"), {
        code: "AccessDeniedException",
      });
    }, noWait),
  ).rejects.toThrow("get-log-events failed");
  expect(attempt).toBe(1);
});

it("runs a pinned fixture-upgrade task through the real CLI without substituting seed or migration", () => {
  const definition =
    "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-fixture-upgrade:8";
  const staged = stageRunner(
    { "fixture-upgrade": definition },
    "fixture-upgrade",
  );
  expect(staged.result.status, staged.result.stderr).toBe(0);
  expect(staged.result.stdout).toContain("Task completion confirmed");
});

it.each(["bootstrap", "seed"])(
  "refuses %s through the real CLI while the application is running",
  (job) => {
    const definition = `arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-${job}:3`;
    const { result, calls } = stageRunner({ [job]: definition }, job);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Initialization cannot stop a running application",
    );
    expect(
      calls.some((call) => call[0] === "ecs" && call[1] === "run-task"),
    ).toBe(false);
  },
);
