// Bounded checks for the deliberate hosted acceptance journey. Kept apart from
// the Playwright spec so every refusal, overrun and partial-evidence path is
// exercised without a browser, an origin or a paid provider call.
import { z } from "zod";

import { intakeAttemptBudget } from "../src/models/jobs.ts";
import { maxAttemptsBeforeManualRetry } from "../src/models/worker.ts";
import { isDeploymentOrigin } from "../scripts/deploy/aws.ts";
import { deploymentTarget } from "../scripts/deploy/targets.ts";

export interface Bucket {
  used: number;
  cap: number;
  warn: boolean;
  exceeded: boolean;
}

export interface Quota {
  visitorDaily: Bucket;
  globalDaily: Bucket;
  monthlySpend: Bucket;
}

/**
 * Submission always queues risk. It can also queue asset matching when the
 * combined intake assessment cannot be reused. Reserve for all three purposes
 * at their automatic attempt limits, even when reuse saves a call.
 */
export class JourneyRefused extends Error {
  // An explicit field: Node's strip-only mode rejects parameter properties.
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "JourneyRefused";
  }
}

/** NaN and Infinity survive every comparison, so they are rejected by name. */
export function requireCount(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new JourneyRefused(
      `${name} must be a whole number of zero or more, not ${String(value)}`,
    );
  return value;
}

export const journeyPurposes = [
  "intake_interpret",
  "asset_match",
  "risk_assess",
] as const;

export const journeyCallCeiling = requireCount(
  requireCount(intakeAttemptBudget, "The intake attempt budget") +
    (journeyPurposes.length - 1) *
      requireCount(maxAttemptsBeforeManualRetry, "The automatic attempt limit"),
  "The journey call ceiling",
);

function checkBucket(bucket: unknown, name: string): Bucket {
  if (typeof bucket !== "object" || bucket === null)
    throw new JourneyRefused(`The ${name} bucket is missing`);
  const { used, cap } = bucket as Record<string, unknown>;
  return {
    used: requireCount(used, `${name} used`),
    cap: requireCount(cap, `${name} cap`),
    warn: Boolean((bucket as Record<string, unknown>).warn),
    exceeded: Boolean((bucket as Record<string, unknown>).exceeded),
  };
}

export function checkQuota(value: unknown): Quota {
  if (typeof value !== "object" || value === null)
    throw new JourneyRefused("The quota view returned no object");
  const quota = value as Record<string, unknown>;
  return {
    visitorDaily: checkBucket(quota.visitorDaily, "visitor daily"),
    globalDaily: checkBucket(quota.globalDaily, "global daily"),
    monthlySpend: checkBucket(quota.monthlySpend, "monthly spend"),
  };
}

/**
 * The shared caps belong to real visitors too, so the journey starts only when
 * every bucket still has room for its whole worst case. The cost figure is an
 * operator-calculated allowance: nothing here enforces it before dispatch, and
 * the app's own caps remain the only pre-dispatch limit on spend.
 */
export function requireHeadroom(quota: Quota, costAllowance: number): void {
  requireCount(costAllowance, "The cost allowance");
  if (costAllowance <= 0)
    throw new JourneyRefused("A positive cost allowance is required");
  const buckets: Array<[string, Bucket, number]> = [
    ["visitor daily calls", quota.visitorDaily, journeyCallCeiling],
    ["global daily calls", quota.globalDaily, journeyCallCeiling],
    ["monthly spend", quota.monthlySpend, costAllowance],
  ];
  for (const [name, bucket, needed] of buckets) {
    if (bucket.exceeded)
      throw new JourneyRefused(`The ${name} cap is already reached`);
    if (bucket.cap - bucket.used < needed)
      throw new JourneyRefused(
        `The ${name} headroom is ${bucket.cap - bucket.used}, below the ${needed} this journey may need`,
      );
  }
}

/** One model call, with every input, output and identifier value removed. */
export interface CallReceipt {
  id: string;
  jobId: string | null;
  purpose: string;
  status: string;
  attemptCount: number;
  reservedCostMicros: number;
  actualCostMicros: number | null;
  createdAt: string | null;
  completedAt: string | null;
}

/**
 * This draft's own call ledger, not a global counter: other visitors spend
 * from the same daily and monthly buckets, so a quota delta cannot be
 * attributed to one journey.
 */
