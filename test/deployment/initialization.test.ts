import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  aws: vi.fn(),
  exec: vi.fn(),
  readPlatform: vi.fn(),
}));
vi.mock("../../scripts/deploy/aws.ts", async (original) => ({
  ...(await original<typeof import("../../scripts/deploy/aws.ts")>()),
  aws: mocked.aws,
  readPlatform: mocked.readPlatform,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: (file: string, args: string[]) => {
    if (file.endsWith("/aws")) return JSON.stringify(mocked.aws(args));
    // Assertions retain command arguments, never a copy of the caller's env.
    return mocked.exec(file, args);
  },
}));
import { initializeDeployment } from "../../scripts/deploy/initialize-deployment.ts";
import type { Platform } from "../../scripts/deploy/aws.ts";
import {
  buildRecord,
  type ReleaseRecord,
} from "../../scripts/deploy/release-record.ts";
import {
  requireInitialRelease,
  requireInitializationValues,
  startInstalledRelease,
} from "../../scripts/deploy/deploy-release.ts";

const p = {
  account_id: "845191826742",
  region: "us-west-2",
  environment: "personal",
  name: "one-door-personal",
  app_origin: "https://demo.cloudfront.net",
  assets_bucket: "one-door-assets-test",
  cluster_arn: "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal",
  repository_url:
    "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal",
} as Platform;
const values = {
  platform: p,
  candidate_image: p.repository_url + "@sha256:" + "a".repeat(64),
  web_count: 0,
  worker_count: 0,
  deployment_alarms_enabled: false,
};
const cleanScan: Record<string, unknown> = {
  "batch-get-image": {
    images: [
      {
        imageManifest: "{}",
        imageManifestMediaType: "application/vnd.oci.image.manifest.v1+json",
      },
    ],
  },
  wait: {},
  "describe-image-scan-findings": {
    imageScanStatus: { status: "COMPLETE" },
    imageScanFindings: {},
  },
};
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixture(state = "stopped", target = p) {
  mocked.readPlatform.mockReturnValue(target);
  vi.stubEnv("ONE_DOOR_TERRAFORM", "/unused/terraform");
  mocked.aws.mockImplementation((args: string[]) => {
    if (args[1] in cleanScan) return cleanScan[args[1]];
    if (args[1] === "get-caller-identity")
      return { Account: target.account_id };
    if (args[1] === "describe-services")
      return {
        services: ["web", "worker"].map((name) => ({
          serviceName: target.name + "-" + name,
          status: "ACTIVE",
          desiredCount: state === "active" ? 2 : 0,
          runningCount: state === "active" ? 2 : 0,
          pendingCount: 0,
        })),
      };
    if (args[1] === "list-tasks")
      return {
        taskArns:
          (state === "provisioning" && args.includes("RUNNING")) ||
          (state === "draining" && args.includes("STOPPED"))
            ? ["unfinished-task"]
            : [],
      };
    if (args[1] === "describe-tasks")
      return {
        tasks: [{ taskArn: "unfinished-task", lastStatus: "STOPPING" }],
      };
    throw new Error("Unexpected AWS operation");
  });
  const plan = {
    variables: Object.fromEntries(
      Object.entries({
        ...values,
        platform: target,
        candidate_image: target.repository_url + "@sha256:" + "a".repeat(64),
      }).map(([key, value]) => [key, { value }]),
    ),
    resource_changes: [],
    planned_values: {
      root_module: {
        resources: ["web", "worker"].map((name) => ({
          type: "aws_ecs_service",
          values: {
            name: target.name + "-" + name,
            desired_count: 0,
            cluster: target.cluster_arn,
          },
        })),
      },
    },
  };
  mocked.exec.mockReturnValue(JSON.stringify(plan));
  return plan;
}

it.each(["active", "provisioning", "draining"])(
  "refuses %s infrastructure before any first-install Terraform operation",
  (state) => {
    fixture(state);
    expect(() =>
      initializeDeployment(
        "platform.json",
        "plan",
        "not-read.json",
        "not-created.plan",
      ),
    ).toThrow();
    expect(mocked.exec).not.toHaveBeenCalled();
  },
);

