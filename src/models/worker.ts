import { and, asc, eq, isNull, lt, or, sql as dsql } from "drizzle-orm";

import { modelCalls, modelJobs, requests } from "../db/schema.ts";
import { newId, nowIso, withDb, type Db, type Tx } from "../workflow/shared.ts";
import {
  parseModelResult,
  safeParseModelResult,
  providerOutputSchema,
  type IntakeResult,
  type ModelReferences,
  type ModelResult,
} from "./contracts.ts";
import {
  buildProviderInput,
  collectCorpus,
  effectiveInput,
  type CorpusSnapshot,
} from "./corpus.ts";
import { reserveForDispatch } from "./jobs.ts";
import { persistFailedAssessment, persistProposals } from "./persist.ts";
import { modelPrompts } from "./prompts.ts";
import {
  isRecentWorkerProgress,
  recordWorkerProgress,
} from "./worker-health.ts";
import {
  actualCostMicros,
  defaultModel,
  maxOutputTokens,
  reservedCostMicros,
  resolveRates,
  type ModelProvider,
  type ModelProviderResult,
  type ModelRates,
} from "./provider.ts";

type JobRow = typeof modelJobs.$inferSelect;
export const maxAttemptsBeforeManualRetry = 2;

export interface WorkerOptions {
  provider: ModelProvider;
  workerId?: string;
  leaseSeconds?: number;
  model?: string;
  /** Required for a model outside the built-in price mapping. */
  rates?: ModelRates;
}

export type WorkerOutcome =
  | "succeeded"
  | "retry_queued"
  | "failed"
  | "capped"
  | "superseded"
  | "lease_lost";

export async function verifyWorkerDatabase() {
  return withDb(async (db) => {
    const [row] = await db.execute(
      dsql`SELECT to_regclass('model_jobs')::text AS jobs`,
    );
    if (!row?.jobs)
      throw new Error(
        "The worker database has no model_jobs table. Check DATABASE_URL and run db:migrate before starting the worker.",
      );
  });
}

export async function runWorkerLoop(
  options: WorkerOptions & {
    idleDelayMs?: number;
    signal?: AbortSignal;
    metricsIntervalMs?: number;
    healthFile?: string;
  },
): Promise<void> {
  const idleDelayMs = options.idleDelayMs ?? 2000;
  const metricsIntervalMs = options.metricsIntervalMs ?? 60_000;
  const counts = emptyOutcomeCounts();
  let nextMetricsAt = 0;
  let lastSuccessfulPollAt: number | null = null;
  while (!options.signal?.aborted) {
    if (options.healthFile) recordWorkerProgress(options.healthFile);
    const pass = await runOnceSafely(options, counts);
    if (pass.ok) {
      lastSuccessfulPollAt = Date.now();
      if (pass.processed) noteOutcome(counts, pass.processed);
    }
    if (Date.now() >= nextMetricsAt) {
      nextMetricsAt = Date.now() + metricsIntervalMs;
      await emitMetricsSafely(counts, lastSuccessfulPollAt);
    }
    if (!pass.processed) await sleep(idleDelayMs, options.signal);
  }
}

export async function runWorkerOnce(
  options: WorkerOptions,
): Promise<{ jobId: string; outcome: WorkerOutcome } | null> {
  return withDb(async (db) => {
    const job = await claimJob(
      db,
      options.workerId ?? `worker-${process.pid}`,
      options.leaseSeconds ?? 120,
    );
    if (!job) return null;
    const outcome = await processJob(db, job, options);
    return { jobId: job.id, outcome };
  });
}

