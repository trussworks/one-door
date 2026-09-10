import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ aws: vi.fn(), exec: vi.fn() }));
vi.mock("../../scripts/deploy/aws.ts", async (original) => ({
  ...(await original<typeof import("../../scripts/deploy/aws.ts")>()),
  aws: mocked.aws,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: mocked.exec,
}));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));

import { AwsError } from "../../scripts/deploy/aws.ts";
import type { Platform } from "../../scripts/deploy/aws.ts";
import {
  applyRelease,
  confirmConvergence,
  enableRollbackAlarms,
  checkPrevious,
  publishAssets,
  publishRecord,
  healthyAlarm,
  requireNotificationActions,
  requireServingDefinitions,
} from "../../scripts/deploy/deploy-release.ts";
import { requireInitializationStopped } from "../../scripts/deploy/run-task.ts";
import { buildRecord } from "../../scripts/deploy/release-record.ts";
import { waitForServices } from "../../scripts/deploy/verify-release.ts";

const p = {
  account_id: "845191826742",
  cluster_arn: "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal",
  region: "us-west-2",
  name: "one-door-personal",
  assets_bucket: "one-door-assets-test",
  repository_url:
    "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal",
} as Platform;
const record = buildRecord({
  releaseId: "release-1",
  sourceRevision: "a".repeat(40),
  image: p.repository_url + "@sha256:" + "b".repeat(64),
  assetsManifestSha256: "c".repeat(64),
  migrationsDirectory: "migrations",
});

it("checks actual ECS state rather than trusting stopped Terraform settings", () => {
  const services = ["web", "worker"].map((name) => ({
    serviceName: "one-door-personal-" + name,
    status: "ACTIVE",
    desiredCount: 0,
    runningCount: 0,
    pendingCount: 0,
  }));
  let active: string[] = [];
  let draining = false;
  mocked.aws.mockImplementation((args: string[]) => {
    if (args[1] === "describe-services") return { services };
    if (args[1] === "list-tasks")
      return { taskArns: args.includes("RUNNING") ? active : ["stopped-task"] };
    return {
      tasks: [
        {
          taskArn: "stopped-task",
          lastStatus: draining ? "STOPPING" : "STOPPED",
        },
      ],
    };
  });
  expect(() => requireInitializationStopped(p)).not.toThrow();
  services[0].desiredCount = services[0].runningCount = 2;
  expect(() => requireInitializationStopped(p)).toThrow(
    "cannot stop a running application",
  );
  services[0].desiredCount = services[0].runningCount = 0;
  active = ["provisioning-task"];
  expect(() => requireInitializationStopped(p)).toThrow(
    "still running or provisioning",
  );
  active = [];
  draining = true;
  expect(() => requireInitializationStopped(p)).toThrow(
    "shutdown is incomplete",
  );
});

it("accepts genuinely absent first-install services but refuses unknown service failures", () => {
  let reason = "MISSING";
  mocked.aws.mockImplementation((args: string[]) =>
    args[1] === "describe-services"
      ? {
          services: [],
          failures: ["web", "worker"].map((name) => ({
            arn: "one-door-personal-" + name,
            reason,
          })),
        }
      : { taskArns: [] },
  );
  expect(() => requireInitializationStopped(p)).not.toThrow();
  reason = "UNKNOWN";
  expect(() => requireInitializationStopped(p)).toThrow(
    "could not be confirmed",
  );
});
const parent = path.resolve(".harness/deploy-record-tests");
mkdirSync(parent, { recursive: true });
function workspace() {
  return mkdtempSync(path.join(parent, "case-"));
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "confirms identical release records after a conditional create or existing-object race (%s)",
  (exists) => {
    const dir = workspace();
    const file = path.join(dir, "release.json");
    const bytes = JSON.stringify(record);
    writeFileSync(file, bytes);
    mocked.aws.mockImplementation((args: string[]) => {
      if (args[1] === "put-object" && exists)
        throw new AwsError("PreconditionFailed", "put-object");
      if (args[1] === "get-object") writeFileSync(args.at(-1)!, bytes);
      return {};
    });
    publishRecord(p, record, file, dir);
    expect(mocked.aws.mock.calls[0][0]).toContain("--if-none-match");
    expect(mocked.aws.mock.calls[0][0]).toContain("--checksum-sha256");
    expect(readFileSync(path.join(dir, "stored-release.json"), "utf8")).toBe(
      bytes,
    );
  },
);

