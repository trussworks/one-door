// Rehearses a database restore against the released image before anyone trusts
// the restore. The rehearsal runs as a private one-off task from the web task
// definition, so the image, the roles, the subnets and the injected secrets are
// the ones the service already uses. Only the database host is overridden, and
// the host is not a secret: the probe rewrites the host inside the container so
// the password never appears in a task override, which ECS stores and returns
// in plain text.
import { readFileSync } from "node:fs";

import { isMain } from "../is-main.mjs";
import { aws, readPlatform, requireAccount, type Platform } from "./aws.ts";
import {
  readAvailableOutput,
  readOperationLog,
  waitForStoppedTask,
  type StoppedTask,
} from "./run-task.ts";

// ECS rejects a RunTask request whose overrides exceed 8192 bytes.
export const MAX_OVERRIDE_BYTES = 8192;

const EVIDENCE_MARKER = "one-door-restore-evidence:";

export type Diagnostic = {
  database: { name: string; encoding: string; collation: string };
  migrations: Record<string, string>;
  fixtures: Record<string, string>;
  tables: Record<string, { rows: number; sha256: string }>;
};

export type InstanceFacts = {
  DBInstanceIdentifier: string;
  DBInstanceStatus: string;
  PubliclyAccessible: boolean;
  StorageEncrypted: boolean;
  KmsKeyId?: string;
  Endpoint?: { Address?: string };
  EngineVersion: string;
  DBSubnetGroup?: { DBSubnetGroupName?: string };
  VpcSecurityGroups?: Array<{ VpcSecurityGroupId: string }>;
  DBParameterGroups?: Array<{ DBParameterGroupName: string }>;
};

/** Refuses to act against an account other than the platform's own. */
export function requireCaller(
  account: string,
  p: Pick<Platform, "account_id">,
) {
  if (account !== p.account_id)
    throw new Error(
      `AWS account mismatch: caller is ${account}, platform is ${p.account_id}; no rehearsal attempted`,
    );
}

/**
 * Accepts a restore only when it is a different instance that kept every
 * protection the source has. A restored instance that quietly dropped
 * encryption, moved to a public subnet group or landed on a different key is
 * not a rehearsal of the real recovery.
 */
export function requireRestoreTarget(input: {
  source: InstanceFacts;
  target: InstanceFacts;
}): string {
  const { source, target } = input;
  const host = target.Endpoint?.Address;
  const failures: Array<[boolean, string]> = [
    [
      !source.KmsKeyId,
      "source reports no KMS key, so encryption cannot be matched",
    ],
    [!target.KmsKeyId, "target reports no KMS key"],
    [!subnetGroup(source), "source reports no subnet group"],
    [!subnetGroup(target), "target reports no subnet group"],
    [
      target.DBInstanceIdentifier === source.DBInstanceIdentifier,
      "target is the live instance, not a restore",
    ],
    [
      target.DBInstanceStatus !== "available",
      `target status is ${target.DBInstanceStatus}, not available`,
    ],
    [target.PubliclyAccessible, "target is publicly accessible"],
    [!target.StorageEncrypted, "target storage is not encrypted"],
    [target.KmsKeyId !== source.KmsKeyId, "target uses a different KMS key"],
    [
      target.EngineVersion !== source.EngineVersion,
      `target engine ${target.EngineVersion} differs from source ${source.EngineVersion}`,
    ],
    [
      subnetGroup(target) !== subnetGroup(source),
      "target is in a different subnet group",
    ],
    [
      !sameNonEmpty(groupIds(target), groupIds(source)),
      "target has different security groups",
    ],
    [
      !sameNonEmpty(parameterGroups(target), parameterGroups(source)),
      "target has a different parameter group",
    ],
    [!host, "target has no endpoint address yet"],
  ];
  const problems = failures
    .filter(([failed]) => failed)
    .map(([, message]) => message);
  if (problems.length)
    throw new Error("Restore target rejected: " + problems.join("; "));
  return host!;
}

/** Two lists match only when both name the same groups and neither is empty. */
function sameNonEmpty(a: string[], b: string[]): boolean {
  return a.length > 0 && a.join(",") === b.join(",");
}

function subnetGroup(instance: InstanceFacts): string {
  return instance.DBSubnetGroup?.DBSubnetGroupName ?? "";
}

function groupIds(instance: InstanceFacts): string[] {
  return (instance.VpcSecurityGroups ?? [])
    .map((g) => g.VpcSecurityGroupId)
    .sort();
}

function parameterGroups(instance: InstanceFacts): string[] {
  return (instance.DBParameterGroups ?? [])
    .map((g) => g.DBParameterGroupName)
    .sort();
}

