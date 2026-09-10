import { and, eq } from "drizzle-orm";
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
  requests,
  wip,
  serviceCandidates,
  serviceOfferings,
} from "../db/schema.ts";
import type { IntakeResult } from "../models/contracts.ts";
import { priorityProposalSchema } from "../domain/priority.ts";
import { effectiveInput } from "../models/corpus.ts";
import {
  enqueueJobInTx,
  intakeAttemptBudget,
  intakeAttemptsUsed,
} from "../models/jobs.ts";
import { WorkflowError } from "./errors.ts";
import {
  currentJobByIdentity,
  currentJobWithFallback,
  lockOwnDraft,
  ownedIntakeJob,
  questionStates,
} from "./intake.ts";
import { getOwnDraft, insertSubmission, requestSummary } from "./requester.ts";
import {
  insertAudit,
  newId,
  nowIso,
  parseInput,
  partialContentSchema,
  ratingSchema,
  requestContentSchema,
  requireVersion,
  requireVisitor,
  uuidSchema,
  withDb,
  withReadSnapshot,
  type Db,
  type RequestContent,
  type Tx,
  type VisitorContext,
} from "./shared.ts";

type DraftRow = typeof drafts.$inferSelect;
type JobRow = typeof modelJobs.$inferSelect;

/**
 * The one requester workspace read: draft, budget, questions, the optional
 * genuinely strong suggestion, and the submitted request if one exists.
 * Everything comes from one snapshot so the page cannot disagree with
 * itself while polling.
 */
export async function getIntakeWorkspace(
  ctx: VisitorContext,
  draftIdInput: unknown,
  reader?: Tx,
) {
  const draftId = parseInput(uuidSchema, draftIdInput);
  return withReadSnapshot(async (db) => {
    const draft = await getOwnDraft(ctx, draftId, db);
    const found = await currentJobWithFallback(db, draftId, "intake_interpret");
    const callsUsed = await intakeAttemptsUsed(db, draftId);
    const callsRemaining = Math.max(0, intakeAttemptBudget - callsUsed);
    const [submitted] = await db
      .select({ requestId: requests.id, displayId: requests.displayId })
      .from(requests)
      .where(eq(requests.sourceDraftId, draftId))
      .limit(1);
    return {
      draft,
      job: found.job
        ? {
            jobId: found.job.id,
            status: found.job.status,
            current: found.current,
            sanitizedError: found.job.sanitizedError,
          }
        : null,
      callsUsed,
      callsRemaining,
      canPrepare: callsRemaining > 0 && draft.state !== "submitted",
      ...(await workspaceContent(db, draft.content, found)),
      questions: await questionStates(db, draftId),
      suggestion: await workspaceSuggestion(db, found),
      submittedRequest: submitted ?? null,
      priorSubmissionRating: await previousSubmissionRating(db, ctx, draftId),
    };
  }, reader);
}