it("refuses different stored record content and does not swallow access errors", () => {
  const dir = workspace();
  const file = path.join(dir, "release.json");
  writeFileSync(file, JSON.stringify(record));
  mocked.aws.mockImplementation((args: string[]) => {
    if (args[1] === "get-object")
      writeFileSync(args.at(-1)!, "different record");
    return {};
  });
  expect(() => publishRecord(p, record, file, dir)).toThrow(
    "Stored release record differs",
  );
  mocked.aws.mockImplementation(() => {
    throw new AwsError("AccessDeniedException", "put-object");
  });
  expect(() => publishRecord(p, record, file, dir)).toThrow(
    "AccessDeniedException",
  );
});

it("rejects a schema change before a rolling release", () => {
  const dir = workspace();
  mocked.aws.mockImplementation((args: string[]) => {
    if (args[1] === "describe-images")
      return { imageDetails: [{ imageTags: [record.releaseId] }] };
    writeFileSync(args.at(-1)!, JSON.stringify(record));
    return {};
  });
  const settings = { released_image: record.image } as Parameters<
    typeof checkPrevious
  >[1];
  expect(() => checkPrevious(p, settings, record, dir)).not.toThrow();
  const candidate = {
    ...record,
    migrations: { ...record.migrations, "9999_added.sql": "d".repeat(64) },
  };
  expect(() => checkPrevious(p, settings, candidate, dir)).toThrow(
    "Schema changes",
  );
  const changed = {
    ...record,
    jobContracts: {
      ...record.jobContracts,
      prompts: { ...record.jobContracts.prompts, intake: "changed" },
    },
  };
  expect(() => checkPrevious(p, settings, changed, dir)).toThrow(
    "Job contract changes",
  );
});

it("binds uploaded assets to the image, source revision and manifest digest", () => {
  const dir = workspace();
  vi.stubEnv("ONE_DOOR_AWS", "/pinned/aws");
  vi.stubEnv("ONE_DOOR_DOCKER", "/pinned/docker");
  mocked.exec.mockReturnValue(Buffer.from(""));
  let manifest = {
    manifestSha256: record.assetsManifestSha256,
    image: record.image,
    sourceRevision: record.sourceRevision,
  };
  mocked.aws.mockImplementation((args: string[]) => {
    writeFileSync(args.at(-1)!, JSON.stringify(manifest));
    return {};
  });
  expect(() => publishAssets(p, "platform.json", record, dir)).not.toThrow();
  for (const key of ["manifestSha256", "image", "sourceRevision"] as const) {
    const previous = manifest;
    manifest = { ...previous, [key]: "unrelated" };
    expect(() => publishAssets(p, "platform.json", record, dir)).toThrow();
    manifest = previous;
  }
});

it("waits for measured readiness with notification actions enabled", async () => {
  const states = ["ALARM", "INSUFFICIENT_DATA", "OK"];
  mocked.aws.mockImplementation(() => ({
    MetricAlarms: [{ StateValue: states.shift(), ActionsEnabled: true }],
  }));
  expect(await healthyAlarm(p)).toEqual({
    StateValue: "OK",
    ActionsEnabled: true,
  });
  expect(mocked.aws).toHaveBeenCalledTimes(3);
});

it("fails missing or persistently unhealthy readiness instead of enabling rollout alarms", async () => {
  mocked.aws.mockReturnValue({ MetricAlarms: [] });
  await expect(healthyAlarm(p)).rejects.toThrow("Readiness alarm is missing");
  mocked.aws.mockClear().mockReturnValue({
    MetricAlarms: [{ StateValue: "ALARM", ActionsEnabled: true }],
  });
  await expect(healthyAlarm(p)).rejects.toThrow("not healthy");
  expect(mocked.aws).toHaveBeenCalledTimes(20);
});

it("rejects silent readiness even when the alarm state is healthy", async () => {
  mocked.aws.mockReturnValue({
    MetricAlarms: [{ StateValue: "OK", ActionsEnabled: false }],
  });
  await expect(healthyAlarm(p)).rejects.toThrow(
    "notification actions are disabled",
  );
});

