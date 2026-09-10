import { and, desc, eq, ne, sql as dsql } from "drizzle-orm";
import { z } from "zod";

import {
  assetAssessments,
  modelCalls,
  modelJobs,
  requests,
} from "../db/schema.ts";
import { WorkflowError } from "../workflow/errors.ts";
import {
  isUniqueViolation,
  newId,
  nowIso,
  parseInput,
  requireVisitor,
  uuidSchema,
  withDb,
  withReadSnapshot,
  type Db,
  type Tx,
} from "../workflow/shared.ts";
import { assetResultSchema } from "./contracts.ts";
import { collectCorpus, effectiveInput } from "./corpus.ts";
import { modelPrompts } from "./prompts.ts";
import { persistProposals } from "./persist.ts";

/** Agreed demo limits: 20 calls/browser/day, 100 calls/day, $50/month. */
export const modelCaps = {
  visitorDailyCalls: 20,
  globalDailyCalls: 100,
  monthlySpendMicros: 50_000_000,
} as const;

/** Serializes spend reservations; the migration runner uses 9248661. */
const SPEND_LOCK = 9248662;

export interface SpendUsage {
  visitorDailyCalls: number;
  globalDailyCalls: number;
  monthlySpendMicros: number;
}

/**
 * Live usage from the model-call ledger. A reserved call with no outcome
 * counts at its reserved cost until reconciled; denied rows never count.
 */
async function readUsage(
  reader: Db | Tx,
  visitorId: string | null,
): Promise<SpendUsage> {
  const [row] = await reader
    .select({
      visitorDaily: dsql<number>`count(*) filter (
        where created_at >= date_trunc('day', now())
          and visitor_id = ${visitorId})::int`,
      globalDaily: dsql<number>`count(*) filter (
        where created_at >= date_trunc('day', now()))::int`,
      monthlyMicros: dsql<number>`coalesce(sum(
        coalesce(actual_cost_micros, reserved_cost_micros)) filter (
        where created_at >= date_trunc('month', now())), 0)::bigint`,
    })
    .from(modelCalls)
    .where(and(eq(modelCalls.origin, "live"), ne(modelCalls.status, "denied")));
  return {
    visitorDailyCalls: Number(row.visitorDaily),
    globalDailyCalls: Number(row.globalDaily),
    monthlySpendMicros: Number(row.monthlyMicros),
  };
}

function capBucket(used: number, cap: number) {
  return { used, cap, warn: used >= cap * 0.8, exceeded: used >= cap };
}

/** Current usage against every cap, with the 80% warning signal. */
export async function getQuotaStatus(visitorIdInput?: unknown) {
  const visitorId =
    visitorIdInput === undefined
      ? null
      : parseInput(uuidSchema, visitorIdInput);
  return withDb(async (db) => {
    const usage = await readUsage(db, visitorId);
    return {
      visitorDaily: capBucket(
        usage.visitorDailyCalls,
        modelCaps.visitorDailyCalls,
      ),
      globalDaily: capBucket(
        usage.globalDailyCalls,
        modelCaps.globalDailyCalls,
      ),
      monthlySpend: capBucket(
        usage.monthlySpendMicros,
        modelCaps.monthlySpendMicros,
      ),
    };
  });
}

export interface ReservationArgs {
  jobId: string;
  /** The claiming worker's token; a reclaimed lease loses the reservation. */
  leaseToken: string;
  provider: string;
  model: string;
  reservedMicros: number;
  corpusVersions: Record<string, unknown>;
}

export type ReservationResult =
  | {
      outcome: "reserved";
      modelCallId: string;
      attempt: number;
      visitorId: string | null;
    }
  | { outcome: "capped"; reason: string; modelCallId: string }
  | { outcome: "closed" }
  | { outcome: "lease_lost" };

function capDenialReason(
  usage: SpendUsage,
  visitorId: string | null,
  reservedMicros: number,
): string | null {
  if (
    visitorId !== null &&
    usage.visitorDailyCalls >= modelCaps.visitorDailyCalls
  )
    return "quota_visitor_daily";
  if (usage.globalDailyCalls >= modelCaps.globalDailyCalls)
    return "quota_global_daily";
  if (usage.monthlySpendMicros + reservedMicros > modelCaps.monthlySpendMicros)
    return "quota_monthly_spend";
  return null;
}

