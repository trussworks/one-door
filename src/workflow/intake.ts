import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  assetAssessments,
  assetCandidates,
  assetFitDecisions,
  catalogItems,
  draftTurns,
  drafts,
  modelCalls,
  modelJobs,
  serviceCandidates,
  serviceOfferings,
} from "../db/schema.ts";
import { canonicalJson } from "../models/contracts.ts";
import { collectCorpus, effectiveInput } from "../models/corpus.ts";
import { enqueueJobInTx } from "../models/jobs.ts";
import { modelPrompts } from "../models/prompts.ts";
import { WorkflowError } from "./errors.ts";
import {
  insertAudit,
  newId,
  nowIso,
  parseInput,
  requestContentSchema,
  requireVersion,
  requireVisitor,
  uuidSchema,
  withDb,
  withReadSnapshot,
  type Db,
  type Tx,
  type VisitorContext,
} from "./shared.ts";

type DraftRow = typeof drafts.$inferSelect;

export async function lockOwnDraft(
  tx: Tx,
  visitorId: string,
  draftId: string,
): Promise<DraftRow> {
  const [draft] = await tx
    .select()
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .limit(1)
    .for("update");
  if (!draft) throw new WorkflowError("NOT_FOUND", "draft");
  if (draft.visitorId !== visitorId)
    throw new WorkflowError("NOT_OWNER", "draft");
  if (draft.state === "submitted")
    throw new WorkflowError("INVALID_STATE", "draft already submitted");
  return draft;
}

export async function ownedIntakeJob(tx: Tx, draftId: string, jobId: string) {
  const [job] = await tx
    .select()
    .from(modelJobs)
    .where(and(eq(modelJobs.id, jobId), eq(modelJobs.draftId, draftId)))
    .limit(1);
  if (!job || job.purpose !== "intake_interpret")
    throw new WorkflowError("NOT_FOUND", "intake job");
  return job;
}

/** True when the succeeded job matches the current input, corpus, prompt. */
async function intakeJobIsCurrent(
  tx: Tx,
  draftId: string,
  job: typeof modelJobs.$inferSelect,
): Promise<boolean> {
  if (job.status !== "succeeded") return false;
  const effective = await effectiveInput(tx, "intake_interpret", draftId);
  const corpus = await collectCorpus(tx, "intake_interpret");
  return (
    effective.hash === job.inputHash &&
    corpus.hash === job.corpusHash &&
    job.promptVersion === modelPrompts.intake_interpret.version
  );
}

async function requireCurrentIntakeJob(tx: Tx, draftId: string, jobId: string) {
  const job = await ownedIntakeJob(tx, draftId, jobId);
  if (job.status !== "succeeded")
    throw new WorkflowError("INVALID_STATE", `intake job is ${job.status}`);
  if (!(await intakeJobIsCurrent(tx, draftId, job)))
    throw new WorkflowError(
      "INVALID_STATE",
      "intake result is stale for the current input",
    );
  return job;
}

function withoutContent(payload: Record<string, unknown>) {
  const rest = { ...payload };
  delete rest.content;
  return rest;
}

/**
 * Exact adoption stays valid evidence: the confirmed content still equals
 * the model's proposed content, the raw need and answered conversation are
 * unchanged since the run (compared against the job's immutable input
 * snapshot), and the offering corpus and prompt are still current.
 */
async function adoptedExactCurrent(
  tx: Db | Tx,
  draft: DraftRow,
  job: typeof modelJobs.$inferSelect,
): Promise<boolean> {
  if (draft.confirmedIntakeJobId !== job.id) return false;
  if (job.status !== "succeeded" || !job.currentModelCallId) return false;
  const corpus = await collectCorpus(tx, "intake_interpret");
  if (
    corpus.hash !== job.corpusHash ||
    job.promptVersion !== modelPrompts.intake_interpret.version
  )
    return false;
  const [call] = await tx
    .select({ validatedOutput: modelCalls.validatedOutput })
    .from(modelCalls)
    .where(eq(modelCalls.id, job.currentModelCallId))
    .limit(1);
  const proposed = (call?.validatedOutput as { content?: unknown })?.content;
  if (
    !proposed ||
    canonicalJson(draft.structuredContent) !== canonicalJson(proposed)
  )
    return false;
  const effective = await effectiveInput(tx, "intake_interpret", draft.id);
  return (
    canonicalJson(withoutContent(effective.payload)) ===
    canonicalJson(withoutContent(job.inputSnapshot))
  );
}

/**
 * A candidate is usable evidence only while the intake run that produced it
 * is current for the draft's effective input, corpus, and prompt — either
 * live-current, or through a still-valid exact adoption. Throws otherwise.
 */
