import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// The quiescence command lives in infra/RECOVERY.md and no suite executes the
// runbook, so this drives the published text against a fake AWS executable.
const runbook = readFileSync(
  new URL("../../infra/RECOVERY.md", import.meta.url),
  "utf8",
);

function quiescenceCommand(): string {
  const blocks = runbook.match(/<<'JS'\n([\s\S]*?)\nJS\n/g) ?? [];
  const program = blocks
    .map((block) => block.slice("<<'JS'\n".length, -"\nJS\n".length))
    .find((block) => block.includes("Retained tasks all report STOPPED."));
  expect(
    program,
    "the runbook must still publish a quiescence command",
  ).toBeTypeOf("string");
  return program as string;
}

const platform = {
  cluster_arn: "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal",
  region: "us-west-2",
  name: "one-door-personal",
  account_id: "845191826742",
  environment: "personal",
  app_origin: "https://d111111abcdef8.cloudfront.net",
  assets_bucket: "one-door-assets-test",
  repository_url:
    "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal",
  subnet_ids: ["subnet-a", "subnet-b"],
  database_host: "one-door-personal.abcdefghij.us-west-2.rds.amazonaws.com",
  log_groups: { operations: "/one-door/personal/operations" },
  secret_arns: Object.fromEntries(
    ["runtime", "migration", "diagnostic", "gate", "session", "anthropic"].map(
      (name) => [
        name,
        `arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/${name}-abc123`,
      ],
    ),
  ),
};

const parent = path.resolve(".harness/recovery-quiescence");
mkdirSync(parent, { recursive: true });

/** Replies to each AWS call the command makes, with no network or account. */
function fakeAws(directory: string, tasks: { lastStatus: string }[]): string {
  const executable = path.join(directory, "aws");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$*" in
  *get-caller-identity*) printf '%s' '{"Account":"845191826742"}' ;;
  *list-tasks*RUNNING*) printf '%s' '{"taskArns":[]}' ;;
  *list-tasks*STOPPED*) printf '%s' '{"taskArns":["task-a"]}' ;;
  *describe-tasks*) printf '%s' '${JSON.stringify({ tasks })}' ;;
  *) printf '%s' '{}' ;;
esac
`,
    { mode: 0o755 },
  );
  return executable;
}

function runQuiescence(tasks: { lastStatus: string }[]) {
  const directory = mkdtempSync(path.join(parent, "case-"));
  writeFileSync(
    path.join(directory, "platform.json"),
    JSON.stringify(platform),
  );
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-"],
    {
      input: quiescenceCommand(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEPLOYMENT_DIR: directory,
        ONE_DOOR_AWS: fakeAws(directory, tasks),
      },
    },
  );
}

it("confirms quiescence only when every retained task actually reports STOPPED", () => {
  const stopped = runQuiescence([{ lastStatus: "STOPPED" }]);
  expect(stopped.status).toBe(0);
  expect(stopped.stdout).toContain("Retained tasks all report STOPPED.");
});

it("refuses a task whose process is still draining", () => {
  const draining = runQuiescence([{ lastStatus: "DEACTIVATING" }]);
  expect(draining.status).not.toBe(0);
  expect(draining.stderr).toContain("Task process shutdown is unconfirmed");
});

it("refuses a response that answers about a different number of tasks", () => {
  const mismatched = runQuiescence([]);
  expect(mismatched.status).not.toBe(0);
  expect(mismatched.stderr).toContain("Task process shutdown is unconfirmed");
});