/**
 * Reserve spend for one dispatch under the database lock, before any network
 * call. The job row is locked first and must still belong to the caller's
 * lease token. Denial writes a denied ledger row and marks the job capped in
 * the same transaction, so a capped preparation is honest and durable. The
 * charged visitor is the job's current initiating visitor.
 */

/**
 * The reservation is the billing commitment, so the closed-review check
 * happens here under the request lock (taken before the job lock, the order
 * every review action uses). An approval committing before this point
 * prevents the bill; one committing during the provider call is caught at
 * settlement, which supersedes the result but keeps the receipt for the
 * money already spent. Returns a terminal outcome, or null to proceed.
 */
async function closedReviewGate(
  tx: Tx,
  jobId: string,
  leaseToken: string,
): Promise<ReservationResult | null> {
  const [peek] = await tx
    .select({ draftId: modelJobs.draftId })
    .from(modelJobs)
    .where(eq(modelJobs.id, jobId))
    .limit(1);
  if (!peek) return { outcome: "lease_lost" as const };
  const [request] = await tx
    .select({ stage: requests.stage })
    .from(requests)
    .where(eq(requests.sourceDraftId, peek.draftId))
    .for("update");
  if (request?.stage !== "first_review_completed") return null;
  const [job] = await tx
    .select({ leaseToken: modelJobs.leaseToken, status: modelJobs.status })
    .from(modelJobs)
    .where(eq(modelJobs.id, jobId))
    .limit(1)
    .for("update");
  if (!job || job.status !== "leased" || job.leaseToken !== leaseToken)
    return { outcome: "lease_lost" as const };
  await tx
    .update(modelJobs)
    .set({
      status: "superseded",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: nowIso(),
    })
    .where(eq(modelJobs.id, jobId));
  return { outcome: "closed" as const };
}

/** The whole-draft intake attempt budget, retries included. */
export const intakeAttemptBudget = 2;

/**
 * Provider attempts already spent on this draft's intake purpose. Denied
 * rows never reached the provider and do not count; failed and succeeded
 * attempts both do — a retry is an attempt.
 */
export async function intakeAttemptsUsed(
  reader: Db | Tx,
  draftId: string,
): Promise<number> {
  const [row] = await reader
    .select({ total: dsql<number>`count(*)::int` })
    .from(modelCalls)
    .where(
      and(
        eq(modelCalls.draftId, draftId),
        eq(modelCalls.purpose, "intake_interpret"),
        eq(modelCalls.origin, "live"),
        ne(modelCalls.status, "denied"),
      ),
    );
  return Number(row.total);
}

type JobRowForBudget = typeof modelJobs.$inferSelect;

async function denyOverBudgetIntake(
  tx: Tx,
  job: JobRowForBudget,
  args: ReservationArgs,
): Promise<ReservationResult | null> {
  if (job.purpose !== "intake_interpret") return null;
  if ((await intakeAttemptsUsed(tx, job.draftId)) < intakeAttemptBudget)
    return null;
  const budgetCallId = newId();
  await tx.insert(modelCalls).values({
    id: budgetCallId,
    draftId: job.draftId,
    visitorId: job.visitorId,
    purpose: job.purpose,
    provider: args.provider,
    model: args.model,
    promptVersion: job.promptVersion,
    inputHash: job.inputHash,
    corpusVersions: args.corpusVersions,
    status: "denied",
    attemptCount: job.attemptCount + 1,
    reservedCostMicros: 0,
    sanitizedError: "intake_call_budget",
    idempotencyKey: newId(),
    origin: "live",
    completedAt: nowIso(),
  });
  await tx
    .update(modelJobs)
    .set({
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      currentModelCallId: budgetCallId,
      sanitizedError: "intake_call_budget",
      updatedAt: nowIso(),
    })
    .where(eq(modelJobs.id, args.jobId));
  return {
    outcome: "capped" as const,
    reason: "intake_call_budget",
    modelCallId: budgetCallId,
  };
}