export async function requireSelectableCandidate(
  tx: Tx,
  draft: DraftRow,
  candidate: { modelCallId: string },
): Promise<void> {
  const [job] = await tx
    .select()
    .from(modelJobs)
    .where(
      and(
        eq(modelJobs.draftId, draft.id),
        eq(modelJobs.purpose, "intake_interpret"),
        eq(modelJobs.currentModelCallId, candidate.modelCallId),
      ),
    )
    .limit(1);
  if (
    !job ||
    (!(await intakeJobIsCurrent(tx, draft.id, job)) &&
      !(await adoptedExactCurrent(tx, draft, job)))
  )
    throw new WorkflowError(
      "INVALID_STATE",
      "candidate is not from the current intake result",
    );
}

/**
 * The service candidates of the newest intake run whose evidence is still
 * current: live-current (same input, corpus, and prompt) or adopted-exact.
 * Empty when no run is current or the current run proposed no services, so
 * stale suggestions never demand a rejection.
 */
export async function currentServiceSuggestions(
  tx: Tx,
  draft: DraftRow,
): Promise<Array<typeof serviceCandidates.$inferSelect>> {
  const job = await currentOrNewestIntakeJob(tx, draft.id);
  if (!job || job.status !== "succeeded" || !job.currentModelCallId) return [];
  if (
    !(await intakeJobIsCurrent(tx, draft.id, job)) &&
    !(await adoptedExactCurrent(tx, draft, job))
  )
    return [];
  return tx
    .select()
    .from(serviceCandidates)
    .where(
      and(
        eq(serviceCandidates.draftId, draft.id),
        eq(serviceCandidates.modelCallId, job.currentModelCallId),
      ),
    )
    .orderBy(asc(serviceCandidates.rank));
}

async function assistantQuestionTurns(tx: Tx, draftId: string) {
  return tx
    .select()
    .from(draftTurns)
    .where(
      and(eq(draftTurns.draftId, draftId), eq(draftTurns.actor, "assistant")),
    )
    .orderBy(asc(draftTurns.ordinal));
}

type TurnRow = typeof draftTurns.$inferSelect;

/** New answers to write; a matching existing answer is a no-op, a
 * conflicting one is an error. */
function scanAnswers(
  questions: TurnRow[],
  allTurns: TurnRow[],
  answers: Array<{ questionIndex: number; answer: string }>,
): Array<{ questionId: string; answer: string }> {
  const replies = new Map(
    allTurns
      .filter((turn) => turn.replyToTurnId)
      .map((turn) => [turn.replyToTurnId as string, turn.content]),
  );
  const pending: Array<{ questionId: string; answer: string }> = [];
  const seenIndexes = new Set<number>();
  for (const entry of answers) {
    if (seenIndexes.has(entry.questionIndex))
      throw new WorkflowError(
        "VALIDATION_FAILED",
        `duplicate answer for question index ${entry.questionIndex}`,
      );
    seenIndexes.add(entry.questionIndex);
    const question = questions[entry.questionIndex];
    if (!question)
      throw new WorkflowError(
        "VALIDATION_FAILED",
        `no generated question at index ${entry.questionIndex}`,
      );
    const existing = replies.get(question.id);
    if (existing === entry.answer) continue;
    if (existing !== undefined)
      throw new WorkflowError(
        "INVALID_STATE",
        `question ${entry.questionIndex} is already answered`,
      );
    pending.push({ questionId: question.id, answer: entry.answer });
  }
  return pending;
}

/** A no-op replay still verifies ownership and reports the actual job. */
async function answerReplayResult(tx: Tx, draft: DraftRow, jobId: string) {
  await ownedIntakeJob(tx, draft.id, jobId);
  const current = await currentOrNewestIntakeJob(tx, draft.id);
  return {
    draftId: draft.id,
    rowVersion: draft.rowVersion,
    answered: 0,
    intakeJobId: current?.id ?? jobId,
    intakeJobStatus: current?.status ?? "succeeded",
  };
}