async function previousSubmissionRating(
  db: Db | Tx,
  ctx: VisitorContext,
  draftId: string,
) {
  const [saved] = await db
    .select({ payload: wip.payload })
    .from(wip)
    .where(
      and(
        eq(wip.visitorId, ctx.visitorId),
        eq(wip.actingView, "requester"),
        eq(wip.pageKey, "submit-request"),
        eq(wip.subjectKey, draftId),
      ),
    )
    .limit(1);
  const value = saved?.payload.rating;
  const parsed = ratingSchema.safeParse(
    typeof value === "string" ? Number(value) : value,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The summary the page shows. While the current job's proposal corresponds
 * to the draft as it stands, the proposal is the summary — one source, no
 * duplicate. Otherwise the draft's own (possibly partial) content shows,
 * and the submit action parses the final words strictly.
 */
async function workspaceContent(
  db: Db | Tx,
  structured: Record<string, unknown>,
  found: { job: JobRow | null; current: boolean },
): Promise<{
  content: unknown;
  contentComplete: boolean;
  earlierSummary?: boolean;
}> {
  const proposal = await currentProposal(db, found);
  if (proposal) return { content: proposal, contentComplete: true };
  const parsed = requestContentSchema.safeParse(structured);
  if (parsed.success) return { content: parsed.data, contentComplete: true };
  const earlier = await unchangedInputSummary(db, found.job);
  if (earlier)
    return { content: earlier, contentComplete: true, earlierSummary: true };
  return { content: structured, contentComplete: false };
}

/** The current succeeded job's proposed content, when one exists. */
async function currentProposal(
  db: Db | Tx,
  found: { job: JobRow | null; current: boolean },
): Promise<RequestContent | null> {
  const job = found.job;
  return found.current ? savedProposal(db, job) : null;
}

// A prompt/catalog update invalidates recommendations, not the customer's
// unchanged description. Retain that draft text without making its matches current.
async function unchangedInputSummary(db: Db | Tx, job: JobRow | null) {
  if (job?.status !== "succeeded") return null;
  const input = await effectiveInput(db, "intake_interpret", job.draftId);
  return input.hash === job.inputHash ? savedProposal(db, job) : null;
}

async function savedProposal(
  db: Db | Tx,
  job: JobRow | null,
): Promise<RequestContent | null> {
  if (job?.status !== "succeeded" || !job.currentModelCallId) return null;
  const [call] = await db
    .select({ validatedOutput: modelCalls.validatedOutput })
    .from(modelCalls)
    .where(eq(modelCalls.id, job.currentModelCallId))
    .limit(1);
  const output = call?.validatedOutput as IntakeResult | undefined;
  return output?.content ? normalizedProposal(output.content) : null;
}

/**
 * The interface joins list items with newlines and splits them back on
 * resave, so items must leave here trimmed, non-empty, and newline-free —
 * otherwise a verbatim adoption would no longer canonically match the
 * proposal and its evidence would be lost.
 */
function normalizedProposal(content: RequestContent): RequestContent {
  const flat = (items: string[]) =>
    items
      .flatMap((item) => item.split("\n"))
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    title: content.title.trim(),
    problem: content.problem.trim(),
    affectedPeople: content.affectedPeople.trim(),
    acceptanceCriteria: flat(content.acceptanceCriteria),
    requirements: flat(content.requirements),
    constraints: flat(content.constraints),
    unknowns: flat(content.unknowns),
  };
}

interface SuggestionView {
  jobId: string;
  kind: "service" | "asset";
  candidateId: string;
  name: string;
  summary: string;
  conditions: string[];
}

/**
 * The at-most-one requester suggestion, gated server-side: the job must be
 * current for the draft as it stands, the result must carry a suggestion,
 * the cited record must still be eligible, and the matching candidate must
 * be a strong-band fit with no gap and, for assets, no unmet dependency.
 * Anything less is reviewer material — hidden, never failing the result —
 * and an edit after the last call withholds by making the job non-current.
 */
async function workspaceSuggestion(
  db: Db | Tx,
  found: { job: JobRow | null; current: boolean },
): Promise<SuggestionView | null> {
  const job = found.job;
  if (!found.current || job?.status !== "succeeded") return null;
  if (!job.currentModelCallId) return null;
  const [call] = await db
    .select({ validatedOutput: modelCalls.validatedOutput })
    .from(modelCalls)
    .where(eq(modelCalls.id, job.currentModelCallId))
    .limit(1);
  const output = call?.validatedOutput as IntakeResult | undefined;
  const suggestion = output?.requesterSuggestion;
  if (!suggestion) return null;
  const view =
    suggestion.kind === "service"
      ? await serviceSuggestionView(db, job, suggestion)
      : await assetSuggestionView(db, job, suggestion);
  return view ? { jobId: job.id, ...view } : null;
}

type SuggestionShape = NonNullable<IntakeResult["requesterSuggestion"]>;

async function serviceSuggestionView(
  db: Db | Tx,
  job: JobRow,
  suggestion: SuggestionShape,
) {
  const [row] = await db
    .select({
      candidateId: serviceCandidates.id,
      gaps: serviceCandidates.gaps,
      fitBand: serviceCandidates.fitBand,
      name: serviceOfferings.name,
      lifecycle: serviceOfferings.lifecycle,
    })
    .from(serviceCandidates)
    .innerJoin(
      serviceOfferings,
      eq(serviceOfferings.id, serviceCandidates.offeringId),
    )
    .where(
      and(
        eq(serviceCandidates.modelCallId, job.currentModelCallId as string),
        eq(serviceCandidates.offeringId, suggestion.id),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.lifecycle !== "active" ||
    row.fitBand !== "strong" ||
    row.gaps.length > 0
  )
    return null;
  return {
    kind: "service" as const,
    candidateId: row.candidateId,
    name: row.name,
    summary: suggestion.summary,
    conditions: suggestion.conditions,
  };
}

async function assetSuggestionView(
  db: Db | Tx,
  job: JobRow,
  suggestion: SuggestionShape,
) {
  const [row] = await db
    .select({
      candidateId: assetCandidates.id,
      gaps: assetCandidates.gaps,
      fitBand: assetCandidates.fitBand,
      dependencies: assetCandidates.dependencies,
      name: catalogItems.name,
      candidateName: assetCandidates.name,
      publicationState: catalogItems.publicationState,
      approvalStatus: catalogItems.approvalStatus,
    })
    .from(assetCandidates)
    .innerJoin(
      assetAssessments,
      eq(assetAssessments.id, assetCandidates.assessmentId),
    )
    .innerJoin(catalogItems, eq(catalogItems.id, assetCandidates.catalogItemId))
    .where(
      and(
        eq(assetAssessments.modelCallId, job.currentModelCallId as string),
        eq(assetCandidates.catalogItemId, suggestion.id),
      ),
    )
    .limit(1);
  // Conservative withhold: only a strong band with no gap and no unmet
  // dependency qualifies. A dependency the requester cannot verify is
  // material uncertainty, so its presence hides the suggestion while the
  // full candidate stays with the reviewer.
  if (
    !row ||
    row.publicationState !== "published" ||
    row.approvalStatus !== "approved" ||
    row.fitBand !== "strong" ||
    row.gaps.length > 0 ||
    row.dependencies.length > 0
  )
    return null;
  return {
    kind: "asset" as const,
    candidateId: row.candidateId,
    name: row.candidateName ?? row.name,
    summary: suggestion.summary,
    conditions: suggestion.conditions,
  };
}

const prepareSchema = z.object({
  draftId: uuidSchema,
  expectedRowVersion: z.number().int().positive(),
  content: partialContentSchema.optional(),
  answers: z
    .array(
      z.object({
        questionIndex: z.number().int().min(0),
        answer: z.string().trim().min(1).max(5000),
      }),
    )
    .max(3)
    .optional(),
  jobId: uuidSchema.optional(),
});

/**
 * The only path that runs the model, always explicit. Content edits and
 * answers commit durably before anything queues, so the waiting page's
 * saved-work promise is literal. Unchanged input reuses the cached job
 * without touching the attempt budget; the central reservation gate is the
 * authority when the budget is spent.
 */
export async function prepareIntake(ctx: VisitorContext, input: unknown) {
  const data = parseInput(prepareSchema, input);
  if (data.answers?.length && !data.jobId)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "answers need the job that asked the questions",
    );
  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    // Saves commit durably first, in their own transaction: a refused
    // enqueue (budget spent) must never roll the requester's words back.
    const saved = await db.transaction(async (tx) => {
      const draft = await lockOwnDraft(tx, visitor.id, data.draftId);
      requireVersion(data.expectedRowVersion, draft.rowVersion);
      const merged = { ...draft.structuredContent, ...data.content };
      const contentChanged =
        data.content !== undefined &&
        JSON.stringify(merged) !== JSON.stringify(draft.structuredContent);
      if (contentChanged)
        await tx
          .update(drafts)
          .set({ structuredContent: merged })
          .where(eq(drafts.id, draft.id));
      const answersChanged = data.answers?.length
        ? await writeAnswers(tx, visitor, draft, {
            jobId: data.jobId as string,
            answers: data.answers,
          })
        : false;
      const changed = contentChanged || answersChanged;
      // Reusing an unchanged job must not invalidate the open draft's version.
      const rowVersion = draft.rowVersion + (changed ? 1 : 0);
      if (changed)
        await tx
          .update(drafts)
          .set({ rowVersion, updatedAt: nowIso() })
          .where(eq(drafts.id, draft.id));
      return { draftId: draft.id, rowVersion };
    });
    const job = await db.transaction(async (tx) => {
      const enqueued = await enqueueJobInTx(tx, visitor.id, {
        purpose: "intake_interpret",
        draftId: saved.draftId,
      });
      await insertAudit(tx, {
        actorId: visitor.actorId,
        visitorId: visitor.id,
        actingView: "requester",
        eventType: "intake_prepared",
        subjectType: "draft",
        subjectId: saved.draftId,
        payload: {
          jobId: enqueued.jobId,
          reused: enqueued.status === "succeeded",
        },
      });
      return enqueued;
    });
    return {
      draftId: saved.draftId,
      jobId: job.jobId,
      status: job.status,
      rowVersion: saved.rowVersion,
    };
  });
}