it("requires every application alarm to notify the expected topic", () => {
  const names =
    "readiness probe-missing ecs-api web-count worker-count queue-age worker-heartbeat worker-failures worker-poll-errors worker-queue-metrics database-storage database-memory database-connections deployment-failed".split(
      " ",
    );
  const topic = `arn:aws:sns:${p.region}:${p.account_id}:${p.name}-alerts`;
  const alarms = names.map((name) => ({
    AlarmName: p.name + "-" + name,
    ActionsEnabled: true,
    AlarmActions: [topic],
    OKActions: [topic],
  }));
  mocked.aws.mockReturnValue({ MetricAlarms: alarms });
  expect(() => requireNotificationActions(p)).not.toThrow();
  alarms[7].ActionsEnabled = false;
  expect(() => requireNotificationActions(p)).toThrow("disabled");
  alarms[7].ActionsEnabled = true;
  alarms[7].AlarmActions = [];
  expect(() => requireNotificationActions(p)).toThrow(
    "destination is unconfirmed",
  );
  alarms[7].AlarmActions = [topic];
  alarms[0].OKActions = [];
  expect(() => requireNotificationActions(p)).toThrow("recovery notification");
  alarms[0].OKActions = [topic];
  // A worker fault clears on its own, so its recovery must be reported too.
  alarms[9].OKActions = [];
  expect(() => requireNotificationActions(p)).toThrow("recovery notification");
  alarms[9].OKActions = [topic];
  // The database alarms and the failed-deployment alarm report faults only.
  alarms[10].OKActions = [];
  alarms[13].OKActions = [];
  expect(() => requireNotificationActions(p)).not.toThrow();
  alarms.pop();
  expect(() => requireNotificationActions(p)).toThrow("alarms are missing");
});

it("refuses stale serving pins or an overlapping deployment before preparation", () => {
  const expected = { web: "web:9", worker: "worker:9" };
  const services = (["web", "worker"] as const).map((name) => ({
    serviceName: p.name + "-" + name,
    taskDefinition: expected[name],
    deployments: [
      { taskDefinition: expected[name], rolloutState: "COMPLETED" },
    ],
  }));
  mocked.aws.mockReturnValue({ services });
  expect(() => requireServingDefinitions(p, expected)).not.toThrow();
  services[0].taskDefinition = "web:10";
  expect(() => requireServingDefinitions(p, expected)).toThrow(
    "changed since preflight",
  );
  services[0].taskDefinition = expected.web;
  services[0].deployments[0].rolloutState = "IN_PROGRESS";
  expect(() => requireServingDefinitions(p, expected)).toThrow("not complete");
  mocked.aws.mockReturnValue({ services: services.slice(0, 1) });
  expect(() => requireServingDefinitions(p, expected)).toThrow(
    "Both serving services",
  );
});

it("waits for completed rollouts using only the permitted service-read API", async () => {
  const complete = ["web", "worker"].map((name) => ({
    serviceName: p.name + "-" + name,
    status: "ACTIVE",
    desiredCount: 2,
    runningCount: 2,
    deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED" }],
  }));
  mocked.aws
    .mockReturnValueOnce({
      services: complete.map((service) => ({
        ...service,
        deployments: [{ status: "PRIMARY", rolloutState: "IN_PROGRESS" }],
      })),
    })
    .mockReturnValue({ services: complete });
  await waitForServices(p);
  expect(mocked.aws).toHaveBeenCalledTimes(2);
  for (const [args] of mocked.aws.mock.calls)
    expect(args.slice(0, 2)).toEqual(["ecs", "describe-services"]);
  mocked.aws.mockClear();
  mocked.aws.mockReturnValue({
    services: complete.map((service) => ({
      ...service,
      deployments: [{ status: "PRIMARY", rolloutState: "FAILED" }],
    })),
  });
  await expect(waitForServices(p)).rejects.toThrow("deployment failed");
  mocked.aws.mockReturnValue({ services: complete.slice(0, 1) });
  await expect(waitForServices(p)).rejects.toThrow("Both services");
  mocked.aws.mockReturnValue({
    services: complete,
    failures: [{ reason: "MISSING" }],
  });
  await expect(waitForServices(p)).rejects.toThrow("unconfirmed");
});

it("fails an uncompleted service rollout instead of treating healthy task counts as success", async () => {
  mocked.aws.mockReturnValue({
    services: ["web", "worker"].map((name) => ({
      serviceName: p.name + "-" + name,
      status: "ACTIVE",
      desiredCount: 2,
      runningCount: 2,
      deployments: [{ status: "PRIMARY", rolloutState: "IN_PROGRESS" }],
    })),
  });
  await expect(waitForServices(p)).rejects.toThrow("within 30 minutes");
  expect(mocked.aws).toHaveBeenCalledTimes(120);
});

