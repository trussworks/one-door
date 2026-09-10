import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import {
  aws,
  AwsError,
  readPlatform,
  requireAccount,
  resolveTool,
} from "./aws.ts";
import { isMain } from "../is-main.mjs";
import type { Platform } from "./aws.ts";
import { compareRecords } from "./release-record.ts";
import type { ReleaseRecord } from "./release-record.ts";
import { requireReleaseInputs } from "./upload-assets.ts";
import { parseImageReference } from "./verify-release.ts";
import { requireInitializationStopped } from "./run-task.ts";
import { checkImageScan } from "./check-image-scan.ts";

interface Settings {
  platform: Platform;
  candidate_image: string;
  released_image: string;
  web_count: number;
  worker_count: number;
  deployment_alarms_enabled: boolean;
  serving_task_definitions?: { web: string; worker: string } | null;
}

interface Change {
  address: string;
  type: string;
  change: {
    actions: string[];
    before?: { skip_destroy?: boolean } | null;
    after: { skip_destroy?: boolean } | null;
  };
}

interface ReleaseInput {
  platformFile: string;
  recordFile: string;
  directory: string;
  sourceRevision: string;
}

export function deploy(
  platformFile: string,
  recordFile: string,
  directory: string,
  sourceRevision: string,
): Promise<void> {
  return release(
    { platformFile, recordFile, directory, sourceRevision },
    false,
  );
}

export function startInstalledRelease(
  platformFile: string,
  recordFile: string,
  directory: string,
  sourceRevision: string,
): Promise<void> {
  return release({ platformFile, recordFile, directory, sourceRevision }, true);
}

function readReleaseInput(input: ReleaseInput) {
  assert.match(
    input.sourceRevision,
    /^[0-9a-f]{40}$/,
    "Use a full source revision; first installation requires the operator install procedure",
  );
  const p = readPlatform(input.platformFile);
  const record = JSON.parse(
    readFileSync(input.recordFile, "utf8"),
  ) as ReleaseRecord;
  assert.equal(
    record.sourceRevision,
    input.sourceRevision,
    "The release record does not match the independently selected source revision",
  );
  requireReleaseInputs(p.repository_url, record.image, record.releaseId);
  return { p, record };
}

export function requireInitializationValues(
  values: Record<string, unknown>,
  p: Platform,
): void {
  assert.ok(values.web_count === 0, "Installation must keep web tasks stopped");
  assert.ok(
    values.worker_count === 0,
    "Installation must keep workers stopped",
  );
  assert.ok(
    values.serving_task_definitions == null,
    "Installation cannot carry serving revision pins",
  );
  assert.equal(
    values.deployment_alarms_enabled,
    false,
    "Installation must leave deployment alarms unarmed until readiness is proven",
  );
  const incoming = values.platform as Record<string, unknown>;
  assert.ok(
    incoming && typeof incoming === "object",
    "Installation platform is missing",
  );
  assert.ok(
    incoming.account_id === p.account_id,
    "Installation account differs",
  );
  assert.ok(
    incoming.cluster_arn === p.cluster_arn,
    "Installation cluster differs",
  );
  for (const [name, value] of Object.entries(incoming))
    assert.ok(
      isDeepStrictEqual(value, (p as unknown as Record<string, unknown>)[name]),
      "Installation platform differs from the supplied platform output",
    );
  assert.equal(typeof values.candidate_image, "string");
  assert.equal(
    parseImageReference(values.candidate_image as string).repository,
    p.repository_url,
  );
  assert.ok(
    !values.released_image || values.released_image === values.candidate_image,
    "Installation image identities differ",
  );
}

export function requireInitialRelease(
  settings: Settings,
  p: Platform,
  image: string,
): void {
  // Terraform retains only the platform fields its object type declares.
  requireInitializationValues({ ...settings }, p);
  assert.equal(
    settings.candidate_image,
    image,
    "Initial start image differs from the prepared installation",
  );
}