/**
 * Pins the rehearsal to one exact task definition revision and one exact image
 * digest, so a rehearsal never proves a build nobody released.
 */
export function requireReleasedTask(input: {
  described: {
    taskDefinition: {
      family: string;
      revision: number;
      status: string;
      containerDefinitions: Array<{ name: string; image: string }>;
    };
  };
  expectedFamily: string;
  expectedRevision: number;
  expectedImage: string;
  containerName: string;
}): void {
  const d = input.described.taskDefinition;
  if (d.family !== input.expectedFamily)
    throw new Error(`family ${d.family} is not ${input.expectedFamily}`);
  if (d.revision !== input.expectedRevision)
    throw new Error(`revision ${d.revision} is not ${input.expectedRevision}`);
  if (d.status !== "ACTIVE")
    throw new Error(`task definition status is ${d.status}, not ACTIVE`);
  const container = d.containerDefinitions.find(
    (c) => c.name === input.containerName,
  );
  if (!container) throw new Error(`no container named ${input.containerName}`);
  if (container.image !== input.expectedImage)
    throw new Error("released image digest does not match the rehearsal pin");
  if (!/@sha256:[a-f0-9]{64}$/.test(container.image))
    throw new Error("released image must be pinned by digest");
}

// Runs inside the released image as the container command. It rewrites only
// the host of the injected DATABASE_URL, inspects the restored data before any
// write, then exercises real routes and reports one JSON line. The gate code
// comes from the container's own environment and is never printed.
const PROBE_SOURCE_FILE = readFileSync(
  new URL("restore-probe.cjs", import.meta.url),
  "utf8",
);

/**
 * The probe ships as one container override, so the whole file is the source.
 * ECS stores an override in plain text and caps it, which requireSafeOverride
 * checks before submission.
 */
export const PROBE_SOURCE = PROBE_SOURCE_FILE;

// parseProbeEvidence reads the marker back out of the probe's output, so the
// two must not drift apart now that they live in separate files.
if (!PROBE_SOURCE_FILE.includes(EVIDENCE_MARKER))
  throw new Error(
    "The restore probe must print its evidence behind " + EVIDENCE_MARKER,
  );

function probeRegion(name: string): string {
  const open = `// #region ${name}\n`;
  const close = `// #endregion ${name}`;
  const from = PROBE_SOURCE_FILE.indexOf(open);
  const to = PROBE_SOURCE_FILE.indexOf(close);
  if (from < 0 || to < 0)
    throw new Error("The probe no longer marks the region: " + name);
  return PROBE_SOURCE_FILE.slice(from + open.length, to);
}

/**
 * The same text the probe runs, so a test drives the real implementation
 * rather than a copy that could drift from it.
 */
export const STOP_SERVER_SOURCE = probeRegion("stopServer");

export const REHEARSAL_PASSED_SOURCE = probeRegion("rehearsalPassed");

/** The probe's queue read; the caller supplies ORIGIN and REQUEST_TIMEOUT_MS. */
export const QUEUE_READ_SOURCE =
  probeRegion("httpGet") + probeRegion("queueRead");

/**
 * Builds the container override. The override carries the probe and one
 * hostname; ECS stores overrides in plain text, so nothing secret goes here.
 */
export function buildContainerOverride(input: {
  containerName: string;
  restoreHost: string;
}) {
  if (!/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(input.restoreHost))
    throw new Error("restore host must be an RDS endpoint address");
  return {
    containerOverrides: [
      {
        name: input.containerName,
        // The probe imports scripts/db-inspect.ts, and every other job command
        // in the release stack passes the flag rather than relying on a default.
        command: ["node", "--experimental-strip-types", "-e", PROBE_SOURCE],
        environment: [
          { name: "RESTORE_DATABASE_HOST", value: input.restoreHost },
        ],
      },
    ],
  };
}

export function overrideByteLength(override: unknown): number {
  return Buffer.byteLength(JSON.stringify(override), "utf8");
}

/** Rejects an override that ECS would refuse, or that leaked a credential. */
export function requireSafeOverride(override: unknown, forbidden: string[]) {
  const text = JSON.stringify(override);
  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_OVERRIDE_BYTES)
    throw new Error(
      `override is ${size} bytes, over the ${MAX_OVERRIDE_BYTES} byte limit`,
    );
  for (const value of forbidden)
    if (value && text.includes(value))
      throw new Error("override contains a credential value");
  return size;
}