const answerSchema = z.object({
  draftId: uuidSchema,
  jobId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
  answers: z
    .array(
      z.object({
        questionIndex: z.number().int().min(0).max(2),
        answer: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(3),
});

/**
 * Answer generated intake questions. Each answer becomes a customer turn
 * replying to its question turn; the cumulative conversation is the next
 * intake job's effective input, enqueued in the same transaction. Replaying
 * the same answers is a no-op.
 */
export async function answerIntake(ctx: VisitorContext, input: unknown) {
  const data = parseInput(answerSchema, input);
  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    return db.transaction(async (tx) => {
      const draft = await lockOwnDraft(tx, visitor.id, data.draftId);

      const questions = await assistantQuestionTurns(tx, draft.id);
      const allTurns = await tx
        .select()
        .from(draftTurns)
        .where(eq(draftTurns.draftId, draft.id));
      const pending = scanAnswers(questions, allTurns, data.answers);
      // A full replay is a no-op before any version or currency judgement,
      // so reloads stay idempotent even though earlier answers moved the
      // input hash and the row version. The cited job must still belong to
      // this draft, and the reply reports the draft's actual current job.
      if (pending.length === 0)
        return answerReplayResult(tx, draft, data.jobId);
      requireVersion(data.expectedRowVersion, draft.rowVersion);
      await requireCurrentIntakeJob(tx, draft.id, data.jobId);

      let ordinal = allTurns.reduce(
        (max, turn) => Math.max(max, turn.ordinal + 1),
        0,
      );
      let written = 0;
      for (const entry of pending) {
        await tx.insert(draftTurns).values({
          id: newId(),
          draftId: draft.id,
          ordinal,
          actor: "customer",
          actorId: visitor.actorId,
          content: entry.answer,
          replyToTurnId: entry.questionId,
        });
        ordinal += 1;
        written += 1;
      }

      let nextJob: { jobId: string; status: string } | null = null;
      if (written > 0) {
        await tx
          .update(drafts)
          .set({ rowVersion: draft.rowVersion + 1, updatedAt: nowIso() })
          .where(eq(drafts.id, draft.id));
        nextJob = await enqueueJobInTx(tx, visitor.id, {
          purpose: "intake_interpret",
          draftId: draft.id,
        });
        await insertAudit(tx, {
          actorId: visitor.actorId,
          visitorId: visitor.id,
          actingView: "requester",
          eventType: "intake_answers_saved",
          subjectType: "draft",
          subjectId: draft.id,
          payload: { answered: written, nextIntakeJobId: nextJob.jobId },
        });
      }
      return {
        draftId: draft.id,
        rowVersion: draft.rowVersion + (written > 0 ? 1 : 0),
        answered: written,
        intakeJobId: nextJob?.jobId ?? data.jobId,
        intakeJobStatus: nextJob?.status ?? "succeeded",
      };
    });
  });
}

/**
 * A reload of the same confirmation is a no-op: the same confirmed content
 * is already recorded, and confirming moved the input hash on purpose. The
 * reply reports the actual recorded jobs, never invented status.
 */
async function confirmReplay(
  tx: Tx,
  draft: DraftRow,
  jobId: string,
  content: Record<string, unknown>,
) {
  const sameContent =
    // jsonb reorders keys; compare canonically.
    canonicalJson(draft.structuredContent) === canonicalJson(content);
  if (draft.state !== "ready" || !sameContent) return null;
  // The cited job must at least belong to this draft.
  const job = await ownedIntakeJob(tx, draft.id, jobId);
  // Citing a different, still-current job with the same content is a real
  // re-adoption, not a reload; only a stale or already-adopted citation
  // replays.
  if (
    draft.confirmedIntakeJobId !== jobId &&
    (await intakeJobIsCurrent(tx, draft.id, job))
  )
    return null;
  return {
    draftId: draft.id,
    state: "ready" as const,
    rowVersion: draft.rowVersion,
    confirmedIntakeJobId: draft.confirmedIntakeJobId,
    fieldOrigins: draft.fieldOrigins,
    ...(await recordedJobTruth(tx, draft.id, jobId)),
  };
}

/** The actual current intake and asset jobs, never invented status. */
async function recordedJobTruth(tx: Tx, draftId: string, citedJobId: string) {
  const intakeJob = await currentOrNewestIntakeJob(tx, draftId);
  const assetJob = await currentOrNewestJob(tx, draftId, "asset_match");
  return {
    intakeJobId: intakeJob?.id ?? citedJobId,
    intakeJobStatus: intakeJob?.status ?? "succeeded",
    assetJobId: assetJob?.id ?? null,
    assetJobStatus: assetJob?.status ?? null,
  };
}

/** Per-field provenance: adopted from the model proposal, or human-edited. */
async function confirmedFieldOrigins(
  tx: Tx,
  job: typeof modelJobs.$inferSelect,
  content: Record<string, unknown>,
): Promise<Record<string, string>> {
  const [call] = job.currentModelCallId
    ? await tx
        .select({ validatedOutput: modelCalls.validatedOutput })
        .from(modelCalls)
        .where(eq(modelCalls.id, job.currentModelCallId))
        .limit(1)
    : [];
  const proposed = (call?.validatedOutput as { content?: unknown })?.content as
    Record<string, unknown> | undefined;
  return Object.fromEntries(
    Object.entries(content).map(([field, value]) => [
      field,
      proposed && JSON.stringify(proposed[field]) === JSON.stringify(value)
        ? "model"
        : "edited",
    ]),
  );
}

const confirmSchema = z.object({
  draftId: uuidSchema,
  jobId: uuidSchema,
  expectedRowVersion: z.number().int().positive().optional(),
  content: requestContentSchema,
});

/**
 * Confirm the human-reviewed structured content, adopting the cited intake
 * result explicitly. The confirmed content may differ from the model's
 * proposal — provenance records which fields the requester edited — but the
 * cited job must still be current for the raw need and conversation. Asset
 * discovery starts in the same transaction.
 */
export async function confirmIntake(ctx: VisitorContext, input: unknown) {
  const data = parseInput(confirmSchema, input);
  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    return db.transaction(async (tx) => {
      const draft = await lockOwnDraft(tx, visitor.id, data.draftId);
      const replay = await confirmReplay(tx, draft, data.jobId, data.content);
      if (replay) return replay;
      requireVersion(data.expectedRowVersion, draft.rowVersion);
      const job = await requireCurrentIntakeJob(tx, draft.id, data.jobId);
      const fieldOrigins = await confirmedFieldOrigins(tx, job, data.content);
      // Exact adoption keeps the cited run as service evidence. Edited
      // content preserves the edits but the old candidates were produced for
      // different content: service discovery reruns on the confirmed content.
      const exactAdoption = Object.values(fieldOrigins).every(
        (origin) => origin === "model",
      );
      return applyConfirmation(tx, {
        visitor,
        draft,
        job,
        content: data.content,
        fieldOrigins,
        exactAdoption,
      });
    });
  });
}