async function release(input: ReleaseInput, initial: boolean): Promise<void> {
  const { recordFile, directory } = input;
  const { p, record } = readReleaseInput(input);
  requireAccount(p);
  if (initial) requireInitializationStopped(p);
  requireNotificationActions(p);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const platformFile = path.join(directory, "platform.json");
  writeJson(platformFile, p);
  initializeBackend(p, directory);
  const previous = releaseSettings(
    JSON.parse(terraform(["output", "-json"], true)),
  );
  if (initial) {
    requireInitialRelease(previous, p, record.image);
  } else {
    requireRunningRelease(previous);
    verifyCurrent({ ...previous, platform: p }, platformFile, directory);
    checkPrevious(p, previous, record, directory);
  }
  checkImageScan(
    p.repository_url,
    p.region,
    parseImageReference(record.image).digest,
    path.join(directory, "scans.json"),
  );
  publishAssets(p, platformFile, record, directory);
  publishRecord(p, record, recordFile, directory);
  const prepared: Settings = {
    ...previous,
    platform: p,
    candidate_image: record.image,
    serving_task_definitions: initial
      ? null
      : JSON.parse(
          readFileSync(path.join(directory, "current-tasks.json"), "utf8"),
        ).services,
  };
  if (initial) requireInitializationStopped(p);
  applyRelease(prepared, directory, "prepare");
  const tasks = path.join(directory, "tasks.json");
  runReleaseJobs(platformFile, tasks, record);
  if (initial) requireInitializationStopped(p);
  const running: Settings = {
    ...prepared,
    released_image: record.image,
    web_count: 2,
    worker_count: 2,
    serving_task_definitions: null,
  };
  applyRelease(running, directory, "start");
  await finishRelease(running, platformFile, directory, record);
}

async function finishRelease(
  running: Settings,
  platformFile: string,
  directory: string,
  record: ReleaseRecord,
): Promise<void> {
  const p = running.platform;
  const tasks = path.join(directory, "tasks.json");
  run("verify-release", [platformFile, tasks, record.image, "2", "2"]);
  await confirmPublicReadiness(p);
  const { alarm, appliedVariables } = await enableRollbackAlarms(
    running,
    directory,
  );
  run("verify-release", [platformFile, tasks, record.image, "2", "2"]);
  completeRelease({ p, record, directory, alarm, appliedVariables });
}

function runReleaseJobs(
  platformFile: string,
  tasks: string,
  record: ReleaseRecord,
): void {
  const jobs = ["migration", "fixture-upgrade", "verification"];
  for (const job of jobs)
    run("run-task", [platformFile, tasks, job, record.releaseId + "-" + job]);
}

export function requireSafePlan(
  changes: Change[],
  preserveServices = false,
): void {
  for (const resource of changes) {
    const { actions } = resource.change;
    if (actions.length === 0)
      throw new Error("Release plan has no confirmed action");
    if (actions.every((action) => action === "no-op")) continue;
    if (preserveServices && resource.type === "aws_ecs_service")
      throw new Error(
        "Candidate preparation cannot change a serving service: " +
          resource.address,
      );
    if (!["aws_ecs_service", "aws_ecs_task_definition"].includes(resource.type))
      throw new Error(
        "Release plan changes an unexpected resource: " + resource.address,
      );
    if (actions.includes("delete") && !retainsDefinition(resource))
      throw new Error(
        "Release plan would remove a resource: " + resource.address,
      );
  }
}

function retainsDefinition(resource: Change): boolean {
  return (
    resource.type === "aws_ecs_task_definition" &&
    resource.change.actions.includes("create") &&
    resource.change.before?.skip_destroy === true &&
    resource.change.after?.skip_destroy === true
  );
}

export function requireRunningRelease(settings: Settings): void {
  if (settings.web_count !== 2 || settings.worker_count !== 2)
    throw new Error(
      "A rolling release requires two web tasks and two workers; installation is an operator procedure",
    );
}

export function releaseSettings(
  outputs: Record<string, { value: Settings }>,
): Settings {
  assert.ok(
    Object.keys(outputs).length > 0,
    "An empty release state requires operator installation",
  );
  assert.ok(
    outputs.settings?.value,
    "Existing release state has no settings output",
  );
  return outputs.settings.value;
}