/** Answers become customer turns replying to the cited job's questions. */
async function writeAnswers(
  tx: Tx,
  visitor: { id: string; actorId: string },
  draft: DraftRow,
  data: {
    jobId: string;
    answers: Array<{ questionIndex: number; answer: string }>;
  },
): Promise<boolean> {
  await ownedIntakeJob(tx, draft.id, data.jobId);
  const questions = await questionStates(tx, draft.id);
  let ordinal = await nextOrdinal(tx, draft.id);
  let wrote = false;
  for (const entry of data.answers) {
    const question = questions.find(
      (row) => row.questionIndex === entry.questionIndex,
    );
    if (!question)
      throw new WorkflowError("VALIDATION_FAILED", "unknown question index");
    if (question.answer !== null) continue;
    await tx.insert(draftTurns).values({
      id: newId(),
      draftId: draft.id,
      ordinal,
      actor: "customer",
      actorId: visitor.actorId,
      content: entry.answer,
      replyToTurnId: question.turnId,
    });
    ordinal += 1;
    wrote = true;
  }
  return wrote;
}

async function nextOrdinal(tx: Tx, draftId: string): Promise<number> {
  const turns = await tx
    .select({ ordinal: draftTurns.ordinal })
    .from(draftTurns)
    .where(eq(draftTurns.draftId, draftId));
  return turns.reduce((max, turn) => Math.max(max, turn.ordinal + 1), 0);
}

