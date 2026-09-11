import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMain } from "../is-main.mjs";
import { aws, AwsError, readPlatform, requireAccount } from "./aws.ts";
import type { Platform } from "./aws.ts";
import { describeTaskBatches, listDrainingTasks } from "./run-task.ts";

interface Rotation {
  secretArn: string;
  previousVersion: string;
  nextVersion: string;
  nextSha256: string;
}

function getVersion(p: Platform, arn: string, versionId?: string) {
  return aws<{ VersionId: string; SecretString: string }>([
    "secretsmanager",
    "get-secret-value",
    "--region",
    p.region,
    "--secret-id",
    arn,
    ...(versionId
      ? ["--version-id", versionId]
      : ["--version-stage", "AWSCURRENT"]),
  ]);
}

function requireWebStopped(p: Platform): void {
  const response = aws<{
    failures?: unknown[];
    services: Array<{
      desiredCount: number;
      runningCount: number;
      pendingCount: number;
      status: string;
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
  ]);
  const service = response.services[0];
  if (
    response.failures?.length ||
    response.services?.length !== 1 ||
    service?.status !== "ACTIVE" ||
    [service.desiredCount, service.runningCount, service.pendingCount].some(
      (count) => count !== 0,
    )
  )
    throw new Error(
      "Web service must be confirmed stopped before changing a login secret",
    );
  // desiredStatus RUNNING also finds tasks that are still provisioning.
  const tasks = aws<{ taskArns: string[] }>([
    "ecs",
    "list-tasks",
    "--region",
    p.region,
    "--cluster",
    p.cluster_arn,
    "--family",
    p.name + "-web",
    "--desired-status",
    "RUNNING",
  ]);
  if (!Array.isArray(tasks.taskArns) || tasks.taskArns.length !== 0)
    throw new Error(
      "Web tasks still exist; wait for their shutdown before rotating",
    );
  requireNoDrainingWebTasks(p);
}

function requireNoDrainingWebTasks(p: Platform): void {
  // A desired STOPPED state includes tasks whose process is still draining.
  const draining = listDrainingTasks(p, p.name + "-web");
  if (draining === null) throw new Error("Web task shutdown is unconfirmed");
  for (const { requested, response } of describeTaskBatches(p, draining))
    if (
      response.failures?.length ||
      response.tasks.length !== requested.length ||
      response.tasks.some((task) => task.lastStatus !== "STOPPED")
    )
      throw new Error("Web task shutdown is unconfirmed");
}

function readRotation(file: string, arn: string): Rotation {
  const value = JSON.parse(readFileSync(file, "utf8")) as Rotation;
  if (
    value.secretArn !== arn ||
    !/^[a-zA-Z0-9-]{32,64}$/.test(value.previousVersion) ||
    !/^[a-f0-9-]{36}$/.test(value.nextVersion) ||
    !/^[a-f0-9]{64}$/.test(value.nextSha256) ||
    value.previousVersion === value.nextVersion
  )
    throw new Error("Rotation record does not match this secret");
  return value;
}

function prepareRotation(
  p: Platform,
  name: string,
  arn: string,
  file: string,
): void {
  let value: string | undefined;
  if (!existsSync(file)) {
    const current = getVersion(p, arn);
    value =
      name === "gate"
        ? randomBytes(18).toString("base64url")
        : randomBytes(48).toString("hex");
    const record: Rotation = {
      secretArn: arn,
      previousVersion: current.VersionId,
      nextVersion: randomUUID(),
      nextSha256: createHash("sha256").update(value).digest("hex"),
    };
    // Record the idempotency token before the first external write. The record
    // contains version identifiers and a digest, never credential values.
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  const record = readRotation(file, arn);
  if (getVersion(p, arn).VersionId !== record.previousVersion)
    throw new Error(
      "Current secret changed since preparation; do not overwrite another rotation",
    );
  try {
    requirePreparedVersion(p, record);
  } catch (error) {
    if (
      !(error instanceof AwsError) ||
      error.code !== "ResourceNotFoundException"
    )
      throw error;
    if (value === undefined)
      throw new Error(
        "Prepared version is unavailable; retain this record and resolve the previous attempt before starting another preparation",
        { cause: error },
      );
    aws(
      [
        "secretsmanager",
        "put-secret-value",
        "--region",
        p.region,
        "--secret-id",
        arn,
        "--client-request-token",
        record.nextVersion,
        "--version-stages",
        "one-door-" + record.nextVersion,
        "--secret-string",
        "file:///dev/stdin",
      ],
      value,
    );
    requirePreparedVersion(p, record);
  }
  if (getVersion(p, arn).VersionId !== record.previousVersion)
    throw new Error("Current secret changed during preparation");
  console.log(
    "Secret version prepared; AWSCURRENT is unchanged:",
    record.nextVersion,
  );
}

function requirePreparedVersion(p: Platform, record: Rotation): void {
  const value = getVersion(p, record.secretArn, record.nextVersion);
  if (
    value.VersionId !== record.nextVersion ||
    createHash("sha256").update(value.SecretString).digest("hex") !==
      record.nextSha256
  )
    throw new Error("Prepared secret digest does not match the recorded value");
}

function changeCurrent(
  p: Platform,
  arn: string,
  record: Rotation,
  action: string,
): void {
  requireWebStopped(p);
  const from =
    action === "activate" ? record.previousVersion : record.nextVersion;
  const to =
    action === "activate" ? record.nextVersion : record.previousVersion;
  getVersion(p, arn, to);
  if (action === "activate") requirePreparedVersion(p, record);
  const current = getVersion(p, arn).VersionId;
  if (current !== from && current !== to)
    throw new Error(
      "Current secret is outside this rotation; refusing to move its label",
    );
  if (current === from) {
    // RemoveFromVersionId makes AWS reject a competing AWSCURRENT change.
    aws([
      "secretsmanager",
      "update-secret-version-stage",
      "--region",
      p.region,
      "--secret-id",
      arn,
      "--version-stage",
      "AWSCURRENT",
      "--move-to-version-id",
      to,
      "--remove-from-version-id",
      from,
    ]);
  }
  if (getVersion(p, arn).VersionId !== to)
    throw new Error("Current secret version could not be confirmed");
  console.log(
    "Current secret version confirmed; web service remains stopped:",
    to,
  );
}

export function rotateSecret(
  p: Platform,
  name: string,
  file: string,
  action: string,
): void {
  if (
    !["gate", "session"].includes(name) ||
    !["prepare", "activate", "rollback"].includes(action)
  )
    throw new Error(
      "Only gate/session prepare, activate or rollback is supported",
    );
  requireAccount(p);
  const arn = p.secret_arns[name];
  if (!arn) throw new Error("Secret reference is missing");
  if (action === "prepare") prepareRotation(p, name, arn, file);
  else changeCurrent(p, arn, readRotation(file, arn), action);
}

if (isMain(import.meta)) {
  const [platformFile, name, file, action] = process.argv.slice(2);
  if (!platformFile || !name || !file || !action)
    throw new Error(
      "Usage: rotate-secret.ts PLATFORM_JSON gate|session PRIVATE_RECORD prepare|activate|rollback",
    );
  rotateSecret(readPlatform(platformFile), name, file, action);
}
