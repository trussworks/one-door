import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ aws: vi.fn() }));
vi.mock("../../scripts/deploy/aws.ts", async (original) => ({
  ...(await original<typeof import("../../scripts/deploy/aws.ts")>()),
  aws: mocks.aws,
  requireAccount: (p: { account_id: string }) => {
    if (mocks.aws(["sts", "get-caller-identity"]).Account !== p.account_id)
      throw new Error("AWS account mismatch; no changes attempted");
  },
}));
import { AwsError } from "../../scripts/deploy/aws.ts";
import type { Platform } from "../../scripts/deploy/aws.ts";
import { rotateSecret } from "../../scripts/deploy/rotate-secret.ts";

const p = {
  account_id: "845191826742",
  region: "us-west-2",
  name: "one-door-personal",
  cluster_arn: "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal",
  secret_arns: { gate: "test-gate", session: "test-session" },
} as unknown as Platform;
const parent = path.resolve(".harness/rotation-unit");
mkdirSync(parent, { recursive: true });
let record: string;
let current: string;
let original: string;
let versions: Map<string, string>;
let running: number;
let pendingTasks: string[];
let stoppedTasks: string[];
let lastStatus: string;
let losePutResponse: boolean;
let racePromotion: boolean;
let account: string;

function readVersion(args: string[]) {
  const id = args.includes("--version-id")
    ? args[args.indexOf("--version-id") + 1]
    : current;
  if (!versions.has(id))
    throw new AwsError("ResourceNotFoundException", "get-secret-value");
  return { VersionId: id, SecretString: versions.get(id) };
}

function listTasks(args: string[]) {
  return { taskArns: args.includes("STOPPED") ? stoppedTasks : pendingTasks };
}

function promoteVersion(args: string[]) {
  if (racePromotion) current = randomUUID();
  if (current !== args[args.indexOf("--remove-from-version-id") + 1])
    throw new AwsError(
      "InvalidParameterException",
      "update-secret-version-stage",
    );
  current = args[args.indexOf("--move-to-version-id") + 1];
  return {};
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  record = path.join(mkdtempSync(path.join(parent, "case-")), "rotation.json");
  current = original = randomUUID();
  versions = new Map([[current, randomBytes(18).toString("base64url")]]);
  running = 0;
  pendingTasks = [];
  stoppedTasks = [];
  lastStatus = "STOPPED";
  losePutResponse = racePromotion = false;
  account = p.account_id;
  mocks.aws.mockImplementation((args: string[], input?: string) => {
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    switch (args[1]) {
      case "get-caller-identity":
        return { Account: account };
      case "describe-services":
        return {
          services: [
            {
              status: "ACTIVE",
              desiredCount: running,
              runningCount: running,
              pendingCount: 0,
            },
          ],
        };
      case "list-tasks":
        return listTasks(args);
      case "describe-tasks":
        return { tasks: [{ lastStatus }] };
      case "get-secret-value":
        return readVersion(args);
      case "put-secret-value": {
        versions.set(value("--client-request-token"), input!);
        if (losePutResponse)
          throw new AwsError("COMMAND_FAILED", "put-secret-value");
        return {};
      }
      case "update-secret-version-stage":
        return promoteVersion(args);
      default:
        throw new Error("Unexpected AWS operation " + args[1]);
    }
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  mocks.aws.mockReset();
});

it.each(["gate", "session"])(
  "prepares, activates, retries and rolls back %s without exposing values",
  (name) => {
    rotateSecret(p, name, record, "prepare");
    const journal = JSON.parse(readFileSync(record, "utf8"));
    expect(current).toBe(original);
    expect(statSync(record).mode & 0o777).toBe(0o600);
    expect(journal.previousVersion).toBe(original);
    const next = versions.get(journal.nextVersion)!;
    expect(next).toHaveLength(name === "gate" ? 24 : 96);
    expect(readFileSync(record, "utf8")).not.toContain(next);
    expect(
      JSON.stringify(mocks.aws.mock.calls.map(([args]) => args)),
    ).not.toContain(next);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      next,
    );
    rotateSecret(p, name, record, "prepare");
    rotateSecret(p, name, record, "activate");
    rotateSecret(p, name, record, "activate");
    expect(current).toBe(journal.nextVersion);
    rotateSecret(p, name, record, "rollback");
    expect(current).toBe(original);
    expect(
      mocks.aws.mock.calls.filter(([args]) => args[1] === "put-secret-value"),
    ).toHaveLength(1);
    expect(
      mocks.aws.mock.calls.filter(
        ([args]) => args[1] === "update-secret-version-stage",
      ),
    ).toHaveLength(2);
  },
);