const submitSchema = z.object({
  draftId: uuidSchema,
  expectedRowVersion: z.number().int().positive(),
  content: requestContentSchema,
  rating: ratingSchema,
  idempotencyKey: z.string().trim().min(8).max(120),
  priorityProposals: z.array(priorityProposalSchema).max(4).optional(),
  suggestionJobId: uuidSchema.optional(),
  suggestionDecision: z.enum(["accepted", "rejected", "cleared"]).optional(),
  suggestionReason: z.string().trim().min(1).max(2000).optional(),
  /** Late answers persist as the requester's words; no call ever runs here. */
  answers: z
    .array(
      z.object({
        questionIndex: z.number().int().min(0),
        answer: z.string().trim().min(1).max(5000),
      }),
    )
    .max(3)
    .optional(),
  jobId: uuidSchema.optional(),
});

/**
 * Submit the requester's final words. Routing always goes to OIT — a
 * confirmed suggestion is customer-fit evidence, never a routing or an
 * approval — and no model call runs here. Post-submission preparation
 * (risk always, an asset refresh only when the combined result is not
 * reusable) serves the reviewer outside the intake budget.
 */
export async function submitIntake(ctx: VisitorContext, input: unknown) {
  const data = parseInput(submitSchema, input);
  if (data.suggestionDecision === "rejected" && !data.suggestionReason)
    throw new WorkflowError("VALIDATION_FAILED", "rejection needs a reason");
  if (data.suggestionDecision && !data.suggestionJobId)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "a suggestion decision names its job",
    );
  if (data.answers?.length && !data.jobId)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "answers need the job that asked the questions",
    );
  return withDb(async (db) => {
    const visitor = await requireVisitor(db, ctx.visitorId);
    return db.transaction(async (tx) => {
      const replayed = await ownedReplay(tx, visitor.id, data.draftId);
      if (replayed) return replayed;
      const draft = await lockOwnDraft(tx, visitor.id, data.draftId);
      requireVersion(data.expectedRowVersion, draft.rowVersion);
      // Late answers are the requester's exact words. They commit before
      // the evidence check, so unprocessed answers make a prior suggestion
      // stale by changing the input the job was current for.
      if (data.answers?.length)
        await writeAnswers(tx, visitor, draft, {
          jobId: data.jobId as string,
          answers: data.answers,
        });
      // Evidence is judged against the draft the requester was looking at,
      // before the final words land: the job must be current for that
      // state, and the submitted content must be the displayed proposal
      // (or the unchanged typed content). Otherwise the combined result is
      // history, the suggestion is gone, and a refresh runs post-submit.
      const evidenceJob = await intakeEvidenceForSubmission(
        tx,
        draft,
        data.content as RequestContent,
      );
      const decidedKind = await recordSubmissionEvidence(
        tx,
        visitor,
        { draft, evidenceJob },
        data,
      );
      await tx
        .update(drafts)
        .set({ structuredContent: data.content, state: "ready" })
        .where(eq(drafts.id, draft.id));
      const updatedDraft = {
        ...draft,
        structuredContent: data.content,
        state: "ready" as const,
      };
      const created = await insertSubmission(tx, {
        draft: updatedDraft,
        visitor,
        content: data.content as RequestContent,
        routingState: "routing_requested",
        selectedServiceCandidateId: null,
        rating: data.rating,
        idempotencyKey: data.idempotencyKey,
        priorityProposals: data.priorityProposals,
      });
      // A rejected service suggestion is feedback that joins the asset
      // effective input, so the combined evaluation may not clone as
      // current — the reviewer gets a refresh that knows the reason. A
      // rejected asset suggestion changes no input; its evaluation clones
      // and the verdict rides alongside as evidence.
      const serviceRejected =
        decidedKind === "service" && data.suggestionDecision === "rejected";
      const reused =
        evidenceJob && !serviceRejected
          ? await attachIntakeAssetReuse(tx, evidenceJob, created.id)
          : false;
      if (!reused)
        await enqueueJobInTx(tx, visitor.id, {
          purpose: "asset_match",
          draftId: draft.id,
          requestId: created.id,
        });
      await enqueueJobInTx(tx, visitor.id, {
        purpose: "risk_assess",
        draftId: draft.id,
        requestId: created.id,
      });
      return requestSummary(created);
    });
  });
}