it("refreshes task revisions after every apply, including the alarm update", () => {
  const directory = workspace();
  vi.stubEnv("ONE_DOOR_TERRAFORM", "/pinned/terraform");
  let revision = 4;
  mocked.exec.mockImplementation((_file: string, args: string[]) => {
    if (args[1] === "show") return JSON.stringify({ resource_changes: [] });
    if (args[1] === "apply") revision++;
    if (args[1] === "output")
      return JSON.stringify({ services: { web: "definition:" + revision } });
    return "";
  });
  const settings = { platform: p } as Parameters<typeof applyRelease>[0];
  applyRelease(settings, directory, "start");
  expect(
    JSON.parse(readFileSync(path.join(directory, "tasks.json"), "utf8"))
      .services.web,
  ).toBe("definition:5");
  applyRelease(settings, directory, "enable-rollback-alarms");
  expect(
    JSON.parse(readFileSync(path.join(directory, "tasks.json"), "utf8"))
      .services.web,
  ).toBe("definition:6");
});

it("requires a no-change plan after the final release configuration is applied", () => {
  vi.stubEnv("ONE_DOOR_TERRAFORM", "/pinned/terraform");
  let actions = ["no-op"];
  mocked.exec.mockImplementation((_file: string, args: string[]) =>
    args[1] === "show"
      ? JSON.stringify({ resource_changes: [{ change: { actions } }] })
      : "",
  );
  const applied = path.join(workspace(), "enable-rollback-alarms.tfvars.json");
  expect(() =>
    confirmConvergence(path.dirname(applied), applied),
  ).not.toThrow();
  actions = ["delete", "create"];
  expect(() => confirmConvergence(path.dirname(applied), applied)).toThrow(
    "not converged",
  );
});

it("plans convergence against the variable file the final apply wrote", () => {
  vi.stubEnv("ONE_DOOR_TERRAFORM", "/pinned/terraform");
  const directory = workspace();
  const settings = {
    platform: p,
    candidate_image: "image@sha256:" + "a".repeat(64),
    released_image: "image@sha256:" + "a".repeat(64),
    web_count: 2,
    worker_count: 2,
    deployment_alarms_enabled: true,
  } as Parameters<typeof applyRelease>[0];
  const planned: string[][] = [];
  mocked.exec.mockImplementation((_file: string, args: string[]) => {
    planned.push(args);
    if (args[1] === "show")
      return JSON.stringify({
        resource_changes: [{ change: { actions: ["no-op"] } }],
      });
    if (args[1] === "output")
      return JSON.stringify({ services: { web: "definition:1" } });
    return "";
  });
  const applied = applyRelease(settings, directory, "enable-rollback-alarms");
  expect(applied).toBe(
    path.join(directory, "enable-rollback-alarms.tfvars.json"),
  );
  planned.length = 0;
  confirmConvergence(directory, applied);
  expect(planned[0]).toContain("-var-file=" + applied);
});

it("observes a healthy alarm once, before it enables rollback protection", async () => {
  vi.stubEnv("ONE_DOOR_TERRAFORM", "/pinned/terraform");
  const order: string[] = [];
  mocked.aws.mockImplementation(() => {
    order.push("describe-alarms");
    return { MetricAlarms: [{ StateValue: "OK", ActionsEnabled: true }] };
  });
  mocked.exec.mockImplementation((_file: string, args: string[]) => {
    if (args[1] === "plan") order.push("terraform-plan");
    if (args[1] === "apply") order.push("terraform-apply");
    if (args[1] === "show")
      return JSON.stringify({
        resource_changes: [{ change: { actions: ["no-op"] } }],
      });
    if (args[1] === "output")
      return JSON.stringify({ services: { web: "definition:1" } });
    return "";
  });
  const directory = workspace();
  const running = {
    platform: p,
    candidate_image: "image@sha256:" + "a".repeat(64),
    released_image: "image@sha256:" + "a".repeat(64),
    web_count: 2,
    worker_count: 2,
    deployment_alarms_enabled: false,
  } as Parameters<typeof applyRelease>[0];

  const { alarm, appliedVariables } = await enableRollbackAlarms(
    running,
    directory,
  );

  expect(order.indexOf("describe-alarms")).toBeLessThan(
    order.indexOf("terraform-apply"),
  );
  expect(order.filter((step) => step === "describe-alarms")).toHaveLength(1);
  expect(alarm.ActionsEnabled).toBe(true);
  expect(running.deployment_alarms_enabled).toBe(false);
  expect(
    JSON.parse(readFileSync(appliedVariables, "utf8"))
      .deployment_alarms_enabled,
  ).toBe(true);
});