interface ConfirmationArgs {
  visitor: { id: string; actorId: string };
  draft: DraftRow;
  job: typeof modelJobs.$inferSelect;
  content: Record<string, unknown>;
  fieldOrigins: Record<string, string>;
  exactAdoption: boolean;
}

async function applyConfirmation(tx: Tx, args: ConfirmationArgs) {
  const { visitor, draft, job, fieldOrigins, exactAdoption } = args;
  await tx
    .update(drafts)
    .set({
      structuredContent: args.content,
      fieldOrigins,
      confirmedIntakeJobId: exactAdoption ? job.id : null,
      state: "ready",
      currentStep: "options",
      rowVersion: draft.rowVersion + 1,
      updatedAt: nowIso(),
    })
    .where(eq(drafts.id, draft.id));
  const rerunJob = exactAdoption
    ? null
    : await enqueueJobInTx(tx, visitor.id, {
        purpose: "intake_interpret",
        draftId: draft.id,
      });
  const assetJob = await enqueueJobInTx(tx, visitor.id, {
    purpose: "asset_match",
    draftId: draft.id,
  });
  await insertAudit(tx, {
    actorId: visitor.actorId,
    visitorId: visitor.id,
    actingView: "requester",
    eventType: "intake_confirmed",
    subjectType: "draft",
    subjectId: draft.id,
    payload: {
      intakeJobId: job.id,
      modelCallId: job.currentModelCallId,
      exactAdoption,
      rerunIntakeJobId: rerunJob?.jobId ?? null,
      editedFields: Object.entries(fieldOrigins)
        .filter(([, origin]) => origin === "edited")
        .map(([field]) => field),
    },
  });
  return {
    draftId: draft.id,
    state: "ready" as const,
    rowVersion: draft.rowVersion + 1,
    confirmedIntakeJobId: exactAdoption ? job.id : null,
    intakeJobId: rerunJob?.jobId ?? job.id,
    intakeJobStatus: rerunJob?.status ?? job.status,
    assetJobId: assetJob.jobId,
    assetJobStatus: assetJob.status,
    fieldOrigins,
  };
}

const decideSchema = z.object({
  draftId: uuidSchema,
  candidateId: uuidSchema,
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  expectedRowVersion: z.number().int().positive().optional(),
});

/** The draft's newest job of a purpose, regardless of status. */
type JobPurpose = "intake_interpret" | "asset_match" | "risk_assess";

async function newestJob(tx: Db | Tx, draftId: string, purpose: JobPurpose) {
  const [job] = await tx
    .select()
    .from(modelJobs)
    .where(and(eq(modelJobs.draftId, draftId), eq(modelJobs.purpose, purpose)))
    .orderBy(desc(modelJobs.createdAt), desc(modelJobs.id))
    .limit(1);
  return job ?? null;
}

/**
 * The job whose logical identity (input, corpus, prompt, generation) matches
 * the draft's current state — the cache line that is live right now. A
 * reverted input or corpus (A -> B -> A) makes the older A job current
 * again; creation order never decides.
 */