export async function reserveForDispatch(
  db: Db,
  args: ReservationArgs,
): Promise<ReservationResult> {
  return db.transaction(async (tx) => {
    const gate = await closedReviewGate(tx, args.jobId, args.leaseToken);
    if (gate) return gate;
    const [job] = await tx
      .select()
      .from(modelJobs)
      .where(eq(modelJobs.id, args.jobId))
      .limit(1)
      .for("update");
    if (!job || job.status !== "leased" || job.leaseToken !== args.leaseToken)
      return { outcome: "lease_lost" as const };

    await tx.execute(dsql`select pg_advisory_xact_lock(${SPEND_LOCK})`);
    // Central intake budget: every dispatch path converges here, so an old
    // API hole cannot buy a third attempt. The denial is a durable receipt
    // and the job ends failed — manual OIT-routed submission stays open.
    const budgetDenied = await denyOverBudgetIntake(tx, job, args);
    if (budgetDenied) return budgetDenied;
    const usage = await readUsage(tx, job.visitorId);
    const reason = capDenialReason(usage, job.visitorId, args.reservedMicros);
    const attempt = job.attemptCount + 1;
    const modelCallId = newId();
    await tx.insert(modelCalls).values({
      id: modelCallId,
      draftId: job.draftId,
      visitorId: job.visitorId,
      purpose: job.purpose,
      provider: args.provider,
      model: args.model,
      promptVersion: job.promptVersion,
      inputHash: job.inputHash,
      corpusVersions: args.corpusVersions,
      status: reason ? "denied" : "reserved",
      attemptCount: attempt,
      reservedCostMicros: reason ? 0 : args.reservedMicros,
      sanitizedError: reason,
      idempotencyKey: newId(),
      origin: "live",
      completedAt: reason ? nowIso() : null,
    });
    if (reason) {
      await tx
        .update(modelJobs)
        .set({
          status: "capped",
          leaseOwner: null,
          leaseExpiresAt: null,
          currentModelCallId: modelCallId,
          sanitizedError: reason,
          updatedAt: nowIso(),
        })
        .where(eq(modelJobs.id, args.jobId));
      return { outcome: "capped" as const, reason, modelCallId };
    }
    await tx
      .update(modelJobs)
      .set({
        attemptCount: attempt,
        currentModelCallId: modelCallId,
        updatedAt: nowIso(),
      })
      .where(eq(modelJobs.id, args.jobId));
    return {
      outcome: "reserved" as const,
      modelCallId,
      attempt,
      visitorId: job.visitorId,
    };
  });
}

const enqueueSchema = z.object({
  purpose: z.enum(["intake_interpret", "asset_match", "risk_assess"]),
  draftId: uuidSchema,
  requestId: uuidSchema.optional(),
});
type ModelPurposeInput = z.infer<typeof enqueueSchema>["purpose"];

/**
 * Create or reuse the one logical job for (purpose, effective input, corpus,
 * prompt version). A changed input or corpus supersedes older undone jobs
 * for the same purpose. When a succeeded asset job matches a submitted
 * revision's unchanged content, the stored result attaches to that revision
 * instead of paying for a new call. The trusted initiating visitor is
 * required and is the one charged for dispatch.
 */
export async function enqueueModelJob(
  ctx: { visitorId?: string },
  input: unknown,
) {
  const data = parseInput(enqueueSchema, input);
  const visitorId = parseInput(uuidSchema, ctx?.visitorId);
  return withDb(async (db) => {
    try {
      return await enqueueOnce(db, visitorId, data);
    } catch (error) {
      // A concurrent enqueue of the same logical job wins identically.
      if (!isUniqueViolation(error, "model_jobs_logical_unique")) throw error;
      return enqueueOnce(db, visitorId, data);
    }
  });
}

async function enqueueOnce(
  db: Db,
  visitorId: string,
  data: z.infer<typeof enqueueSchema>,
) {
  return db.transaction(async (tx) => enqueueJobInTx(tx, visitorId, data));
}