type SubmitData = z.infer<typeof submitSchema>;

/**
 * The evidence call is the confirmed evaluation of the submitted words. The
 * anchor keys the m36 feedback join and tells the reviewer view which
 * service candidates describe the submission; a suggestion decision then
 * lands on the anchored call's candidate.
 */
async function recordSubmissionEvidence(
  tx: Tx,
  visitor: { id: string; actorId: string },
  context: { draft: DraftRow; evidenceJob: JobRow | null },
  data: SubmitData,
): Promise<"service" | "asset" | null> {
  const { draft, evidenceJob } = context;
  // Written unconditionally: a no-evidence submission clears any anchor a
  // legacy pre-submission adoption left behind, so the reviewer never sees
  // an unadopted evaluation labeled as matching the submitted words.
  await tx
    .update(drafts)
    .set({ confirmedIntakeJobId: evidenceJob?.id ?? null })
    .where(eq(drafts.id, draft.id));
  if (!data.suggestionDecision) return null;
  if (!evidenceJob || evidenceJob.id !== data.suggestionJobId)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "the suggestion is no longer current for the submitted content",
    );
  return recordSuggestionDecision(
    tx,
    visitor,
    { draft, current: evidenceJob },
    data,
  );
}

/**
 * Ownership comes first: the idempotent replay must never leak another
 * visitor's submission. Returns the replay summary, or null to submit.
 */
async function ownedReplay(tx: Tx, visitorId: string, draftId: string) {
  const [owned] = await tx
    .select({ visitorId: drafts.visitorId })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .limit(1);
  if (!owned) throw new WorkflowError("NOT_FOUND", "draft");
  if (owned.visitorId !== visitorId)
    throw new WorkflowError("NOT_OWNER", "draft");
  const [existing] = await tx
    .select()
    .from(requests)
    .where(eq(requests.sourceDraftId, draftId))
    .limit(1);
  return existing ? requestSummary(existing) : null;
}

/**
 * The intake job whose evidence may carry into this submission: current for
 * the draft as displayed, succeeded, and the submitted words are exactly
 * the displayed proposal or the unchanged typed content.
 */