export async function currentJobByIdentity(
  tx: Db | Tx,
  draftId: string,
  purpose: JobPurpose,
  requestId?: string,
) {
  const effective = await effectiveInput(tx, purpose, draftId, requestId);
  const corpus = await collectCorpus(tx, purpose);
  const [job] = await tx
    .select()
    .from(modelJobs)
    .where(
      and(
        eq(modelJobs.draftId, draftId),
        eq(modelJobs.purpose, purpose),
        eq(modelJobs.inputHash, effective.hash),
        eq(modelJobs.corpusHash, corpus.hash),
        eq(modelJobs.promptVersion, modelPrompts[purpose].version),
        eq(modelJobs.requestGeneration, effective.requestGeneration),
      ),
    )
    .limit(1);
  return job ?? null;
}

/**
 * The current-by-identity job, or the newest run as explicit fallback. The
 * `current` flag is the read-side truth the actions already enforce: a
 * fallback success is history, never an actionable recommendation — the
 * corpus may have drifted with no replacement job enqueued yet.
 */
export async function currentJobWithFallback(
  tx: Db | Tx,
  draftId: string,
  purpose: JobPurpose,
  requestId?: string,
) {
  const current = await currentJobByIdentity(tx, draftId, purpose, requestId);
  if (current) return { job: current, current: true };
  return { job: await newestJob(tx, draftId, purpose), current: false };
}

async function currentOrNewestJob(
  tx: Db | Tx,
  draftId: string,
  purpose: JobPurpose,
  requestId?: string,
) {
  return (await currentJobWithFallback(tx, draftId, purpose, requestId)).job;
}

export interface CurrentJobSummary {
  jobId: string;
  status: string;
  sanitizedError: string | null;
  attemptCount: number;
  /** False when the reported job is a stale fallback, not the current one. */
  current: boolean;
}

/**
 * The current logical job per purpose — the cache line matching the present
 * input, corpus, and prompt, falling back to the newest run as visible
 * history. With a requestId the identity covers the submitted content and
 * answered clarifications, so retry and status controls act on the job the
 * state actually needs.
 */
export async function currentLogicalJobs(
  db: Db | Tx,
  draftId: string,
  requestId?: string,
): Promise<Record<JobPurpose, CurrentJobSummary | null>> {
  const summary = async (purpose: JobPurpose) => {
    const found = await currentJobWithFallback(db, draftId, purpose, requestId);
    if (!found.job) return null;
    let current = found.current;
    // The intake adoption escape from the action rule applies here too.
    if (!current && purpose === "intake_interpret") {
      const [draft] = await db
        .select()
        .from(drafts)
        .where(eq(drafts.id, draftId))
        .limit(1);
      current =
        draft !== undefined &&
        (await adoptedExactCurrent(db, draft, found.job));
    }
    return {
      jobId: found.job.id,
      status: found.job.status,
      sanitizedError: found.job.sanitizedError,
      attemptCount: found.job.attemptCount,
      current,
    };
  };
  return {
    intake_interpret: await summary("intake_interpret"),
    asset_match: await summary("asset_match"),
    risk_assess: await summary("risk_assess"),
  };
}

async function currentOrNewestIntakeJob(tx: Db | Tx, draftId: string) {
  return currentOrNewestJob(tx, draftId, "intake_interpret");
}

/**
 * Record the requester's fit decision on a recommended service. The
 * candidate must come from the adopted intake result, or from the latest
 * succeeded intake job while it is still current — never from another draft
 * or a stale run.
 */
export async function decideService(ctx: VisitorContext, input: unknown) {
  const data = parseInput(decideSchema, input);
  if (data.decision === "rejected" && !data.reason)
    throw new WorkflowError("VALIDATION_FAILED", "rejection needs a reason");
  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    return db.transaction(async (tx) => {
      const draft = await lockOwnDraft(tx, visitor.id, data.draftId);
      requireVersion(data.expectedRowVersion, draft.rowVersion);
      const [candidate] = await tx
        .select()
        .from(serviceCandidates)
        .where(
          and(
            eq(serviceCandidates.id, data.candidateId),
            eq(serviceCandidates.draftId, draft.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!candidate)
        throw new WorkflowError("NOT_FOUND", "candidate for this draft");

      await requireSelectableCandidate(tx, draft, candidate);

      await tx
        .update(serviceCandidates)
        .set({
          decision: data.decision,
          decidedByActorId: visitor.actorId,
          decisionReason: data.reason ?? null,
          decidedAt: nowIso(),
        })
        .where(eq(serviceCandidates.id, candidate.id));
      await tx
        .update(drafts)
        .set({ rowVersion: draft.rowVersion + 1, updatedAt: nowIso() })
        .where(eq(drafts.id, draft.id));
      await insertAudit(tx, {
        actorId: visitor.actorId,
        visitorId: visitor.id,
        actingView: "requester",
        eventType: "service_fit_decided",
        subjectType: "draft",
        subjectId: draft.id,
        payload: { candidateId: candidate.id, decision: data.decision },
      });
      return {
        draftId: draft.id,
        candidateId: candidate.id,
        decision: data.decision,
        rowVersion: draft.rowVersion + 1,
      };
    });
  });
}

