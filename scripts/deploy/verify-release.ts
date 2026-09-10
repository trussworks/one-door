// Confirms that a release actually reached the account: every running web and
// worker task uses the intended task definition revision and the promoted
// image. A steady-state waiter is not evidence — a rolled-back deployment also
// reaches steady state, on the previous revision.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { isMain } from "../is-main.mjs";
import { aws, readPlatform, requireAccount, type Platform } from "./aws.ts";
import { waitForWorkerProgress } from "./worker-progress.ts";

const INDEX_MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];

export interface ServiceState {
  serviceName: string;
  status?: string;
  desiredCount: number;
  runningCount: number;
  deployments: Array<{
    status: string;
    taskDefinition: string;
    rolloutState?: string;
    rolloutStateReason?: string;
  }>;
}

export interface TaskState {
  taskArn: string;
  lastStatus: string;
  desiredStatus: string;
  taskDefinitionArn: string;
  availabilityZone?: string;
  stoppedReason?: string;
  healthStatus?: string;
  startedAt?: string;
  containers: Array<{
    name: string;
    lastStatus?: string;
    imageDigest?: string;
    healthStatus?: string;
  }>;
}

export function parseImageReference(reference: string): {
  repository: string;
  digest: string;
} {
  const match = /^(?<repository>[^@]+)@(?<digest>sha256:[a-f0-9]{64})$/.exec(
    reference,
  );
  if (!match?.groups)
    throw new Error("The release image must be a repository digest reference");
  return {
    repository: match.groups.repository,
    digest: match.groups.digest,
  };
}

/**
 * A promoted digest usually names an image index. ECS pulls the child manifest
 * for the task's architecture, so describe-tasks reports the child digest, not
 * the index. Accept the index and its linux/amd64 children, and nothing else;
 * attestation manifests carry architecture "unknown" and are excluded.
 */
export function acceptableDigests(
  indexDigest: string,
  manifest: string,
  mediaType: string,
): string[] {
  const digests = [indexDigest];
  if (!INDEX_MEDIA_TYPES.includes(mediaType)) return digests;
  const parsed = JSON.parse(manifest) as {
    manifests?: Array<{
      digest?: string;
      platform?: { os?: string; architecture?: string };
    }>;
  };
  for (const child of parsed.manifests ?? []) {
    if (
      child.platform?.os === "linux" &&
      child.platform?.architecture === "amd64" &&
      typeof child.digest === "string"
    )
      digests.push(child.digest);
  }
  if (digests.length === 1)
    throw new Error(
      "The release image index contains no linux/amd64 manifest: " +
        indexDigest,
    );
  return digests;
}

function checkDeployments(
  service: ServiceState,
  expectedTaskDefinition: string,
): void {
  const failed = service.deployments.find(
    (deployment) => deployment.rolloutState === "FAILED",
  );
  if (failed)
    throw new Error(
      `${service.serviceName}: deployment failed and was rolled back (${failed.rolloutStateReason ?? "no reason reported"})`,
    );
  if (service.deployments.length !== 1)
    throw new Error(
      `${service.serviceName}: ${service.deployments.length} deployments are active; the release has not settled`,
    );
  const [primary] = service.deployments;
  if (primary.status !== "PRIMARY")
    throw new Error(
      `${service.serviceName}: the only deployment is ${primary.status}, not PRIMARY`,
    );
  if (primary.rolloutState !== "COMPLETED")
    throw new Error(
      `${service.serviceName}: rollout state is ${primary.rolloutState ?? "unreported"}, not COMPLETED`,
    );
  if (primary.taskDefinition !== expectedTaskDefinition)
    throw new Error(
      `${service.serviceName}: serving ${primary.taskDefinition}, not the intended ${expectedTaskDefinition}`,
    );
}

/** Returns the digest the task is actually running, or throws. */
function checkTask(
  task: TaskState,
  expected: {
    serviceName: string;
    containerName: string;
    expectedTaskDefinition: string;
    acceptableDigests: string[];
  },
): string {
  const where = `${expected.serviceName}: task ${task.taskArn}`;
  if (task.lastStatus !== "RUNNING" || task.desiredStatus !== "RUNNING")
    throw new Error(
      `${where} is ${task.lastStatus} (${task.stoppedReason ?? "no reason reported"})`,
    );
  if (task.taskDefinitionArn !== expected.expectedTaskDefinition)
    throw new Error(
      `${where} runs ${task.taskDefinitionArn}, not the intended revision`,
    );
  const container = task.containers.find(
    (one) => one.name === expected.containerName,
  );
  if (!container)
    throw new Error(`${where} has no ${expected.containerName} container`);
  if (container.lastStatus !== "RUNNING")
    throw new Error(
      `${where} has a ${container.lastStatus ?? "unreported"} container state`,
    );
  if (!container.imageDigest)
    throw new Error(
      `${where} reports no image digest; the release is unconfirmed`,
    );
  if (!expected.acceptableDigests.includes(container.imageDigest))
    throw new Error(
      `${where} runs image ${container.imageDigest}, which is not the released image`,
    );
  requireTaskHealth(task, container);
  return container.imageDigest;
}