it("checks actual stopped services around a validated first-install plan and apply", () => {
  fixture();
  const parent = path.resolve(".harness/initialization-tests");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "case-"));
  const input = path.join(directory, "values.json");
  writeFileSync(input, JSON.stringify(values));
  initializeDeployment(
    "platform.json",
    "plan",
    input,
    path.join(directory, "first.plan"),
  );
  expect(mocked.exec.mock.calls[0][1]).toContain("plan");
  initializeDeployment(
    "platform.json",
    "apply",
    path.join(directory, "first.plan"),
  );
  expect(mocked.exec.mock.calls.at(-1)?.[1]).toContain("apply");
  expect(
    mocked.aws.mock.calls.filter(([args]) => args[1] === "describe-services"),
  ).toHaveLength(4);
});

it("prepares and applies a stopped Truss installation without personal-account bindings", () => {
  const target = JSON.parse(
    JSON.stringify(p)
      .replaceAll("845191826742", "004351505091")
      .replaceAll("personal", "truss"),
  ) as Platform;
  const plan = fixture("stopped", target);
  const parent = path.resolve(".harness/initialization-tests");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "truss-"));
  const file = path.join(directory, "values.json");
  writeFileSync(
    file,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(plan.variables).map(([key, value]) => [
          key,
          value.value,
        ]),
      ),
    ),
  );
  initializeDeployment(
    "platform.json",
    "plan",
    file,
    path.join(directory, "truss.plan"),
  );
  initializeDeployment(
    "platform.json",
    "apply",
    path.join(directory, "truss.plan"),
  );
  expect(
    mocked.exec.mock.calls.some(([, args]) => args.includes("apply")),
  ).toBe(true);
});

it("refuses a saved plan whose rendered services start even if its variables claim zero", () => {
  const plan = fixture();
  plan.planned_values.root_module.resources[0].values.desired_count = 2;
  mocked.exec.mockReturnValue(JSON.stringify(plan));
  expect(() =>
    initializeDeployment("platform.json", "apply", "bad.plan"),
  ).toThrow("would start public tasks");
  expect(
    mocked.exec.mock.calls.some(([, args]) => args.includes("apply")),
  ).toBe(false);
});