/**
 * Read the intake workspace state: the conversation with answer status, the
 * latest intake result and its proposals, and preparation job status.
 */
export async function getIntakeState(
  ctx: VisitorContext,
  draftIdInput: unknown,
  reader?: Tx,
) {
  const draftId = parseInput(uuidSchema, draftIdInput);
  return withReadSnapshot(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    const [draft] = await db
      .select()
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .limit(1);
    if (!draft) throw new WorkflowError("NOT_FOUND", "draft");
    if (draft.visitorId !== visitor.id)
      throw new WorkflowError("NOT_OWNER", "draft");

    // Identity decides the current run; a reverted input or corpus makes an
    // older cached run current again (A -> B -> A) without a new bill. A
    // fallback success reads stale: no proposal and no candidates, because
    // confirmIntake and decideService would refuse them anyway.
    const intake = await currentJobWithFallback(
      db,
      draftId,
      "intake_interpret",
    );
    // Exact adoption mirrors the action rule: a confirmed job whose content
    // was adopted verbatim stays valid evidence even though the adopted
    // content changed the input hash.
    const intakeCurrent =
      intake.current ||
      (intake.job !== null &&
        (await adoptedExactCurrent(db, draft, intake.job)));
    const asset = await currentJobWithFallback(db, draftId, "asset_match");

    return {
      draftId: draft.id,
      state: draft.state,
      rowVersion: draft.rowVersion,
      rawNeed: draft.rawNeed,
      content: draft.structuredContent,
      fieldOrigins: draft.fieldOrigins,
      confirmedIntakeJobId: draft.confirmedIntakeJobId,
      questions: await questionStates(db, draftId),
      intakeJob: await intakeJobSummary(db, intake.job, intakeCurrent),
      assetJob: asset.job
        ? {
            jobId: asset.job.id,
            status: asset.job.status,
            current: asset.current,
          }
        : null,
      candidates: intakeCurrent
        ? await candidateStates(db, draftId, intake.job)
        : [],
    };
  }, reader);
}

/** The conversation as indexed questions with their answers. */
export function intakeTurnNeedsAnswer(
  turn: { fixtureKey: string | null; content: string },
  hasReply: boolean,
) {
  // Live assistant turns are generated questions. Legacy fixture transcripts
  // also include declarative closing notes; retain those without implying
  // that the requester left a question unanswered.
  return !turn.fixtureKey || hasReply || turn.content.includes("?");
}

export async function questionStates(db: Db | Tx, draftId: string) {
  const turns = await db
    .select()
    .from(draftTurns)
    .where(eq(draftTurns.draftId, draftId))
    .orderBy(asc(draftTurns.ordinal));
  const answersByQuestion = new Map(
    turns
      .filter((turn) => turn.replyToTurnId)
      .map((turn) => [turn.replyToTurnId as string, turn.content]),
  );
  return turns
    .filter((turn) => turn.actor === "assistant")
    .map((turn, index) => ({
      questionIndex: index,
      turnId: turn.id,
      question: turn.content,
      isQuestion: intakeTurnNeedsAnswer(turn, answersByQuestion.has(turn.id)),
      answer: answersByQuestion.get(turn.id) ?? null,
    }));
}

async function intakeJobSummary(
  db: Db | Tx,
  intakeJob: typeof modelJobs.$inferSelect | null,
  current: boolean,
) {
  if (!intakeJob) return null;
  const [call] =
    current && intakeJob.currentModelCallId
      ? await db
          .select({
            status: modelCalls.status,
            validatedOutput: modelCalls.validatedOutput,
          })
          .from(modelCalls)
          .where(eq(modelCalls.id, intakeJob.currentModelCallId))
          .limit(1)
      : [];
  return {
    jobId: intakeJob.id,
    status: intakeJob.status,
    sanitizedError: intakeJob.sanitizedError,
    current,
    proposal: call?.status === "succeeded" ? call.validatedOutput : null,
  };
}