async function processJob(
  db: Db,
  job: JobRow,
  options: WorkerOptions,
): Promise<WorkerOutcome> {
  const gate = await preDispatch(db, job);
  if ("outcome" in gate) return gate.outcome;
  const before = gate.before;
  const prompt = modelPrompts[job.purpose];
  const model = options.model ?? defaultModel;
  const rates = resolveRates(model, options.rates);
  const inputText = buildProviderInput(before.payload, before.corpus);
  const outputSchema = providerOutputSchema(job.purpose, before.corpus);

  const reservation = await reserveForDispatch(db, {
    jobId: job.id,
    leaseToken: job.leaseToken ?? "",
    provider: "anthropic",
    model,
    corpusVersions: before.corpus.corpusVersions,
    reservedMicros: reservedCostMicros(
      rates,
      prompt.system + inputText,
      outputSchema,
    ),
  });
  if (reservation.outcome === "lease_lost") return "lease_lost";
  if (reservation.outcome === "capped") return "capped";
  // Review closed between claim and reservation: the job is already settled
  // superseded and nothing was billed.
  if (reservation.outcome === "closed") return "superseded";

  // The provider call runs outside every transaction.
  const startedAt = Date.now();
  let output: ModelProviderResult;
  try {
    output = await options.provider.complete({
      model,
      system: prompt.system,
      input: inputText,
      maxOutputTokens,
      outputSchema,
      effort: prompt.effort,
    });
  } catch (error) {
    return settleFailure(db, job, {
      modelCallId: reservation.modelCallId,
      reason: safeProviderCode(error),
      usage: null,
      rates,
    });
  }
  const latencyMs = Date.now() - startedAt;

  const result = validateOutput(job.purpose, before.corpus, output);
  if ("error" in result) {
    return settleFailure(db, job, {
      modelCallId: reservation.modelCallId,
      reason: result.error,
      usage: {
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
      },
      rates,
    });
  }
  return finalizeSuccess(db, job, {
    modelCallId: reservation.modelCallId,
    result,
    usage: output,
    latencyMs,
    rates,
  });
}

export function validateOutput(
  purpose: JobRow["purpose"],
  corpus: ModelReferences,
  output: ModelProviderResult,
): ModelResult | { error: string } {
  if (output.stopReason === "max_tokens")
    return { error: "provider_output_limit" };
  if (output.stopReason === "refusal") return { error: "provider_refusal" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.outputText);
  } catch {
    return { error: "invalid_model_output_json" };
  }
  const validation = safeParseModelResult(purpose, parsed);
  if (!validation.success) return { error: "invalid_model_output_shape" };
  const result = validation.data;
  if (result.purpose === "intake_interpret") {
    const error = intakeCitationError(corpus, result.validated);
    return error ? { error } : result;
  }
  const hasUnknownCitation =
    result.purpose === "asset_match"
      ? result.validated.candidates.some(
          (candidate) => !corpus.catalogItemIds.has(candidate.catalogItemId),
        )
      : result.validated.findings.some(
          (finding) => !corpus.policyRuleIds.has(finding.policyRuleId),
        );
  return hasUnknownCitation ? { error: "unknown_identifier" } : result;
}

/**
 * Lease the oldest ready job under a fresh ownership token. An expired lease
 * is reclaimable; its interrupted reserved call is reconciled to failed at
 * its reserved cost — never assumed free.
 */
async function claimJob(
  db: Db,
  workerId: string,
  leaseSeconds: number,
): Promise<JobRow | null> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(modelJobs)
      .where(
        or(
          eq(modelJobs.status, "queued"),
          and(
            eq(modelJobs.status, "leased"),
            lt(modelJobs.leaseExpiresAt, dsql`now()`),
          ),
        ),
      )
      .orderBy(
        asc(modelJobs.createdAt),
        // Jobs enqueued in one transaction share a timestamp; claim them in
        // preparation order rather than by random id.
        dsql`case ${modelJobs.purpose}
          when 'intake_interpret' then 0
          when 'asset_match' then 1
          else 2 end`,
        asc(modelJobs.id),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;
    if (job.status === "leased" && job.currentModelCallId) {
      await tx
        .update(modelCalls)
        .set({
          status: "failed",
          sanitizedError: "lease_expired",
          completedAt: nowIso(),
        })
        .where(
          and(
            eq(modelCalls.id, job.currentModelCallId),
            eq(modelCalls.status, "reserved"),
          ),
        );
    }
    const leaseToken = newId();
    const expiry = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    await tx
      .update(modelJobs)
      .set({
        status: "leased",
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: expiry,
        updatedAt: nowIso(),
      })
      .where(eq(modelJobs.id, job.id));
    return { ...job, status: "leased" as const, leaseToken };
  });
}