async function intakeEvidenceForSubmission(
  tx: Tx,
  draft: DraftRow,
  content: RequestContent,
): Promise<JobRow | null> {
  const job = await currentJobByIdentity(tx, draft.id, "intake_interpret");
  if (job?.status !== "succeeded" || !job.currentModelCallId) return null;
  const proposal = await currentProposal(tx, { job, current: true });
  const submitted = canonicalOf(content);
  const matchesProposal =
    proposal !== null && canonicalOf(proposal) === submitted;
  const typed = requestContentSchema.safeParse(draft.structuredContent);
  const matchesTyped = typed.success && canonicalOf(typed.data) === submitted;
  return matchesProposal || matchesTyped ? job : null;
}

function canonicalOf(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

/**
 * The decision must name the suggestion actually on display; its render
 * gate is re-checked server-side. Evidence lands on the candidate row of
 * its kind; routing is untouched whatever the decision says.
 */
async function recordSuggestionDecision(
  tx: Tx,
  visitor: { id: string; actorId: string },
  context: { draft: DraftRow; current: JobRow },
  data: SubmitData,
): Promise<"service" | "asset"> {
  const { draft, current } = context;
  const view = await workspaceSuggestion(tx, { job: current, current: true });
  if (!view)
    throw new WorkflowError(
      "VALIDATION_FAILED",
      "no suggestion is on display for this job",
    );
  const decision = data.suggestionDecision as
    "accepted" | "rejected" | "cleared";
  if (view.kind === "service") {
    await tx
      .update(serviceCandidates)
      .set({
        decision,
        decidedByActorId: visitor.actorId,
        decisionReason: data.suggestionReason ?? null,
        decidedAt: nowIso(),
      })
      .where(eq(serviceCandidates.id, view.candidateId));
  } else {
    const [candidate] = await tx
      .select({ assessmentId: assetCandidates.assessmentId })
      .from(assetCandidates)
      .where(eq(assetCandidates.id, view.candidateId))
      .limit(1);
    await tx.insert(assetFitDecisions).values({
      id: newId(),
      draftId: draft.id,
      candidateId: view.candidateId,
      assessmentId: candidate?.assessmentId as string,
      decision,
      reason: data.suggestionReason ?? null,
      visitorId: visitor.id,
      actorId: visitor.actorId,
    });
  }
  await insertAudit(tx, {
    actorId: visitor.actorId,
    visitorId: visitor.id,
    actingView: "requester",
    eventType:
      view.kind === "service" ? "service_fit_decided" : "asset_fit_decided",
    subjectType: "draft",
    subjectId: draft.id,
    payload: { candidateId: view.candidateId, decision },
  });
  return view.kind;
}

/**
 * Reuse the combined intake call's asset evaluation for an unchanged
 * submission: clone the persisted assessment and its candidates onto the
 * new revision verbatim, preserving proposal-time versions and names. A
 * changed draft clones nothing and the caller enqueues a real refresh.
 */
async function attachIntakeAssetReuse(
  tx: Tx,
  job: JobRow,
  requestId: string,
): Promise<boolean> {
  if (job.status !== "succeeded" || !job.currentModelCallId) return false;
  const draftId = job.draftId;
  const [request] = await tx
    .select({ revisionId: requests.currentRevisionId })
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);
  if (!request?.revisionId) return false;
  const [assessment] = await tx
    .select()
    .from(assetAssessments)
    .where(eq(assetAssessments.modelCallId, job.currentModelCallId))
    .limit(1);
  if (!assessment || assessment.status !== "succeeded") return false;
  const cloneId = newId();
  await tx.insert(assetAssessments).values({
    id: cloneId,
    draftId,
    modelCallId: assessment.modelCallId,
    status: assessment.status,
    catalogCorpusHash: assessment.catalogCorpusHash,
    revisionId: request.revisionId,
    requestGeneration: assessment.requestGeneration,
    origin: assessment.origin,
  });
  const candidates = await tx
    .select()
    .from(assetCandidates)
    .where(eq(assetCandidates.assessmentId, assessment.id));
  for (const candidate of candidates) {
    await tx.insert(assetCandidates).values({
      id: newId(),
      assessmentId: cloneId,
      catalogItemId: candidate.catalogItemId,
      catalogVersion: candidate.catalogVersion,
      name: candidate.name,
      rank: candidate.rank,
      fitBand: candidate.fitBand,
      coverage: candidate.coverage,
      gaps: candidate.gaps,
      dependencies: candidate.dependencies,
      rationale: candidate.rationale,
    });
  }
  return true;
}