/**
 * Create or reuse the logical job inside the caller's open transaction, so a
 * submission or answer commits its preparation jobs atomically with its
 * other rows. Queues only; no provider call happens here.
 */
export async function enqueueJobInTx(
  tx: Tx,
  visitorId: string,
  data: { purpose: ModelPurposeInput; draftId: string; requestId?: string },
) {
  {
    await requireVisitor(tx, visitorId);
    const effective = await effectiveInput(
      tx,
      data.purpose,
      data.draftId,
      data.requestId,
    );
    const corpus = await collectCorpus(tx, data.purpose);
    const promptVersion = modelPrompts[data.purpose].version;
    const [existing] = await tx
      .select()
      .from(modelJobs)
      .where(
        and(
          eq(modelJobs.purpose, data.purpose),
          eq(modelJobs.draftId, data.draftId),
          eq(modelJobs.inputHash, effective.hash),
          eq(modelJobs.corpusHash, corpus.hash),
          eq(modelJobs.promptVersion, promptVersion),
          eq(modelJobs.requestGeneration, effective.requestGeneration),
        ),
      )
      .limit(1);
    if (existing) {
      if (data.requestId && existing.requestId === null) {
        await tx
          .update(modelJobs)
          .set({
            requestId: data.requestId,
            revisionId: effective.revisionId,
            updatedAt: nowIso(),
          })
          .where(eq(modelJobs.id, existing.id));
      }
      let reused = false;
      if (existing.status === "succeeded") {
        reused = await attachRevisionReuse(tx, existing, effective.revisionId);
      }
      return { jobId: existing.id, status: existing.status, reused };
    }

    await requireIntakeBudget(tx, data);

    // A different effective input or corpus makes older undone jobs stale.
    await tx
      .update(modelJobs)
      .set({ status: "superseded", updatedAt: nowIso() })
      .where(
        and(
          eq(modelJobs.purpose, data.purpose),
          eq(modelJobs.draftId, data.draftId),
          dsql`${modelJobs.status} in ('queued', 'failed', 'capped')`,
        ),
      );

    const jobId = newId();
    await tx.insert(modelJobs).values({
      id: jobId,
      purpose: data.purpose,
      draftId: data.draftId,
      requestId: effective.requestId,
      revisionId: effective.revisionId,
      visitorId,
      inputHash: effective.hash,
      corpusHash: corpus.hash,
      promptVersion,
      requestGeneration: effective.requestGeneration,
      status: "queued",
      inputSnapshot: effective.payload,
      corpusSnapshot: {
        hash: corpus.hash,
        versions: corpus.corpusVersions,
        records: corpus.detail,
      },
    });
    return { jobId, status: "queued" as const, reused: false };
  }
}

async function requireIntakeBudget(
  tx: Tx,
  data: { purpose: ModelPurposeInput; draftId: string },
) {
  if (
    data.purpose === "intake_interpret" &&
    (await intakeAttemptsUsed(tx, data.draftId)) >= intakeAttemptBudget
  )
    throw new WorkflowError(
      "INVALID_STATE",
      "intake call budget exhausted for this draft",
    );
}

/**
 * Reuse an unchanged asset result for a submitted revision: append a fresh
 * assessment for the revision from the stored validated output. Assessment
 * rows are immutable, so reuse appends rather than edits.
 */
async function attachRevisionReuse(
  tx: Tx,
  job: typeof modelJobs.$inferSelect,
  revisionId: string | null,
): Promise<boolean> {
  if (job.purpose !== "asset_match" || !revisionId || !job.currentModelCallId)
    return false;
  const [attached] = await tx
    .select({ id: assetAssessments.id })
    .from(assetAssessments)
    .where(
      and(
        eq(assetAssessments.modelCallId, job.currentModelCallId),
        eq(assetAssessments.revisionId, revisionId),
      ),
    )
    .limit(1);
  if (attached) return false;
  const [call] = await tx
    .select()
    .from(modelCalls)
    .where(eq(modelCalls.id, job.currentModelCallId))
    .limit(1);
  if (!call?.validatedOutput) return false;
  const corpus = await collectCorpus(tx, "asset_match");
  if (corpus.hash !== job.corpusHash) return false;
  const validated = assetResultSchema.parse(call.validatedOutput);
  await persistProposals(tx, {
    purpose: "asset_match",
    draftId: job.draftId,
    revisionId,
    requestGeneration: job.requestGeneration,
    modelCallId: call.id,
    corpus,
    validated,
  });
  return true;
}