/** Reads the probe's single evidence line out of the task's log output. */
export function parseProbeEvidence(lines: string[]) {
  const found = lines.filter((line) => line.includes(EVIDENCE_MARKER));
  if (found.length !== 1)
    throw new Error(
      `expected exactly one evidence line, found ${found.length}; the rehearsal result is unconfirmed`,
    );
  const start = found[0].indexOf(EVIDENCE_MARKER) + EVIDENCE_MARKER.length;
  return JSON.parse(found[0].slice(start)) as {
    diagnostic: Diagnostic | null;
    flows: Record<string, number>;
    ok: boolean;
    error?: string;
  };
}

/**
 * Compares the restored database against the diagnostic saved from the source.
 * Every table, migration and fixture must match exactly; a restore that gained
 * or lost rows is not the database the evidence describes.
 */
export function compareDiagnostics(saved: Diagnostic, observed: Diagnostic) {
  const differences: string[] = [];
  if (saved.database.encoding !== observed.database.encoding)
    differences.push("database encoding differs");
  if (saved.database.collation !== observed.database.collation)
    differences.push("database collation differs");
  for (const [group, a, b] of [
    ["migration", saved.migrations, observed.migrations],
    ["fixture", saved.fixtures, observed.fixtures],
  ] as const)
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (a[name] !== b[name]) differences.push(`${group} ${name} differs`);
  for (const name of new Set([
    ...Object.keys(saved.tables),
    ...Object.keys(observed.tables),
  ])) {
    const difference = tableDifference(
      name,
      saved.tables[name],
      observed.tables[name],
    );
    if (difference) differences.push(difference);
  }
  return { ok: differences.length === 0, differences };
}

type TableFacts = { rows: number; sha256: string } | undefined;

function tableDifference(
  name: string,
  before: TableFacts,
  after: TableFacts,
): string | undefined {
  if (!before) return `table ${name} exists only in the restore`;
  if (!after) return `table ${name} is missing from the restore`;
  if (before.rows !== after.rows)
    return `table ${name} has ${after.rows} rows, saved evidence has ${before.rows}`;
  if (before.sha256 !== after.sha256)
    return `table ${name} content digest differs`;
  return undefined;
}

/**
 * Validates the saved evidence before anything is submitted, so a missing or
 * malformed file cannot leave a task running with nothing to compare against.
 * The shape is the observed output of inspectDatabase, not its declaration.
 */
export function parseDiagnostic(text: string, source: string): Diagnostic {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const d = value as Diagnostic;
  if (!isDatabaseFacts(d?.database) || !hasTables(d))
    throw new Error(`${source} is not a database diagnostic`);
  return d;
}

function isDatabaseFacts(value: unknown): boolean {
  const facts = value as Diagnostic["database"] | undefined;
  return (
    typeof facts?.name === "string" &&
    typeof facts.encoding === "string" &&
    typeof facts.collation === "string"
  );
}

function isDigest(entry: unknown): boolean {
  return typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry);
}

function isTableFacts(entry: unknown): boolean {
  const facts = entry as { rows?: unknown; sha256?: unknown } | undefined;
  return Number.isInteger(facts?.rows) && isDigest(facts?.sha256);
}

function everyValue(
  record: unknown,
  check: (entry: unknown) => boolean,
): boolean {
  return (
    !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.values(record as Record<string, unknown>).every(check)
  );
}

function hasTables(d: Diagnostic): boolean {
  return (
    everyValue(d.migrations, isDigest) &&
    everyValue(d.fixtures, isDigest) &&
    everyValue(d.tables, isTableFacts) &&
    Object.keys(d.tables).length > 0
  );
}

function describeInstance(p: Platform, identifier: string): InstanceFacts {
  const response = aws<{ DBInstances: InstanceFacts[] }>([
    "rds",
    "describe-db-instances",
    "--region",
    p.region,
    "--db-instance-identifier",
    identifier,
  ]);
  if (response.DBInstances?.length !== 1)
    throw new Error(`database ${identifier} could not be confirmed`);
  return response.DBInstances[0];
}

type RehearsalTask = {
  family: string;
  revision: number;
  status: string;
  taskDefinitionArn: string;
  containerDefinitions: Array<{ name: string; image: string }>;
};