/** The job row, locked, only while the caller's lease token still holds. */
async function lockOwnedJob(
  tx: Tx,
  jobId: string,
  leaseToken: string,
): Promise<JobRow | null> {
  const [job] = await tx
    .select()
    .from(modelJobs)
    .where(eq(modelJobs.id, jobId))
    .limit(1)
    .for("update");
  if (!job || job.status !== "leased" || job.leaseToken !== leaseToken)
    return null;
  return job;
}

interface UsageReport {
  inputTokens: number | null;
  outputTokens: number | null;
}

function usableCost(rates: ModelRates, usage: UsageReport | null) {
  if (
    usage &&
    usage.inputTokens !== null &&
    usage.outputTokens !== null &&
    usage.inputTokens >= 0 &&
    usage.outputTokens >= 0
  ) {
    return {
      actual: actualCostMicros(rates, usage.inputTokens, usage.outputTokens),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }
  // Without trustworthy actual usage the reservation is never released.
  return { actual: null, inputTokens: null, outputTokens: null };
}

/**
 * A worker that lost its lease still owns its ledger row's cost evidence.
 * The status never flips once the reclaim reconciled it; a row somehow still
 * reserved settles as failed.
 */
async function recordLateCallEvidence(
  tx: Tx,
  modelCallId: string,
  rates: ModelRates,
  usage: UsageReport | null,
): Promise<void> {
  const cost = usableCost(rates, usage);
  const [call] = await tx
    .select({ status: modelCalls.status })
    .from(modelCalls)
    .where(eq(modelCalls.id, modelCallId))
    .limit(1)
    .for("update");
  if (!call) return;
  if (call.status === "reserved") {
    await tx
      .update(modelCalls)
      .set({
        status: "failed",
        sanitizedError: "lease_lost",
        actualCostMicros: cost.actual,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        completedAt: nowIso(),
      })
      .where(eq(modelCalls.id, modelCallId));
    return;
  }
  await tx
    .update(modelCalls)
    .set({
      actualCostMicros: cost.actual,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
    })
    .where(
      and(eq(modelCalls.id, modelCallId), isNull(modelCalls.actualCostMicros)),
    );
}

interface FreshState {
  stale: boolean;
  corpus: CorpusSnapshot;
  payload: Record<string, unknown>;
}

async function freshState(reader: Db | Tx, job: JobRow): Promise<FreshState> {
  const effective = await effectiveInput(
    reader,
    job.purpose,
    job.draftId,
    job.requestId ?? undefined,
  );
  const corpus = await collectCorpus(reader, job.purpose);
  const stale =
    effective.hash !== job.inputHash ||
    corpus.hash !== job.corpusHash ||
    effective.revisionId !== job.revisionId ||
    effective.requestGeneration !== job.requestGeneration;
  return { stale, corpus, payload: effective.payload };
}

/** Settle the job with plain fields, only while the lease still holds. */
async function settleOwned(
  db: Db,
  job: JobRow,
  set: Record<string, unknown>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const owned = await lockOwnedJob(tx, job.id, job.leaseToken ?? "");
    if (!owned) return false;
    await tx
      .update(modelJobs)
      .set({
        ...set,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(modelJobs.id, job.id));
    return true;
  });
}

interface FailureArgs {
  modelCallId: string;
  reason: string;
  usage: UsageReport | null;
  rates: ModelRates;
}

/**
 * Settlements lock the request (when the draft has one) before the job row —
 * the same order every review action uses (request first, then task or job
 * writes) — so a settlement never deadlocks with or races an approval or an
 * answer committing on the same request.
 */