export function callReceipts(calls: unknown): CallReceipt[] {
  if (!Array.isArray(calls))
    throw new JourneyRefused("The request view returned no call evidence");
  return calls.map((raw, index) => {
    const call = raw as Record<string, unknown>;
    const at = (key: string) =>
      typeof call[key] === "string" ? (call[key] as string) : null;
    return {
      id: String(call.id ?? `unknown-${index}`),
      jobId: typeof call.jobId === "string" ? call.jobId : null,
      purpose: String(call.purpose ?? "unknown"),
      status: String(call.status ?? "unknown"),
      attemptCount: requireCount(call.attemptCount, "A call attempt count"),
      reservedCostMicros: requireCount(
        call.reservedCostMicros,
        "A reserved call cost",
      ),
      actualCostMicros:
        call.actualCostMicros === null || call.actualCostMicros === undefined
          ? null
          : requireCount(call.actualCostMicros, "An actual call cost"),
      createdAt: at("createdAt"),
      completedAt: at("completedAt"),
    };
  });
}

export interface Charged {
  calls: number;
  micros: number;
}

/** A call with no settled cost still counts at what it reserved. */
export function charged(receipts: CallReceipt[]): Charged {
  return {
    calls: receipts.length,
    micros: receipts.reduce(
      (total, call) =>
        total + (call.actualCostMicros ?? call.reservedCostMicros),
      0,
    ),
  };
}

/**
 * Checked after the fact against this draft's own ledger. An overrun is
 * reported, never absorbed, and never presented as a limit that was enforced
 * before the calls were dispatched.
 */
export function verifyCharged(spent: Charged, costAllowance: number): string[] {
  const problems: string[] = [];
  if (spent.calls > journeyCallCeiling)
    problems.push(
      `The journey made ${spent.calls} calls, above its ceiling of ${journeyCallCeiling}`,
    );
  if (spent.micros > costAllowance)
    problems.push(
      `The journey charged ${spent.micros} micros, above the operator allowance of ${costAllowance}`,
    );
  return problems;
}

export function journeyFailure(
  error: unknown,
  accessCode: string | undefined,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return accessCode
    ? message.replaceAll(accessCode, "[redacted access code]")
    : message;
}

export interface JourneyFacts {
  origin: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  draftId: string | null;
  requestId: string | null;
  displayId: string | null;
  jobs: Record<string, { jobId: string; status: string } | null>;
  assetResult: {
    id: string;
    modelCallId: string | null;
    status: string;
  } | null;
  persistedAfterReload: boolean;
  failure: string | null;
}

/**
 * Every required piece of evidence, named. Absence is reported rather than
 * inferred, so an empty outcome map can never read as a completed journey.
 */
function missingEvidence(
  facts: JourneyFacts,
  receipts: CallReceipt[],
): string[] {
  const missing: string[] = [];
  if (facts.failure) missing.push(facts.failure);
  if (!facts.draftId) missing.push("No draft was created");
  if (!facts.requestId) missing.push("No request was submitted");
  for (const purpose of ["intake_interpret", "risk_assess"] as const) {
    const job = facts.jobs[purpose];
    if (!job) missing.push(`No ${purpose} job was observed`);
    else if (job.status !== "succeeded")
      missing.push(`The ${purpose} job settled as ${job.status}`);
  }
  missing.push(...assessmentEvidence(facts, receipts));
  if (receipts.length === 0)
    missing.push(
      "The draft recorded no model call, so nothing reached a provider",
    );
  if (!facts.persistedAfterReload)
    missing.push("The results were not observed again after a reload");
  return missing;
}

function assessmentEvidence(
  facts: JourneyFacts,
  receipts: CallReceipt[],
): string[] {
  const missing: string[] = [];
  if (facts.jobs.asset_match && facts.jobs.asset_match.status !== "succeeded")
    missing.push(
      `The asset_match job settled as ${facts.jobs.asset_match.status}`,
    );
  if (facts.assetResult?.status !== "succeeded")
    missing.push("No successful current asset assessment was observed");
  else if (
    !receipts.some(
      (call) =>
        call.id === facts.assetResult?.modelCallId &&
        call.status === "succeeded" &&
        ["intake_interpret", "asset_match"].includes(call.purpose),
    )
  )
    missing.push(
      "The asset assessment has no successful provider call evidence",
    );
  for (const purpose of ["intake_interpret", "risk_assess"] as const)
    if (
      !receipts.some(
        (call) => call.purpose === purpose && call.status === "succeeded",
      )
    )
      missing.push(`No successful ${purpose} provider call was recorded`);
  return missing;
}

/**
 * One release-verification observation, in the shape verify-release writes. An
 * operator takes one before the run and one after it, because no public view
 * reports which release an origin serves.
 *
 * The pair binds the journey to an immutable image digest. It carries no
 * source revision, and none is invented here: the approved release record is
 * what ties that image to a commit.
 */
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected a digest");