/** Internal read: one job with its latest ledger entry. */
export async function getModelJob(jobIdInput: unknown) {
  const jobId = parseInput(uuidSchema, jobIdInput);
  return withDb(async (db) => {
    const [job] = await db
      .select()
      .from(modelJobs)
      .where(eq(modelJobs.id, jobId))
      .limit(1);
    if (!job) throw new WorkflowError("NOT_FOUND", "model job");
    const call = job.currentModelCallId
      ? (
          await db
            .select({
              id: modelCalls.id,
              status: modelCalls.status,
              attemptCount: modelCalls.attemptCount,
              reservedCostMicros: modelCalls.reservedCostMicros,
              actualCostMicros: modelCalls.actualCostMicros,
              sanitizedError: modelCalls.sanitizedError,
              validatedOutput: modelCalls.validatedOutput,
              completedAt: modelCalls.completedAt,
            })
            .from(modelCalls)
            .where(eq(modelCalls.id, job.currentModelCallId))
            .limit(1)
        )[0]
      : null;
    return {
      jobId: job.id,
      purpose: job.purpose,
      draftId: job.draftId,
      requestId: job.requestId,
      revisionId: job.revisionId,
      status: job.status,
      attemptCount: job.attemptCount,
      inputHash: job.inputHash,
      corpusHash: job.corpusHash,
      promptVersion: job.promptVersion,
      sanitizedError: job.sanitizedError,
      inputSnapshot: job.inputSnapshot,
      corpusSnapshot: job.corpusSnapshot,
      currentCall: call ?? null,
    };
  });
}

/** Internal read: every job for a draft, newest first. */
export async function listDraftJobs(draftIdInput: unknown, reader?: Tx) {
  const draftId = parseInput(uuidSchema, draftIdInput);
  return withReadSnapshot(
    (db) =>
      db
        .select({
          jobId: modelJobs.id,
          purpose: modelJobs.purpose,
          status: modelJobs.status,
          attemptCount: modelJobs.attemptCount,
          revisionId: modelJobs.revisionId,
          sanitizedError: modelJobs.sanitizedError,
          createdAt: modelJobs.createdAt,
        })
        .from(modelJobs)
        .where(eq(modelJobs.draftId, draftId))
        .orderBy(desc(modelJobs.createdAt), desc(modelJobs.id)),
    reader,
  );
}

const retrySchema = z.object({ jobId: uuidSchema });

/**
 * Manual retry of a durably failed or capped job. The job row is the
 * one-active-job rule; dispatch re-checks quota like any other attempt. The
 * retrying visitor becomes the charged initiator for the new attempts, so
 * reviewer retries are not billed to the requester.
 */
export async function retryModelJob(
  ctx: { visitorId?: string },
  input: unknown,
) {
  const data = parseInput(retrySchema, input);
  const visitorId = parseInput(uuidSchema, ctx?.visitorId);
  return withDb((db) =>
    db.transaction(async (tx) => {
      await requireVisitor(tx, visitorId);
      const [job] = await tx
        .select()
        .from(modelJobs)
        .where(eq(modelJobs.id, data.jobId))
        .limit(1)
        .for("update");
      if (!job) throw new WorkflowError("NOT_FOUND", "model job");
      if (job.status !== "failed" && job.status !== "capped")
        throw new WorkflowError(
          "INVALID_STATE",
          `job is ${job.status}, not retryable`,
        );
      await tx
        .update(modelJobs)
        .set({
          status: "queued",
          attemptCount: 0,
          visitorId,
          sanitizedError: null,
          updatedAt: nowIso(),
        })
        .where(eq(modelJobs.id, job.id));
      return { jobId: job.id, status: "queued" as const };
    }),
  );
}