it("recovers a lost preparation response using the durable version token", () => {
  losePutResponse = true;
  expect(() => rotateSecret(p, "gate", record, "prepare")).toThrow(
    "COMMAND_FAILED",
  );
  const count = versions.size;
  rotateSecret(p, "gate", record, "prepare");
  expect(versions.size).toBe(count);
  expect(current).toBe(original);
  expect(
    mocks.aws.mock.calls.filter(([args]) => args[1] === "put-secret-value"),
  ).toHaveLength(1);
});

it("refuses active or still-provisioning web tasks before changing AWSCURRENT", () => {
  rotateSecret(p, "gate", record, "prepare");
  running = 1;
  expect(() => rotateSecret(p, "gate", record, "activate")).toThrow(
    "confirmed stopped",
  );
  running = 0;
  pendingTasks = ["provisioning-web-task"];
  expect(() => rotateSecret(p, "gate", record, "activate")).toThrow(
    "still exist",
  );
  expect(current).toBe(original);
});

it("rejects another rotation and a race at label promotion", () => {
  rotateSecret(p, "gate", record, "prepare");
  current = randomUUID();
  versions.set(current, randomBytes(18).toString("base64url"));
  expect(() => rotateSecret(p, "gate", record, "activate")).toThrow(
    "outside this rotation",
  );
  current = original;
  racePromotion = true;
  expect(() => rotateSecret(p, "gate", record, "activate")).toThrow(
    "InvalidParameterException",
  );
  expect(current).not.toBe(
    JSON.parse(readFileSync(record, "utf8")).nextVersion,
  );
});

it("refuses wrong account, other secret kinds and a mismatched journal", () => {
  account = "000000000000";
  expect(() => rotateSecret(p, "gate", record, "prepare")).toThrow(
    "account mismatch",
  );
  expect(mocks.aws).toHaveBeenCalledTimes(1);
  account = p.account_id;
  expect(() => rotateSecret(p, "runtime", record, "prepare")).toThrow(
    "Only gate/session",
  );
  writeFileSync(
    record,
    JSON.stringify({
      secretArn: "unrelated",
      previousVersion: original,
      nextVersion: randomUUID(),
    }),
  );
  expect(() => rotateSecret(p, "gate", record, "activate")).toThrow(
    "does not match",
  );
});

it("waits for actual STOPPED state when ECS has only requested shutdown", () => {
  rotateSecret(p, "gate", record, "prepare");
  stoppedTasks = ["draining-web-task"];
  lastStatus = "STOPPING";
  expect(() => rotateSecret(p, "gate", record, "activate")).toThrow(
    "shutdown is unconfirmed",
  );
  expect(current).toBe(original);
  lastStatus = "STOPPED";
  rotateSecret(p, "gate", record, "activate");
  expect(current).not.toBe(original);
});

it("rejects mismatched prepared content on retry and direct activation", () => {
  losePutResponse = true;
  expect(() => rotateSecret(p, "gate", record, "prepare")).toThrow(
    "COMMAND_FAILED",
  );
  const journal = JSON.parse(readFileSync(record, "utf8"));
  versions.set(journal.nextVersion, randomBytes(18).toString("base64url"));
  expect(() => rotateSecret(p, "gate", record, "prepare")).toThrow(
    "digest does not match",
  );
  expect(() => rotateSecret(p, "gate", record, "activate")).toThrow(
    "digest does not match",
  );
  expect(current).toBe(original);
});

it("does not invent replacement content when the recorded version is missing", () => {
  rotateSecret(p, "gate", record, "prepare");
  const journal = JSON.parse(readFileSync(record, "utf8"));
  versions = new Map([[original, versions.get(original)!]]);
  expect(() => rotateSecret(p, "gate", record, "prepare")).toThrow(
    "Prepared version is unavailable",
  );
  expect(versions.has(journal.nextVersion)).toBe(false);
  expect(
    mocks.aws.mock.calls.filter(([args]) => args[1] === "put-secret-value"),
  ).toHaveLength(1);
});