const verifiedService = z.object({
  serviceName: z.string().min(1),
  tasks: z.literal(2),
  digests: z.array(digest).min(1),
  taskArns: z.array(z.string().min(1)).length(2),
  taskDefinition: z.string().min(1),
  healthVerified: z.literal(true),
  workerProgressVerified: z.boolean().optional(),
  workerProgress: z
    .array(
      z.object({
        taskArn: z.string().min(1),
        lastSuccessfulPollAt: z.int().positive(),
        logTimestamp: z.int().positive(),
      }),
    )
    .length(2)
    .optional(),
});

const releaseReceipt = z.object({
  verifiedAt: z.iso.datetime(),
  origin: z.url(),
  accountId: z.string().regex(/^\d{12}$/),
  released: z
    .string()
    .regex(
      /^[^\s@]+@sha256:[0-9a-f]{64}$/,
      "expected an immutable image reference",
    ),
  acceptableDigests: z.array(digest).min(1),
  services: z.array(verifiedService).length(2),
});

export type VerifiedService = z.infer<typeof verifiedService>;
export type ReleaseReceipt = z.infer<typeof releaseReceipt>;

function checkServiceDigests(
  receipt: ReleaseReceipt,
  service: VerifiedService,
  when: string,
): void {
  if (new Set(service.taskArns).size !== service.taskArns.length)
    throw new JourneyRefused(
      `The ${when} ${service.serviceName} tasks are not distinct`,
    );
  for (const value of service.digests)
    if (!receipt.acceptableDigests.includes(value))
      throw new JourneyRefused(
        `The ${when} ${service.serviceName} runs digest ${value}, which the released image does not cover`,
      );
}

function checkWorkerProgress(service: VerifiedService, when: string): void {
  if (!service.serviceName.endsWith("-worker")) return;
  if (service.workerProgressVerified !== true)
    throw new JourneyRefused(
      `The ${when} ${service.serviceName} does not affirm worker progress`,
    );
  if (
    !service.workerProgress ||
    ordered(service.workerProgress.map((row) => row.taskArn)) !==
      ordered(service.taskArns)
  )
    throw new JourneyRefused(
      `The ${when} ${service.serviceName} lacks progress evidence for every task`,
    );
}

function checkCoverage(
  receipt: ReleaseReceipt,
  when: string,
  environment: string,
): void {
  const target = deploymentTarget(environment);
  if (receipt.accountId !== target.account_id)
    throw new JourneyRefused(
      `The ${when} release verification names another deployment account`,
    );
  const repository = `${target.account_id}.dkr.ecr.${target.region}.amazonaws.com/${target.name}`;
  if (!receipt.released.startsWith(repository + "@"))
    throw new JourneyRefused(
      `The ${when} released image is outside the selected deployment`,
    );
  const verifiedServiceNames = [target.name + "-web", target.name + "-worker"];
  const names = receipt.services.map((service) => service.serviceName).sort();
  if (names.join(",") !== [...verifiedServiceNames].sort().join(","))
    throw new JourneyRefused(
      `The ${when} release verification must cover exactly ${verifiedServiceNames.join(" and ")}, not ${names.join(" and ")}`,
    );
  const released = receipt.released.slice(receipt.released.indexOf("@") + 1);
  if (!receipt.acceptableDigests.includes(released))
    throw new JourneyRefused(
      `The ${when} release verification does not accept its own released digest`,
    );
}

export function checkReleaseReceipt(
  value: unknown,
  when: "before" | "after",
  environment: string,
  origin: string,
): ReleaseReceipt {
  const parsed = releaseReceipt.safeParse(value);
  if (!parsed.success)
    throw new JourneyRefused(
      `The ${when} release verification is not usable: ${parsed.error.issues
        .map((issue) => issue.path.join(".") + " " + issue.message)
        .join("; ")}`,
    );
  checkCoverage(parsed.data, when, environment);
  if (parsed.data.origin !== origin)
    throw new JourneyRefused(
      `The ${when} release verification names another application origin`,
    );
  for (const service of parsed.data.services) {
    checkServiceDigests(parsed.data, service, when);
    checkWorkerProgress(service, when);
  }
  return parsed.data;
}

export type BrowserResult = ReturnType<typeof browserResult>;

/**
 * The browser half of the evidence. It is always incomplete: nothing observed
 * from a browser can establish which release served the request.
 */