/** The current intake result's service candidates with fit decisions. */
async function candidateStates(
  db: Db | Tx,
  draftId: string,
  intakeJob: typeof modelJobs.$inferSelect | null,
) {
  if (!intakeJob?.currentModelCallId) return [];
  return db
    .select({
      candidateId: serviceCandidates.id,
      offeringId: serviceCandidates.offeringId,
      offeringName: serviceOfferings.name,
      rank: serviceCandidates.rank,
      fitBand: serviceCandidates.fitBand,
      coverage: serviceCandidates.coverage,
      gaps: serviceCandidates.gaps,
      relatedOfferingKeys: serviceCandidates.relatedOfferingKeys,
      rationale: serviceCandidates.rationale,
      decision: serviceCandidates.decision,
      decisionReason: serviceCandidates.decisionReason,
    })
    .from(serviceCandidates)
    .innerJoin(
      serviceOfferings,
      eq(serviceOfferings.id, serviceCandidates.offeringId),
    )
    .where(
      and(
        eq(serviceCandidates.draftId, draftId),
        eq(serviceCandidates.modelCallId, intakeJob.currentModelCallId),
      ),
    )
    .orderBy(asc(serviceCandidates.rank));
}

const fitSchema = z.object({
  draftId: uuidSchema,
  candidateId: uuidSchema,
  decision: z.enum(["accepted", "rejected", "cleared"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  expectedRowVersion: z.number().int().positive(),
});

/** The candidate with its assessment lineage, owned by this draft. */
async function ownedAssetCandidate(
  tx: Db | Tx,
  draftId: string,
  candidateId: string,
) {
  const [row] = await tx
    .select({
      candidateId: assetCandidates.id,
      catalogItemId: assetCandidates.catalogItemId,
      catalogVersion: assetCandidates.catalogVersion,
      assessmentId: assetAssessments.id,
      modelCallId: assetAssessments.modelCallId,
    })
    .from(assetCandidates)
    .innerJoin(
      assetAssessments,
      eq(assetAssessments.id, assetCandidates.assessmentId),
    )
    .where(
      and(
        eq(assetCandidates.id, candidateId),
        eq(assetAssessments.draftId, draftId),
      ),
    )
    .limit(1);
  if (!row) throw new WorkflowError("NOT_FOUND", "candidate for this draft");
  return row;
}

/**
 * Record the requester's fit verdict on a recommended existing asset. The
 * candidate must come from the current asset result — the succeeded job
 * whose input, corpus, and prompt still match the draft — never from a
 * stale run. Insert-only: reviewer candidate decisions are untouched, and
 * every prior verdict stays as visible history.
 */
export async function decideAssetFit(ctx: VisitorContext, input: unknown) {
  const data = parseInput(fitSchema, input);
  if (data.decision === "rejected" && !data.reason)
    throw new WorkflowError("VALIDATION_FAILED", "rejection needs a reason");
  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    return db.transaction(async (tx) => {
      const draft = await lockOwnDraft(tx, visitor.id, data.draftId);
      requireVersion(data.expectedRowVersion, draft.rowVersion);
      const candidate = await ownedAssetCandidate(
        tx,
        draft.id,
        data.candidateId,
      );
      const job = await currentJobByIdentity(tx, draft.id, "asset_match");
      if (
        job?.status !== "succeeded" ||
        job.currentModelCallId === null ||
        candidate.modelCallId !== job.currentModelCallId
      )
        throw new WorkflowError(
          "INVALID_STATE",
          "asset result is stale for the current input",
        );

      await tx.insert(assetFitDecisions).values({
        id: newId(),
        draftId: draft.id,
        candidateId: candidate.candidateId,
        assessmentId: candidate.assessmentId,
        decision: data.decision,
        reason: data.reason ?? null,
        visitorId: visitor.id,
        actorId: visitor.actorId,
      });
      await tx
        .update(drafts)
        .set({ rowVersion: draft.rowVersion + 1, updatedAt: nowIso() })
        .where(eq(drafts.id, draft.id));
      await insertAudit(tx, {
        actorId: visitor.actorId,
        visitorId: visitor.id,
        actingView: "requester",
        eventType: "asset_fit_decided",
        subjectType: "draft",
        subjectId: draft.id,
        payload: {
          candidateId: candidate.candidateId,
          catalogItemId: candidate.catalogItemId,
          decision: data.decision,
        },
      });
      return {
        draftId: draft.id,
        candidateId: candidate.candidateId,
        decision: data.decision,
        rowVersion: draft.rowVersion + 1,
      };
    });
  });
}

/**
 * Every requester fit decision for the draft, newest first, with its
 * retained candidate snapshot. A decision is current when its candidate's
 * model call is the current one and no newer verdict covers the same
 * catalog item and version within that call — so A -> B -> A reversion
 * revives A's verdicts, and superseded feedback stays visible history.
 */