it("rejects mismatched initialization inputs without echoing their values", () => {
  const control = randomBytes(24).toString("hex");
  let message = "";
  try {
    requireInitializationValues(
      { ...values, platform: { ...p, cluster_arn: control } },
      p,
    );
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("cluster differs");
  expect(message).not.toContain(control);
  expect(() =>
    requireInitializationValues({ ...values, web_count: 2 }, p),
  ).toThrow("keep web tasks stopped");
  expect(() =>
    requireInitializationValues({ ...values, serving_task_definitions: {} }, p),
  ).toThrow("cannot carry");
  expect(() =>
    requireInitializationValues(
      { ...values, deployment_alarms_enabled: true },
      p,
    ),
  ).toThrow("leave deployment alarms unarmed");
});

it.each(["plan", "apply"])(
  "blocks initial %s before creating task definitions when the image scan fails",
  (action) => {
    fixture();
    const normal = mocked.aws.getMockImplementation()!;
    mocked.aws.mockImplementation((args: string[]) =>
      args[1] === "describe-image-scan-findings"
        ? {
            imageScanStatus: { status: "COMPLETE" },
            imageScanFindings: { findingSeverityCounts: { HIGH: 1 } },
          }
        : normal(args),
    );
    const parent = path.resolve(".harness/initialization-tests");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(path.join(parent, "initial-scan-"));
    const input = path.join(directory, "input.json");
    writeFileSync(input, JSON.stringify(values));
    expect(() =>
      initializeDeployment(
        "platform.json",
        action,
        input,
        path.join(directory, "initial.plan"),
      ),
    ).toThrow("High image findings block release");
    expect(
      mocked.exec.mock.calls.some(([, args]) =>
        ["plan", "apply"].includes(args[1]),
      ),
    ).toBe(false);
  },
);

it("starts only the prepared image and platform with stopped, unpinned services", () => {
  const settings = { ...values, released_image: "" };
  expect(() =>
    requireInitialRelease(settings, p, values.candidate_image),
  ).not.toThrow();
  for (const change of [
    { web_count: 2 },
    { worker_count: 2 },
    { platform: { ...p, account_id: "004351505091" } },
    { candidate_image: "another-image" },
    { released_image: "another-image" },
    { serving_task_definitions: { web: "old", worker: "old" } },
    { deployment_alarms_enabled: true },
  ]) {
    expect(() =>
      requireInitialRelease(
        { ...settings, ...change },
        p,
        values.candidate_image,
      ),
    ).toThrow();
  }
});

it("accepts Terraform's platform projection while refusing changed retained fields or an empty identity", () => {
  const projected = Object.fromEntries(
    Object.entries(p).filter(([name]) => name !== "assets_bucket"),
  ) as Platform;
  const settings = { ...values, platform: projected, released_image: "" };
  expect(() =>
    requireInitialRelease(settings, p, values.candidate_image),
  ).not.toThrow();
  expect(() =>
    requireInitialRelease(
      {
        ...settings,
        platform: { ...projected, app_origin: "https://wrong.cloudfront.net" },
      },
      p,
      values.candidate_image,
    ),
  ).toThrow("platform differs");
  expect(() =>
    requireInitialRelease(
      { ...settings, platform: {} as Platform },
      p,
      values.candidate_image,
    ),
  ).toThrow("account differs");
});

function mockStartAWS(
  record: ReleaseRecord,
  stoppedAWS: (args: string[]) => unknown,
) {
  const topic = `arn:aws:sns:${p.region}:${p.account_id}:${p.name}-alerts`;
  const alarmNames =
    "readiness probe-missing ecs-api web-count worker-count queue-age worker-heartbeat worker-failures worker-poll-errors worker-queue-metrics database-storage database-memory database-connections deployment-failed".split(
      " ",
    );
  mocked.aws.mockImplementation((args: string[]) => {
    if (args[1] === "get-login-password") return "test-token";
    if (args[1] === "describe-alarms")
      return {
        MetricAlarms: alarmNames
          .map((name) => ({
            AlarmName: p.name + "-" + name,
            StateValue: "OK",
            ActionsEnabled: true,
            AlarmActions: [topic],
            OKActions: [topic],
          }))
          .filter(
            (alarm) =>
              args.includes("--alarm-name-prefix") ||
              args.includes(alarm.AlarmName),
          ),
      };
    if (args[1] === "describe-key")
      return {
        KeyMetadata: {
          Arn: `arn:aws:kms:${p.region}:${p.account_id}:key/test`,
        },
      };
    if (args[1] === "put-object") return {};
    if (args[1] === "get-object") {
      const content = args.includes(
        `release-records/${record.releaseId}/assets.json`,
      )
        ? {
            manifestSha256: record.assetsManifestSha256,
            image: record.image,
            sourceRevision: record.sourceRevision,
          }
        : record;
      writeFileSync(args.at(-1)!, JSON.stringify(content));
      return {};
    }
    if (args[1] === "describe-services" && args.at(-1) === p.name + "-web")
      return {
        services: [
          {
            deploymentConfiguration: {
              alarms: {
                enable: true,
                rollback: true,
                alarmNames: [p.name + "-readiness"],
              },
            },
          },
        ],
      };
    return stoppedAWS(args);
  });
}

function startFixture(failVerification: boolean) {
  fixture();
  const stoppedAWS = mocked.aws.getMockImplementation()!;
  const parent = path.resolve(".harness/initialization-tests");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "start-"));
  const record = buildRecord({
    releaseId: "rehearsal-1",
    sourceRevision: "a".repeat(40),
    image: values.candidate_image,
    assetsManifestSha256: "b".repeat(64),
    migrationsDirectory: "migrations",
  });
  const file = path.join(directory, "release.json");
  writeFileSync(file, JSON.stringify(record));
  const order: string[] = [];
  mockStartAWS(record, stoppedAWS);
  vi.stubEnv("ONE_DOOR_AWS", "/unused/aws");
  vi.stubEnv("ONE_DOOR_DOCKER", "/unused/docker");
  mocked.exec.mockImplementation((file: string, args: string[]) => {
    if (file === "/unused/terraform") {
      if (args[1] === "output")
        return JSON.stringify(
          args.includes("tasks")
            ? {}
            : { settings: { value: { ...values, released_image: "" } } },
        );
      if (args[1] === "show") return JSON.stringify({ resource_changes: [] });
      if (args[1] === "apply") order.push(path.basename(args.at(-1)!));
    }
    if (args[1] === "scripts/deploy/run-task.ts") {
      order.push(args[4]);
      if (failVerification && args[4] === "verification")
        throw new Error("Database verification failed");
    }
    if (args[1] === "scripts/deploy/verify-release.ts")
      order.push("verify-release");
    return "";
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toBe(p.app_origin + "/api/health");
      order.push("public-health");
      return { status: 200, json: async () => ({ status: "ok" }) };
    }),
  );
  return { directory, record, file, order };
}