export function browserResult(input: {
  facts: JourneyFacts;
  receipts: CallReceipt[];
  costAllowance: number;
}) {
  const spent = charged(input.receipts);
  const unverified = [
    ...missingEvidence(input.facts, input.receipts),
    ...verifyCharged(spent, input.costAllowance),
    "Pending operator finalization against the deployed release",
  ];
  return {
    kind: "hosted-acceptance-journey" as const,
    status: "incomplete" as const,
    unverified,
    origin: input.facts.origin,
    runId: input.facts.runId,
    startedAt: input.facts.startedAt,
    finishedAt: input.facts.finishedAt,
    requestId: input.facts.requestId,
    displayId: input.facts.displayId,
    draftId: input.facts.draftId,
    jobs: input.facts.jobs,
    assetResult: input.facts.assetResult,
    persistedAfterReload: input.facts.persistedAfterReload,
    calls: input.receipts,
    charged: spent,
    costAllowance: input.costAllowance,
    release: null as ReleaseReceipt | null,
  };
}

/** An unparseable timestamp compares false either way, so parse it by name. */
export function requireInstant(value: unknown, name: string): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed))
    throw new JourneyRefused(`${name} is not a timestamp: ${String(value)}`);
  return parsed;
}

const ordered = (values: readonly string[]) => [...values].sort().join(",");

function serviceProblems(
  before: VerifiedService,
  after: VerifiedService,
): string[] {
  const problems: string[] = [];
  const name = before.serviceName;
  if (before.tasks !== after.tasks)
    problems.push(`The ${name} task count changed during the journey`);
  if (ordered(before.taskArns) !== ordered(after.taskArns))
    problems.push(`The ${name} tasks were replaced during the journey`);
  if (before.taskDefinition !== after.taskDefinition)
    problems.push(`The ${name} task definition changed during the journey`);
  if (ordered(before.digests) !== ordered(after.digests))
    problems.push(`The ${name} image digests changed during the journey`);
  for (const [when, service] of [
    ["before", before],
    ["after", after],
  ] as const) {
    if (!service.healthVerified)
      problems.push(`The ${name} service was not health-verified ${when}`);
    if (service.workerProgressVerified === false)
      problems.push(`The ${name} worker progress was not verified ${when}`);
  }
  return problems;
}

function sameIdentities(
  before: ReleaseReceipt,
  after: ReleaseReceipt,
): string[] {
  const problems: string[] = [];
  if (before.origin !== after.origin)
    problems.push("The origin changed between the two observations");
  if (before.accountId !== after.accountId)
    problems.push("The account changed between the two observations");
  if (before.released !== after.released)
    problems.push("The released image changed during the journey");
  if (ordered(before.acceptableDigests) !== ordered(after.acceptableDigests))
    problems.push("The acceptable digests changed during the journey");
  const names = (receipt: ReleaseReceipt) =>
    ordered(receipt.services.map((service) => service.serviceName));
  if (names(before) !== names(after))
    problems.push("The verified services differ between the two observations");
  if (before.services.length === 0)
    problems.push("The observations verified no service");
  for (const service of before.services) {
    const later = after.services.find(
      (candidate) => candidate.serviceName === service.serviceName,
    );
    if (later) problems.push(...serviceProblems(service, later));
  }
  return problems;
}

/**
 * Binds a browser result to the release that actually served it. The operator
 * supplies both observations; a result can only become complete here, never in
 * the browser, and never from a self-declared boolean.
 */
export function finalize(input: {
  environment: string;
  origin: string;
  result: BrowserResult;
  before: unknown;
  after: unknown;
}) {
  const { result } = input;
  if (!isDeploymentOrigin(input.origin, input.environment))
    throw new JourneyRefused("The selected application origin is invalid");
  const before = checkReleaseReceipt(
    input.before,
    "before",
    input.environment,
    input.origin,
  );
  const after = checkReleaseReceipt(
    input.after,
    "after",
    input.environment,
    input.origin,
  );
  const problems = sameIdentities(before, after);
  if (before.origin !== result.origin)
    problems.push("The observations name a different origin than the journey");
  if (
    requireInstant(before.verifiedAt, "The first observation time") >
    requireInstant(result.startedAt, "The journey start time")
  )
    problems.push("The first observation is not before the journey started");
  if (
    requireInstant(after.verifiedAt, "The second observation time") <
    requireInstant(result.finishedAt, "The journey finish time")
  )
    problems.push("The second observation is not after the journey finished");
  const unverified = [
    ...result.unverified.filter(
      (reason) =>
        reason !== "Pending operator finalization against the deployed release",
    ),
    ...problems,
  ];
  return {
    ...result,
    status:
      unverified.length === 0 ? ("complete" as const) : ("incomplete" as const),
    unverified,
    release: after,
    observedBefore: before,
  };
}