function requireTaskHealth(
  task: TaskState,
  container: TaskState["containers"][number],
): void {
  if (task.healthStatus !== "HEALTHY" || container.healthStatus !== "HEALTHY")
    throw new Error(
      `task ${task.taskArn}: task and container health must both be HEALTHY`,
    );
}

export function checkService(input: {
  service: ServiceState;
  tasks: TaskState[];
  containerName: string;
  expectedTaskDefinition: string;
  acceptableDigests: string[];
  expectedCount: number;
}): { serviceName: string; tasks: number; digests: string[] } {
  const { service, tasks, containerName, expectedCount } = input;
  if (service.status !== "ACTIVE")
    throw new Error(
      `${service.serviceName}: service status is ${service.status}`,
    );
  if (service.desiredCount !== expectedCount)
    throw new Error(
      `${service.serviceName}: desired count is ${service.desiredCount}, not the intended ${expectedCount}`,
    );
  if (service.runningCount !== service.desiredCount)
    throw new Error(
      `${service.serviceName}: ${service.runningCount} of ${service.desiredCount} tasks are running`,
    );
  checkDeployments(service, input.expectedTaskDefinition);

  if (tasks.length !== expectedCount)
    throw new Error(
      `${service.serviceName}: ${tasks.length} tasks were described, not the intended ${expectedCount}`,
    );
  const digests = new Set(
    tasks.map((task) =>
      checkTask(task, {
        serviceName: service.serviceName,
        containerName,
        expectedTaskDefinition: input.expectedTaskDefinition,
        acceptableDigests: input.acceptableDigests,
      }),
    ),
  );
  if (tasks.some((task) => !task.availabilityZone))
    throw new Error(
      `${service.serviceName}: an availability zone is unreported`,
    );
  const zones = new Set(tasks.map((task) => task.availabilityZone));
  if (expectedCount >= 2 && zones.size < 2)
    throw new Error(
      `${service.serviceName}: tasks have not spread across two availability zones`,
    );
  return {
    serviceName: service.serviceName,
    tasks: tasks.length,
    digests: [...digests],
  };
}

export function resolveAcceptableDigests(
  p: Pick<Platform, "repository_url" | "region" | "name">,
  reference: string,
): string[] {
  const { repository, digest } = parseImageReference(reference);
  if (repository !== p.repository_url)
    throw new Error("The release image is outside this account's repository");
  const response = aws<{
    images?: Array<{ imageManifest: string; imageManifestMediaType: string }>;
    failures?: Array<{ failureReason?: string }>;
  }>([
    "ecr",
    "batch-get-image",
    "--region",
    p.region,
    "--repository-name",
    p.name,
    "--image-ids",
    "imageDigest=" + digest,
  ]);
  const image = response.images?.[0];
  if (response.failures?.length || !image)
    throw new Error("The release image is not present in the repository");
  return acceptableDigests(
    digest,
    image.imageManifest,
    image.imageManifestMediaType,
  );
}

/** Wait for completed rollouts; a settled rollback still needs the exact-image check. */
export async function waitForServices(p: Platform): Promise<void> {
  const names = [p.name + "-web", p.name + "-worker"];
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = aws<{ services: ServiceState[]; failures?: unknown[] }>([
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
      "Service status is unconfirmed",
    );
    assert.deepEqual(
      response.services.map((service) => service.serviceName).sort(),
      [...names].sort(),
      "Both services must appear in the response",
    );
    for (const service of response.services) {
      assert.equal(service.status, "ACTIVE", "Service is not active");
      if (
        service.deployments.some(
          (deployment) => deployment.rolloutState === "FAILED",
        )
      )
        throw new Error(
          service.serviceName + ": deployment failed; do not report a release",
        );
    }
    if (
      response.services.every(
        (service) =>
          service.runningCount === service.desiredCount &&
          service.deployments.length === 1 &&
          service.deployments[0].status === "PRIMARY" &&
          service.deployments[0].rolloutState === "COMPLETED",
      )
    )
      return;
    if (attempt % 4 === 0)
      console.log("Waiting for completed ECS service rollouts.");
    if (attempt < 119) await delay(15000);
  }
  throw new Error(
    "Services did not complete within 30 minutes; their deployment may still be running",
  );
}

function describeTasks(p: Platform, service: string): TaskState[] {
  const listed = aws<{ taskArns: string[] }>([
    "ecs",
    "list-tasks",
    "--region",
    p.region,
    "--cluster",
    p.cluster_arn,
    "--service-name",
    service,
    "--desired-status",
    "RUNNING",
  ]);
  if (listed.taskArns.length === 0)
    throw new Error(`${service}: no running tasks were found`);
  const described = aws<{ tasks: TaskState[]; failures?: unknown[] }>([
    "ecs",
    "describe-tasks",
    "--region",
    p.region,
    "--cluster",
    p.cluster_arn,
    "--tasks",
    ...listed.taskArns,
  ]);
  if (described.failures?.length)
    throw new Error(`${service}: task descriptions could not be confirmed`);
  return described.tasks;
}