function terraform(args: string[], capture = false): string {
  return (
    execFileSync(resolveTool("terraform"), ["-chdir=infra/release", ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    }) ?? ""
  );
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export function applyRelease(
  settings: Settings,
  directory: string,
  phase: string,
): string {
  const variables = path.join(directory, phase + ".tfvars.json");
  const plan = path.join(directory, phase + ".plan");
  if (settings.serving_task_definitions)
    requireServingDefinitions(
      settings.platform,
      settings.serving_task_definitions,
    );
  writeJson(variables, settings);
  terraform(["plan", "-input=false", "-var-file=" + variables, "-out=" + plan]);
  const result = JSON.parse(terraform(["show", "-json", plan], true));
  requireSafePlan(
    result.resource_changes ?? [],
    Boolean(settings.serving_task_definitions),
  );
  if (settings.serving_task_definitions)
    requireServingDefinitions(
      settings.platform,
      settings.serving_task_definitions,
    );
  terraform(["apply", "-input=false", plan]);
  writeJson(
    path.join(directory, "tasks.json"),
    JSON.parse(terraform(["output", "-json", "tasks"], true)),
  );
  return variables;
}

export function requireServingDefinitions(
  p: Platform,
  expected: { web: string; worker: string },
): void {
  const names = [p.name + "-web", p.name + "-worker"];
  const response = aws<{
    services: Array<{
      serviceName: string;
      taskDefinition: string;
      deployments: Array<{ taskDefinition: string; rolloutState: string }>;
    }>;
    failures?: unknown[];
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
  assert.equal(
    response.failures?.length ?? 0,
    0,
    "Serving revisions could not be confirmed",
  );
  assert.deepEqual(
    response.services.map((service) => service.serviceName).sort(),
    [...names].sort(),
    "Both serving services must be confirmed",
  );
  for (const name of ["web", "worker"] as const) {
    const service = response.services.find(
      (row) => row.serviceName === p.name + "-" + name,
    )!;
    assert.equal(
      service.taskDefinition,
      expected[name],
      "Serving revision changed since preflight; no prepare apply is safe",
    );
    assert.equal(
      service.deployments.length,
      1,
      "A deployment is already in progress",
    );
    assert.equal(
      service.deployments[0].rolloutState,
      "COMPLETED",
      "Serving deployment is not complete",
    );
    assert.equal(
      service.deployments[0].taskDefinition,
      expected[name],
      "Serving deployment changed since preflight",
    );
  }
}

export function confirmConvergence(
  directory: string,
  appliedVariables: string,
): void {
  const plan = path.join(directory, "convergence.plan");
  terraform([
    "plan",
    "-input=false",
    "-var-file=" + appliedVariables,
    "-out=" + plan,
  ]);
  const result = JSON.parse(terraform(["show", "-json", plan], true));
  assert.ok(
    (result.resource_changes ?? []).every(
      (resource: Change) =>
        resource.change.actions.length > 0 &&
        resource.change.actions.every((action) => action === "no-op"),
    ),
    "The applied release still has changes; configuration has not converged",
  );
}

function run(script: string, args: string[]): void {
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/deploy/" + script + ".ts", ...args],
    { stdio: "inherit" },
  );
}

function verifyCurrent(
  settings: Settings,
  platformFile: string,
  directory: string,
): void {
  const tasks = path.join(directory, "current-tasks.json");
  writeFileSync(tasks, terraform(["output", "-json", "tasks"], true), {
    mode: 0o600,
  });
  run("verify-release", [
    platformFile,
    tasks,
    settings.released_image,
    "2",
    "2",
  ]);
}

function initializeBackend(p: Platform, directory: string): void {
  const key = aws<{ KeyMetadata: { Arn: string } }>([
    "kms",
    "describe-key",
    "--region",
    p.region,
    "--key-id",
    `alias/${p.name}-state`,
  ]).KeyMetadata.Arn;
  assert.ok(key.startsWith(`arn:aws:kms:${p.region}:${p.account_id}:key/`));
  const backend = path.join(directory, "release.backend.hcl");
  const values = {
    bucket: `one-door-state-${p.account_id}-${p.region}`,
    key: "release/terraform.tfstate",
    region: p.region,
    kms_key_id: key,
    encrypt: true,
    use_lockfile: true,
    allowed_account_ids: [p.account_id],
  };
  writeFileSync(
    backend,
    Object.entries(values)
      .map(([name, value]) => name + " = " + JSON.stringify(value))
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  terraform([
    "init",
    "-input=false",
    "-reconfigure",
    "-lockfile=readonly",
    "-backend-config=" + backend,
  ]);
}

export function checkPrevious(
  p: Platform,
  settings: Settings,
  record: ReleaseRecord,
  directory: string,
): void {
  const digest = parseImageReference(settings.released_image).digest;
  const details = aws<{ imageDetails: Array<{ imageTags?: string[] }> }>([
    "ecr",
    "describe-images",
    "--region",
    p.region,
    "--repository-name",
    p.name,
    "--image-ids",
    "imageDigest=" + digest,
  ]).imageDetails;
  assert.equal(details.length, 1);
  assert.equal(
    details[0].imageTags?.length,
    1,
    "Previous release must have one immutable tag",
  );
  const releaseId = details[0].imageTags![0];
  requireReleaseInputs(p.repository_url, settings.released_image, releaseId);
  const file = path.join(directory, "previous-release.json");
  aws([
    "s3api",
    "get-object",
    "--region",
    p.region,
    "--bucket",
    p.assets_bucket,
    "--key",
    `release-records/${releaseId}/release.json`,
    file,
  ]);
  const previous = JSON.parse(readFileSync(file, "utf8")) as ReleaseRecord;
  assert.equal(previous.image, settings.released_image);
  assert.equal(
    compareRecords(previous, record).decision,
    "rolling",
    "Job contract changes need a controlled maintenance release",
  );
  assert.deepEqual(
    record.migrations,
    previous.migrations,
    "Schema changes need a separately verified maintenance release",
  );
}

export function publishRecord(
  p: Platform,
  record: ReleaseRecord,
  file: string,
  directory: string,
): void {
  const key = `release-records/${record.releaseId}/release.json`;
  const expected = readFileSync(file);
  try {
    aws([
      "s3api",
      "put-object",
      "--region",
      p.region,
      "--bucket",
      p.assets_bucket,
      "--key",
      key,
      "--body",
      file,
      "--if-none-match",
      "*",
      "--content-type",
      "application/json",
      "--checksum-sha256",
      createHash("sha256").update(expected).digest("base64"),
    ]);
  } catch (error) {
    if (!(error instanceof AwsError) || error.code !== "PreconditionFailed")
      throw error;
  }
  const stored = path.join(directory, "stored-release.json");
  aws([
    "s3api",
    "get-object",
    "--region",
    p.region,
    "--bucket",
    p.assets_bucket,
    "--key",
    key,
    stored,
  ]);
  assert.ok(
    readFileSync(stored).equals(expected),
    "Stored release record differs; no service should advance",
  );
}

export function publishAssets(
  p: Platform,
  platformFile: string,
  record: ReleaseRecord,
  directory: string,
): void {
  const token = execFileSync(
    resolveTool("aws"),
    ["ecr", "get-login-password", "--region", p.region],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  execFileSync(
    resolveTool("docker"),
    [
      "login",
      "--username",
      "AWS",
      "--password-stdin",
      p.repository_url.split("/")[0],
    ],
    { input: token, stdio: ["pipe", "inherit", "inherit"] },
  );
  execFileSync(
    resolveTool("docker"),
    ["pull", "--platform", "linux/amd64", record.image],
    { stdio: "inherit" },
  );
  run("upload-assets", [platformFile, record.image, record.releaseId]);
  const file = path.join(directory, "stored-assets.json");
  aws([
    "s3api",
    "get-object",
    "--region",
    p.region,
    "--bucket",
    p.assets_bucket,
    "--key",
    `release-records/${record.releaseId}/assets.json`,
    file,
  ]);
  const assets = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(assets.manifestSha256, record.assetsManifestSha256);
  assert.equal(assets.image, record.image);
  assert.equal(assets.sourceRevision, record.sourceRevision);
}

async function confirmPublicReadiness(p: Platform): Promise<void> {
  const response = await fetch(p.app_origin + "/api/health", {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, "Public HTTPS readiness failed");
  assert.equal((await response.json()).status, "ok");
}

/**
 * The alarm must already read OK before rollback protection is enabled, and
 * that one observation is the value reported afterwards: a second poll could
 * see a different state from the one the release was accepted against.
 */
export async function enableRollbackAlarms(
  running: Settings,
  directory: string,
): Promise<{ alarm: { ActionsEnabled: boolean }; appliedVariables: string }> {
  const alarm = await healthyAlarm(running.platform);
  const alarmed: Settings = { ...running, deployment_alarms_enabled: true };
  return {
    alarm,
    appliedVariables: applyRelease(
      alarmed,
      directory,
      "enable-rollback-alarms",
    ),
  };
}

function requireRollbackAlarmWiring(p: Platform): void {
  const service = aws<{
    services: Array<{
      deploymentConfiguration: {
        alarms: { enable: boolean; rollback: boolean; alarmNames: string[] };
      };
    }>;
  }>([
    "ecs",
    "describe-services",
    "--region",
    p.region,
    "--cluster",
    p.cluster_arn,
    "--services",
    p.name + "-web",
  ]).services[0];
  assert.equal(service.deploymentConfiguration.alarms.enable, true);
  assert.equal(service.deploymentConfiguration.alarms.rollback, true);
  assert.deepEqual(service.deploymentConfiguration.alarms.alarmNames, [
    p.name + "-readiness",
  ]);
}

function completeRelease(input: {
  p: Platform;
  record: ReleaseRecord;
  directory: string;
  alarm: { ActionsEnabled: boolean };
  appliedVariables: string;
}): void {
  const { p, record, directory, alarm } = input;
  requireRollbackAlarmWiring(p);
  requireNotificationActions(p);
  confirmConvergence(directory, input.appliedVariables);
  writeJson(path.join(directory, "result.json"), {
    origin: p.app_origin,
    release: record.releaseId,
    image: record.image,
    ready: true,
    deploymentRollbackAlarmsEnabled: true,
    notificationActionsEnabled: alarm.ActionsEnabled,
    workerProgressVerified: true,
    hostedAcceptance: "pending",
  });
  console.log("Public release verified:", p.app_origin);
}

export async function healthyAlarm(
  p: Platform,
): Promise<{ ActionsEnabled: boolean }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const alarms = aws<{
      MetricAlarms: Array<{ StateValue: string; ActionsEnabled: boolean }>;
    }>([
      "cloudwatch",
      "describe-alarms",
      "--region",
      p.region,
      "--alarm-names",
      p.name + "-readiness",
    ]).MetricAlarms;
    assert.equal(alarms.length, 1, "Readiness alarm is missing");
    assert.equal(
      alarms[0].ActionsEnabled,
      true,
      "Readiness alarm notification actions are disabled",
    );
    if (alarms[0].StateValue === "OK") return alarms[0];
    await delay(30_000);
  }
  throw new Error(
    "Readiness alarm is not healthy; rollout protection remains unconfirmed",
  );
}

export function requireNotificationActions(p: Platform): void {
  const expected = [
    "readiness",
    "probe-missing",
    "ecs-api",
    "web-count",
    "worker-count",
    "queue-age",
    "worker-heartbeat",
    "worker-failures",
    "worker-poll-errors",
    "worker-queue-metrics",
    "database-storage",
    "database-memory",
    "database-connections",
    "deployment-failed",
  ].map((suffix) => p.name + "-" + suffix);
  const alarms = aws<{
    MetricAlarms: Array<{
      AlarmName: string;
      ActionsEnabled: boolean;
      AlarmActions: string[];
      OKActions: string[];
    }>;
  }>([
    "cloudwatch",
    "describe-alarms",
    "--region",
    p.region,
    "--alarm-name-prefix",
    p.name + "-",
  ]).MetricAlarms;
  assert.ok(
    expected.every((name) => alarms.some((alarm) => alarm.AlarmName === name)),
    "Application notification alarms are missing",
  );
  // A worker fault clears on its own once the database answers again, so the
  // recipient has to be told about the recovery as well as the fault.
  const recoveryNotified = [
    "readiness",
    "probe-missing",
    "ecs-api",
    "web-count",
    "worker-count",
    "queue-age",
    "worker-heartbeat",
    "worker-failures",
    "worker-poll-errors",
    "worker-queue-metrics",
  ].map((suffix) => p.name + "-" + suffix);
  const topic = `arn:aws:sns:${p.region}:${p.account_id}:${p.name}-alerts`;
  for (const alarm of alarms) {
    assert.equal(
      alarm.ActionsEnabled,
      true,
      "Notification actions are disabled: " + alarm.AlarmName,
    );
    assert.deepEqual(
      alarm.AlarmActions,
      [topic],
      "Alarm notification destination is unconfirmed: " + alarm.AlarmName,
    );
    if (recoveryNotified.includes(alarm.AlarmName))
      assert.deepEqual(
        alarm.OKActions,
        [topic],
        "Alarm recovery notification destination is unconfirmed: " +
          alarm.AlarmName,
      );
  }
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const [platform, record, directory, sourceRevision] = args;
  if (
    args.length !== 4 ||
    !platform ||
    !record ||
    !directory ||
    !sourceRevision
  )
    throw new Error(
      "Usage: deploy-release.ts PLATFORM_JSON RELEASE_JSON PRIVATE_DIRECTORY SOURCE_REVISION",
    );
  await deploy(platform, record, path.resolve(directory), sourceRevision);
}