async function lockRequestForDraft(
  tx: Tx,
  draftId: string,
): Promise<{ id: string; stage: string } | null> {
  const [request] = await tx
    .select({ id: requests.id, stage: requests.stage })
    .from(requests)
    .where(eq(requests.sourceDraftId, draftId))
    .for("update");
  return request ?? null;
}

/**
 * Once first review completed, no result may materialize new current
 * proposals: the ledger keeps the call receipt, the job reads superseded,
 * and the evidence the humans actually reviewed stays what the API shows.
 */
function reviewClosed(request: { stage: string } | null): boolean {
  return request?.stage === "first_review_completed";
}

async function settleFailure(
  db: Db,
  job: JobRow,
  { modelCallId, reason, usage, rates }: FailureArgs,
): Promise<WorkerOutcome> {
  const safeReason = reason.slice(0, 200);
  return db.transaction(async (tx) => {
    const lockedRequest = await lockRequestForDraft(tx, job.draftId);
    const owned = await lockOwnedJob(tx, job.id, job.leaseToken ?? "");
    if (!owned) {
      await recordLateCallEvidence(tx, modelCallId, rates, usage);
      return "lease_lost";
    }
    const cost = usableCost(rates, usage);
    await tx
      .update(modelCalls)
      .set({
        status: "failed",
        sanitizedError: safeReason,
        actualCostMicros: cost.actual,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        completedAt: nowIso(),
      })
      .where(eq(modelCalls.id, modelCallId));
    if (owned.attemptCount >= maxAttemptsBeforeManualRetry) {
      await tx
        .update(modelJobs)
        .set({
          status: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          sanitizedError: safeReason,
          updatedAt: nowIso(),
        })
        .where(eq(modelJobs.id, job.id));
      if (!reviewClosed(lockedRequest))
        await persistFailedAssessment(tx, {
          purpose: owned.purpose,
          draftId: owned.draftId,
          revisionId: owned.revisionId,
          requestGeneration: owned.requestGeneration,
          modelCallId,
          corpusHash: owned.corpusHash,
          sanitizedError: safeReason,
        });
      return "failed";
    }
    await tx
      .update(modelJobs)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        sanitizedError: safeReason,
        updatedAt: nowIso(),
      })
      .where(eq(modelJobs.id, job.id));
    return "retry_queued";
  });
}

/**
 * The combined intake result cites two corpora and may carry one requester
 * suggestion. The suggestion must reference a record of its kind that also
 * appears in the matching candidate list — a suggestion pointing at
 * something the result did not evaluate is a bad output, never surfaced.
 */
function intakeCitationError(
  corpus: ModelReferences,
  result: IntakeResult,
): string | null {
  const serviceIds = result.services.map((service) => service.offeringId);
  const assetIds = result.assets.map((candidate) => candidate.catalogItemId);
  const citedKeys = result.services.flatMap(
    (service) => service.relatedOfferingKeys,
  );
  if (serviceIds.some((id) => !corpus.offeringIds.has(id)))
    return "unknown_identifier";
  if (assetIds.some((id) => !corpus.catalogItemIds.has(id)))
    return "unknown_identifier";
  if (citedKeys.some((key) => !corpus.offeringKeys.has(key)))
    return "unknown_identifier";
  const suggestion = result.requesterSuggestion;
  if (suggestion) {
    const pool = suggestion.kind === "service" ? serviceIds : assetIds;
    if (!pool.includes(suggestion.id)) return "unknown_identifier";
  }
  return null;
}

interface SuccessArgs {
  modelCallId: string;
  result: ModelResult;
  usage: ModelProviderResult;
  latencyMs: number;
  rates: ModelRates;
}