async function healthyTasks(p: Platform, name: string): Promise<TaskState[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const tasks = describeTasks(p, name);
    if (
      tasks.every(
        (task) =>
          task.healthStatus === "HEALTHY" &&
          task.containers.every(
            (container) => container.healthStatus === "HEALTHY",
          ),
      )
    )
      return tasks;
    if (tasks.some((task) => task.healthStatus === "UNHEALTHY"))
      throw new Error(name + ": task health is UNHEALTHY");
    if (attempt < 19) await delay(15_000);
  }
  throw new Error(name + ": task health remained unknown for five minutes");
}

async function verifyService(
  p: Platform,
  name: "web" | "worker",
  target: {
    definition: string;
    image: string;
    digests: string[];
    count: number;
  },
) {
  const serviceName = `${p.name}-${name}`;
  const tasks = await healthyTasks(p, serviceName);
  const progress =
    name === "worker" ? await waitForWorkerProgress(p, tasks) : [];
  const current = describeTasks(p, serviceName);
  assert.deepEqual(
    current.map((task) => task.taskArn).sort(),
    tasks.map((task) => task.taskArn).sort(),
    "Tasks changed while release evidence was collected; verification must be repeated",
  );
  const response = aws<{ services: ServiceState[]; failures?: unknown[] }>([
    "ecs",
    "describe-services",
    "--region",
    p.region,
    "--cluster",
    p.cluster_arn,
    "--services",
    serviceName,
  ]);
  if (response.failures?.length || response.services.length !== 1)
    throw new Error(`${serviceName}: the service could not be described`);
  return {
    ...checkService({
      service: response.services[0],
      tasks: current,
      containerName: name,
      expectedTaskDefinition: target.definition,
      acceptableDigests: target.digests,
      expectedCount: target.count,
    }),
    taskArns: current.map((task) => task.taskArn).sort(),
    taskDefinition: target.definition,
    healthVerified: true,
    ...(name === "worker"
      ? { workerProgressVerified: true, workerProgress: progress }
      : {}),
  };
}

interface VerificationTargets {
  image: string;
  digests: string[];
  definitions: Record<string, string>;
  counts: { web: number; worker: number };
}

function confirmSnapshots(
  p: Platform,
  snapshots: Awaited<ReturnType<typeof verifyService>>[],
  target: VerificationTargets,
): void {
  for (const snapshot of snapshots) {
    const name = snapshot.serviceName === p.name + "-web" ? "web" : "worker";
    const tasks = describeTasks(p, snapshot.serviceName);
    assert.deepEqual(
      tasks.map((task) => task.taskArn).sort(),
      snapshot.taskArns,
      "Tasks changed after evidence collection; verification must be repeated",
    );
    const response = aws<{ services: ServiceState[]; failures?: unknown[] }>([
      "ecs",
      "describe-services",
      "--region",
      p.region,
      "--cluster",
      p.cluster_arn,
      "--services",
      snapshot.serviceName,
    ]);
    assert.equal(
      response.failures?.length ?? 0,
      0,
      "Final service state is unconfirmed",
    );
    assert.equal(response.services.length, 1, "Final service state is missing");
    checkService({
      service: response.services[0],
      tasks,
      containerName: name,
      expectedTaskDefinition: snapshot.taskDefinition,
      acceptableDigests: target.digests,
      expectedCount: target.counts[name],
    });
  }
}

export async function verifyServices(p: Platform, target: VerificationTargets) {
  const snapshots = [];
  for (const name of ["web", "worker"] as const) {
    snapshots.push(
      await verifyService(p, name, {
        definition: target.definitions[name],
        image: target.image,
        digests: target.digests,
        count: target.counts[name],
      }),
    );
  }
  // Evidence collection can wait for logs; recheck every service afterwards.
  confirmSnapshots(p, snapshots, target);
  return snapshots;
}

if (isMain(import.meta)) {
  const [platformFile, tasksFile, imageReference, webCount, workerCount] =
    process.argv.slice(2);
  if (!platformFile || !tasksFile || !imageReference)
    throw new Error(
      "Usage: verify-release.ts PLATFORM_JSON TASKS_JSON IMAGE_DIGEST_REFERENCE [WEB_COUNT] [WORKER_COUNT]",
    );
  const p = readPlatform(platformFile);
  requireAccount(p);
  const intended = JSON.parse(readFileSync(tasksFile, "utf8")) as {
    services: Record<string, string>;
  };
  const digests = resolveAcceptableDigests(p, imageReference);
  const expected = {
    web: Number(webCount ?? 2),
    worker: Number(workerCount ?? 2),
  };
  await waitForServices(p);
  const summaries = await verifyServices(p, {
    image: imageReference,
    digests,
    counts: expected,
    definitions: intended.services,
  });
  const evidence = {
    verifiedAt: new Date().toISOString(),
    origin: p.app_origin,
    accountId: p.account_id,
    released: imageReference,
    acceptableDigests: digests,
    services: summaries,
  };
  writeFileSync(
    path.join(path.dirname(tasksFile), "verified-" + path.basename(tasksFile)),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(evidence));
  console.log("Release verified against running tasks.");
}