/** ECS stores an override in plain text, so it is checked before submission. */
function submitRehearsal(
  p: Platform,
  task: RehearsalTask,
  restoreHost: string,
  sourceEndpoint: string,
): string {
  const overrides = buildContainerOverride({
    containerName: "web",
    restoreHost,
  });
  const size = requireSafeOverride(overrides, [sourceEndpoint]);
  console.log("Rehearsal override prepared:", size, "bytes");
  const submitted = aws<{
    failures?: Array<{ reason?: string }>;
    tasks?: Array<{ taskArn: string }>;
  }>([
    "ecs",
    "run-task",
    "--region",
    p.region,
    "--cli-input-json",
    JSON.stringify({
      cluster: p.cluster_arn,
      taskDefinition: task.taskDefinitionArn,
      launchType: "FARGATE",
      platformVersion: "1.4.0",
      count: 1,
      startedBy: "one-door-restore-rehearsal",
      overrides,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: p.subnet_ids,
          // The rehearsal accepts no inbound traffic, so it uses the group with
          // no ingress rules rather than the one the load balancer can reach.
          securityGroups: [p.worker_security_group_id],
          assignPublicIp: "DISABLED",
        },
      },
    }),
  ]);
  if (submitted.failures?.length || submitted.tasks?.length !== 1)
    throw new Error("Rehearsal did not start exactly one task");
  const taskArn = submitted.tasks[0].taskArn;
  console.log("Rehearsal task submitted:", taskArn);
  return taskArn;
}

/**
 * A stopped rehearsal is not a passed rehearsal. The restored data is compared
 * first, so a data mismatch is reported as a data mismatch rather than as a
 * failed run, and only then are the exit code and flow results accepted.
 */
async function acceptRehearsal(
  p: Platform,
  taskArn: string,
  stopped: StoppedTask,
  savedDiagnostic: Diagnostic,
): Promise<void> {
  const stream = "ecs/web/" + taskArn.split("/").at(-1);
  const lines = await readAvailableOutput(() =>
    readOperationLog(p, stream, { logGroup: p.log_groups.web }),
  );
  const evidence = parseProbeEvidence(lines);
  const exitCode = stopped.containers.find((c) => c.name === "web")?.exitCode;
  console.log(JSON.stringify({ taskArn, exitCode, flows: evidence.flows }));

  if (!evidence.diagnostic)
    throw new Error("the rehearsal produced no diagnostic to compare");
  const comparison = compareDiagnostics(savedDiagnostic, evidence.diagnostic);
  if (!comparison.ok)
    throw new Error(
      "restored data does not match the saved evidence: " +
        comparison.differences.join("; "),
    );
  console.log("Restored data matches the saved diagnostic exactly.");
  if (exitCode !== 0 || !evidence.ok)
    throw new Error(
      `Rehearsal failed: exit ${exitCode ?? "unconfirmed"}, flows ${JSON.stringify(evidence.flows)}${evidence.error ? ", error " + evidence.error : ""}`,
    );
  console.log("Restore rehearsal confirmed against the released image.");
}

if (isMain(import.meta)) {
  const [platformFile, restoreIdentifier, revisionText, imageReference, saved] =
    process.argv.slice(2);
  if (
    !platformFile ||
    !restoreIdentifier ||
    !revisionText ||
    !imageReference ||
    !saved
  )
    throw new Error(
      "Usage: check-restore.ts PLATFORM_JSON RESTORE_DB_IDENTIFIER WEB_TASK_REVISION IMAGE_DIGEST_REFERENCE SAVED_DIAGNOSTIC_JSON",
    );
  // Read and validate before any AWS call, so a bad file never starts a task.
  const savedDiagnostic = parseDiagnostic(readFileSync(saved, "utf8"), saved);
  const p = readPlatform(platformFile);
  requireAccount(p);
  const identity = aws<{ Account: string }>([
    "sts",
    "get-caller-identity",
    "--region",
    p.region,
  ]);
  requireCaller(identity.Account, p);

  const source = describeInstance(p, p.database_identifier);
  const target = describeInstance(p, restoreIdentifier);
  const restoreHost = requireRestoreTarget({ source, target });

  const family = `${p.name}-web`;
  const revision = Number(revisionText);
  if (!Number.isInteger(revision) || revision < 1)
    throw new Error("WEB_TASK_REVISION must be a positive integer");
  const described = aws<{ taskDefinition: RehearsalTask }>([
    "ecs",
    "describe-task-definition",
    "--region",
    p.region,
    "--task-definition",
    `${family}:${revision}`,
  ]);
  requireReleasedTask({
    described,
    expectedFamily: family,
    expectedRevision: revision,
    expectedImage: imageReference,
    containerName: "web",
  });

  const taskArn = submitRehearsal(
    p,
    described.taskDefinition,
    restoreHost,
    source.Endpoint?.Address ?? "",
  );
  const stopped = await waitForStoppedTask(p, taskArn, {
    deadlineMs: 30 * 60_000,
    timeoutMessage:
      "Rehearsal is still unconfirmed and may be running; do not resubmit: ",
    unconfirmedMessage: "Rehearsal task status could not be confirmed: ",
  });
  await acceptRehearsal(p, taskArn, stopped, savedDiagnostic);
}