async function finalizeSuccess(
  db: Db,
  job: JobRow,
  { modelCallId, result, usage, latencyMs, rates }: SuccessArgs,
): Promise<WorkerOutcome> {
  const { validated } = result;
  return db.transaction(async (tx) => {
    const lockedRequest = await lockRequestForDraft(tx, job.draftId);
    const owned = await lockOwnedJob(tx, job.id, job.leaseToken ?? "");
    if (!owned) {
      // The result arrived after a reclaim: cost evidence stays, proposals
      // never become current from a lost lease.
      await recordLateCallEvidence(tx, modelCallId, rates, usage);
      return "lease_lost";
    }
    const cost = usableCost(rates, usage);
    await tx
      .update(modelCalls)
      .set({
        status: "succeeded",
        validatedOutput: validated,
        actualCostMicros: cost.actual,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        latencyMs,
        completedAt: nowIso(),
      })
      .where(eq(modelCalls.id, modelCallId));
    // The fresh row carries any request/revision attached while the call ran;
    // a result for content or corpus that moved on is provenance, never the
    // current proposal set. The same holds once review closed: the receipt
    // above stays, but nothing new becomes current.
    const now = await freshState(tx, owned);
    if (now.stale || reviewClosed(lockedRequest)) {
      await tx
        .update(modelJobs)
        .set({
          status: "superseded",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: nowIso(),
        })
        .where(eq(modelJobs.id, job.id));
      return "superseded";
    }
    await persistProposals(tx, {
      ...parseModelResult(owned.purpose, validated),
      draftId: owned.draftId,
      revisionId: owned.revisionId,
      requestGeneration: owned.requestGeneration,
      modelCallId,
      corpus: now.corpus,
    });
    await tx
      .update(modelJobs)
      .set({
        status: "succeeded",
        leaseOwner: null,
        leaseExpiresAt: null,
        sanitizedError: null,
        updatedAt: nowIso(),
      })
      .where(eq(modelJobs.id, job.id));
    return "succeeded";
  });
}

async function failDurablyBeforeDispatch(
  db: Db,
  job: JobRow,
  reason: string,
): Promise<WorkerOutcome> {
  return db.transaction(async (tx) => {
    const lockedRequest = await lockRequestForDraft(tx, job.draftId);
    const owned = await lockOwnedJob(tx, job.id, job.leaseToken ?? "");
    if (!owned) return "lease_lost";
    await tx
      .update(modelJobs)
      .set({
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        sanitizedError: reason,
        updatedAt: nowIso(),
      })
      .where(eq(modelJobs.id, job.id));
    if (!reviewClosed(lockedRequest))
      await persistFailedAssessment(tx, {
        purpose: owned.purpose,
        draftId: owned.draftId,
        revisionId: owned.revisionId,
        requestGeneration: owned.requestGeneration,
        modelCallId: owned.currentModelCallId,
        corpusHash: owned.corpusHash,
        sanitizedError: reason,
      });
    return "failed";
  });
}

/** Pre-dispatch gates: staleness, prompt drift, and exhausted attempts. */
async function preDispatch(
  db: Db,
  job: JobRow,
): Promise<{ outcome: WorkerOutcome } | { before: FreshState }> {
  const before = await freshState(db, job);
  const promptDrifted = modelPrompts[job.purpose].version !== job.promptVersion;
  if (before.stale || promptDrifted) {
    const settled = await settleOwned(db, job, {
      status: "superseded",
      sanitizedError: null,
    });
    return { outcome: settled ? "superseded" : "lease_lost" };
  }
  if (job.attemptCount >= maxAttemptsBeforeManualRetry) {
    return {
      outcome: await failDurablyBeforeDispatch(db, job, "attempts_exhausted"),
    };
  }
  return { before };
}

function safeProviderCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^provider_[a-z0-9_]+$/.test(message) ? message : "provider_error";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

type WorkerCounts = Record<WorkerOutcome | "poll_error", number>;

const outcomeMetricNames: Record<keyof WorkerCounts, string> = {
  succeeded: "JobsSucceeded",
  retry_queued: "JobsRetryQueued",
  failed: "JobsFailed",
  capped: "JobsCapped",
  superseded: "JobsSuperseded",
  lease_lost: "JobsLeaseLost",
  poll_error: "WorkerPollErrors",
};