it.each([false, true])(
  "runs database checks before first start and reports success only after public verification (database failure: %s)",
  async (failVerification) => {
    const { directory, record, file, order } = startFixture(failVerification);
    const result = startInstalledRelease(
      "platform.json",
      file,
      directory,
      record.sourceRevision,
    );
    if (failVerification) {
      await expect(result).rejects.toThrow("Database verification failed");
      expect(order).toEqual([
        "prepare.plan",
        "migration",
        "fixture-upgrade",
        "verification",
      ]);
      expect(existsSync(path.join(directory, "result.json"))).toBe(false);
      return;
    }
    await result;
    expect(order).toEqual([
      "prepare.plan",
      "migration",
      "fixture-upgrade",
      "verification",
      "start.plan",
      "verify-release",
      "public-health",
      "enable-rollback-alarms.plan",
      "verify-release",
    ]);
    expect(
      JSON.parse(
        readFileSync(path.join(directory, "start.tfvars.json"), "utf8"),
      ),
    ).toMatchObject({
      web_count: 2,
      worker_count: 2,
      deployment_alarms_enabled: false,
      serving_task_definitions: null,
    });
    expect(
      JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8")),
    ).toMatchObject({
      ready: true,
      deploymentRollbackAlarmsEnabled: true,
      hostedAcceptance: "pending",
    });
  },
);

it.each(["active", "provisioning", "draining"])(
  "refuses a first start against %s services before any Terraform operation",
  async (state) => {
    const { directory, record, file } = startFixture(false);
    fixture(state);
    await expect(
      startInstalledRelease(
        "platform.json",
        file,
        directory,
        record.sourceRevision,
      ),
    ).rejects.toThrow();
    expect(mocked.exec).not.toHaveBeenCalled();
  },
);

it("refuses to advance an installation when the destination scan reports a high finding", async () => {
  const { directory, record, file, order } = startFixture(false);
  const normal = mocked.aws.getMockImplementation()!;
  mocked.aws.mockImplementation((args: string[]) =>
    args[1] === "describe-image-scan-findings"
      ? {
          imageScanStatus: { status: "COMPLETE" },
          imageScanFindings: { findingSeverityCounts: { HIGH: 1 } },
        }
      : normal(args),
  );
  await expect(
    startInstalledRelease(
      "platform.json",
      file,
      directory,
      record.sourceRevision,
    ),
  ).rejects.toThrow("High image findings block release");
  expect(order).toEqual([]);
  expect(
    JSON.parse(readFileSync(path.join(directory, "scans.json"), "utf8"))[0]
      .imageScanFindings.findingSeverityCounts.HIGH,
  ).toBe(1);
  expect(existsSync(path.join(directory, "result.json"))).toBe(false);
});