export async function assetFitDecisionRows(
  db: Db | Tx,
  draftId: string,
  currentModelCallId: string | null,
) {
  const rows = await db
    .select({
      id: assetFitDecisions.id,
      candidateId: assetFitDecisions.candidateId,
      decision: assetFitDecisions.decision,
      reason: assetFitDecisions.reason,
      actorId: assetFitDecisions.actorId,
      decidedAt: assetFitDecisions.createdAt,
      catalogItemId: assetCandidates.catalogItemId,
      catalogVersion: assetCandidates.catalogVersion,
      proposalName: assetCandidates.name,
      liveName: catalogItems.name,
      fitBand: assetCandidates.fitBand,
      coverage: assetCandidates.coverage,
      gaps: assetCandidates.gaps,
      rationale: assetCandidates.rationale,
      modelCallId: assetAssessments.modelCallId,
    })
    .from(assetFitDecisions)
    .innerJoin(
      assetCandidates,
      eq(assetCandidates.id, assetFitDecisions.candidateId),
    )
    .innerJoin(
      assetAssessments,
      eq(assetAssessments.id, assetCandidates.assessmentId),
    )
    .innerJoin(catalogItems, eq(catalogItems.id, assetCandidates.catalogItemId))
    .where(eq(assetFitDecisions.draftId, draftId))
    .orderBy(desc(assetFitDecisions.createdAt), desc(assetFitDecisions.id));
  const latestSeen = new Set<string>();
  return rows.map((row) => {
    const itemKey = `${row.catalogItemId}:${row.catalogVersion}:${row.modelCallId}`;
    const latest = !latestSeen.has(itemKey);
    latestSeen.add(itemKey);
    const { modelCallId, proposalName, liveName, ...visible } = row;
    return {
      ...visible,
      // The name as proposed; rows from before capture read the live name.
      name: proposalName ?? liveName,
      current:
        latest &&
        currentModelCallId !== null &&
        modelCallId === currentModelCallId,
    };
  });
}

/** The assessment presenting the current call's result; newest row wins. */
async function assessmentForCall(db: Db | Tx, modelCallId: string) {
  const [row] = await db
    .select()
    .from(assetAssessments)
    .where(eq(assetAssessments.modelCallId, modelCallId))
    .orderBy(desc(assetAssessments.createdAt), desc(assetAssessments.id))
    .limit(1);
  return row ?? null;
}

/**
 * The requester's existing-asset preview during intake: the current asset
 * result's candidates, each with the requester's current fit verdict, plus
 * the full decision history. Identity decides currency, so a reverted
 * input presents the earlier result and its verdicts without a new bill.
 */
export async function getAssetPreview(
  ctx: VisitorContext,
  draftIdInput: unknown,
  reader?: Tx,
) {
  const draftId = parseInput(uuidSchema, draftIdInput);
  return withReadSnapshot(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    const [draft] = await db
      .select()
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .limit(1);
    if (!draft) throw new WorkflowError("NOT_FOUND", "draft");
    if (draft.visitorId !== visitor.id)
      throw new WorkflowError("NOT_OWNER", "draft");

    const found = await currentJobWithFallback(db, draftId, "asset_match");
    const job = found.job;
    const callId =
      found.current && job?.status === "succeeded"
        ? job.currentModelCallId
        : null;
    const assessment = callId ? await assessmentForCall(db, callId) : null;
    const decisions = await assetFitDecisionRows(db, draftId, callId);
    const candidates = assessment
      ? await db
          .select({
            candidate: assetCandidates,
            liveName: catalogItems.name,
          })
          .from(assetCandidates)
          .innerJoin(
            catalogItems,
            eq(catalogItems.id, assetCandidates.catalogItemId),
          )
          .where(eq(assetCandidates.assessmentId, assessment.id))
          .orderBy(asc(assetCandidates.rank))
      : [];
    return {
      draftId,
      rowVersion: draft.rowVersion,
      assetJob: job
        ? {
            jobId: job.id,
            status: job.status,
            sanitizedError: job.sanitizedError,
            current: found.current,
          }
        : null,
      assessment: assessment
        ? { id: assessment.id, status: assessment.status }
        : null,
      candidates: candidates.map(({ candidate, liveName }) => ({
        candidateId: candidate.id,
        catalogItemId: candidate.catalogItemId,
        catalogVersion: candidate.catalogVersion,
        name: candidate.name ?? liveName,
        rank: candidate.rank,
        fitBand: candidate.fitBand,
        coverage: candidate.coverage,
        gaps: candidate.gaps,
        dependencies: candidate.dependencies,
        rationale: candidate.rationale,
        fitDecision:
          decisions.find(
            (decision) =>
              decision.current &&
              decision.catalogItemId === candidate.catalogItemId &&
              decision.catalogVersion === candidate.catalogVersion,
          ) ?? null,
      })),
      decisions,
    };
  }, reader);
}