function emptyOutcomeCounts(): WorkerCounts {
  return {
    succeeded: 0,
    retry_queued: 0,
    failed: 0,
    capped: 0,
    superseded: 0,
    lease_lost: 0,
    poll_error: 0,
  };
}

/**
 * One CloudWatch Embedded Metric Format line on stdout. Dimensions stay on
 * the two stable identifiers; job and worker ids belong in log fields only,
 * never in dimensions, so metric cardinality stays bounded.
 */
export async function emitWorkerMetrics(
  counts: WorkerCounts,
  lastSuccessfulPollAt: number | null,
): Promise<void> {
  const metrics: Record<string, number> = {
    Heartbeat: Number(isRecentWorkerProgress(lastSuccessfulPollAt)),
    QueueCollectionSucceeded: 0,
  };
  try {
    const queue = await workerQueueMetrics();
    metrics.QueueCollectionSucceeded = 1;
    metrics.QueuedJobs = queue.queued;
    metrics.OldestQueuedAgeSeconds = queue.oldest_seconds;
  } catch (error) {
    console.error("model worker queue metrics failed", {
      kind: error instanceof Error ? error.name : "unknown",
    });
  }
  for (const [outcome, name] of Object.entries(outcomeMetricNames))
    metrics[name] = counts[outcome as keyof WorkerCounts];
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "OneDoor/Worker",
            Dimensions: [["Service", "Environment"]],
            Metrics: Object.keys(metrics).map((name) => ({
              Name: name,
              Unit: name === "OldestQueuedAgeSeconds" ? "Seconds" : "Count",
            })),
          },
        ],
      },
      Service: "one-door-worker",
      Environment: process.env.ONE_DOOR_ENVIRONMENT || "local",
      LastSuccessfulPollAt: lastSuccessfulPollAt,
      ...metrics,
    }),
  );
}

async function workerQueueMetrics(): Promise<{
  queued: number;
  oldest_seconds: number;
}> {
  const queue = await withDb(async (db) => {
    const [row] = await db.execute(dsql`
      SELECT count(*)::int AS queued,
             coalesce(extract(epoch FROM now() - min(created_at)), 0)::int AS oldest_seconds
      FROM model_jobs
      WHERE status = 'queued'
         OR (status = 'leased' AND lease_expires_at < now())
    `);
    return row as { queued: number; oldest_seconds: number } | undefined;
  });
  if (
    !queue ||
    !Number.isSafeInteger(queue.queued) ||
    queue.queued < 0 ||
    !Number.isSafeInteger(queue.oldest_seconds) ||
    queue.oldest_seconds < 0
  )
    throw new Error("Worker queue measurements are unconfirmed");
  return queue;
}

async function runOnceSafely(options: WorkerOptions, counts: WorkerCounts) {
  try {
    return { ok: true as const, processed: await runWorkerOnce(options) };
  } catch (error) {
    counts.poll_error += 1;
    console.error("model worker pass failed", {
      kind: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false as const, processed: null };
  }
}

function noteOutcome(
  counts: Record<WorkerOutcome, number>,
  processed: { jobId: string; outcome: WorkerOutcome },
): void {
  counts[processed.outcome] += 1;
  // Ids only; job content never reaches worker logs.
  console.log(
    JSON.stringify({
      event: "model_job_outcome",
      jobId: processed.jobId,
      outcome: processed.outcome,
    }),
  );
}

async function emitMetricsSafely(
  counts: WorkerCounts,
  lastSuccessfulPollAt: number | null,
): Promise<void> {
  try {
    await emitWorkerMetrics(counts, lastSuccessfulPollAt);
    Object.assign(counts, emptyOutcomeCounts());
  } catch (error) {
    console.error("model worker metrics failed", {
      kind: error instanceof Error ? error.name : "unknown",
    });
  }
}
