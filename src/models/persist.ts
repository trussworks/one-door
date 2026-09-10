import { and, asc, eq } from "drizzle-orm";

import {
  assetAssessments,
  assetCandidates,
  draftTurns,
  requests,
  reviewTasks,
  riskAssessments,
  riskFindings,
  serviceCandidates,
} from "../db/schema.ts";
import { newId, nowIso, type Tx } from "../workflow/shared.ts";
import type {
  AssetResult,
  IntakeResult,
  ModelPurpose,
  ModelResult,
} from "./contracts.ts";
import type { CorpusSnapshot } from "./corpus.ts";

/**
 * A genuinely new current assessment invalidates the area's recorded human
 * outcome: the review task returns to pending in the same transaction, so a
 * replacement result (for example a successful empty one after a corpus
 * change) can never pass the human-review gate on the old completion.
 * History is preserved — decisions and earlier assessments stay untouched.
 * Draft-only results, results for another revision, and results for another
 * generation change nothing, and reuse attaches without landing here.
 */
async function resetReviewTaskForNewAssessment(
  tx: Tx,
  args: {
    draftId: string;
    revisionId: string | null;
    requestGeneration: number;
  },
  area: "assets" | "risk",
): Promise<void> {
  const [request] = await tx
    .select({
      id: requests.id,
      stage: requests.stage,
      currentRevisionId: requests.currentRevisionId,
      fixtureGeneration: requests.fixtureGeneration,
    })
    .from(requests)
    .where(eq(requests.sourceDraftId, args.draftId))
    .limit(1);
  if (!request) return;
  if (args.revisionId !== request.currentRevisionId) return;
  if (args.requestGeneration !== request.fixtureGeneration) return;
  // A completed first review is closed: a late same-revision result stays
  // recorded evidence and never reopens the human decisions. The settlement
  // transaction already holds the request lock (taken before the job lock),
  // so this read cannot race an approval committing concurrently.
  if (request.stage === "first_review_completed") return;
  await tx
    .update(reviewTasks)
    .set({
      state: "pending",
      completedAt: null,
      completedAssessmentId: null,
      updatedAt: nowIso(),
    })
    .where(
      and(eq(reviewTasks.requestId, request.id), eq(reviewTasks.area, area)),
    );
}

export type PersistArgs = ModelResult & {
  draftId: string;
  revisionId: string | null;
  requestGeneration: number;
  modelCallId: string;
  corpus: CorpusSnapshot;
};

/**
 * Store a validated result as the current proposals. Rows append; earlier
 * proposals and their decisions stay as history. Assessment rows are
 * immutable at the database level, so reuse for a new revision also lands
 * here with a fresh assessment.
 */
async function persistAssetProposals(
  tx: Tx,
  args: PersistArgs,
  result: AssetResult,
) {
  const nameOf = new Map(
    args.corpus.detail.map((record) => {
      const row = record as { catalogItemId: string; name: string };
      return [row.catalogItemId, row.name];
    }),
  );
  const assessmentId = newId();
  // The combined intake corpus hashes offerings and catalog together; the
  // assessment's currency is judged against the catalog hash alone, so
  // store the catalog portion (asset_match corpora carry the same field).
  const catalogHash =
    (args.corpus.corpusVersions.catalogItems as string | undefined) ??
    args.corpus.hash;
  await tx.insert(assetAssessments).values({
    id: assessmentId,
    draftId: args.draftId,
    modelCallId: args.modelCallId,
    status: "succeeded",
    catalogCorpusHash: catalogHash,
    revisionId: args.revisionId,
    requestGeneration: args.requestGeneration,
    origin: "live",
  });
  for (const [index, candidate] of result.candidates.entries()) {
    await tx.insert(assetCandidates).values({
      id: newId(),
      assessmentId,
      catalogItemId: candidate.catalogItemId,
      catalogVersion:
        args.corpus.versionsById.get(candidate.catalogItemId) ?? 1,
      name: nameOf.get(candidate.catalogItemId) ?? null,
      rank: index + 1,
      fitBand: candidate.fitBand,
      coverage: candidate.coverage,
      gaps: candidate.gaps,
      dependencies: candidate.dependencies,
      rationale: candidate.rationale,
    });
  }
  await resetReviewTaskForNewAssessment(tx, args, "assets");
}

export async function persistProposals(
  tx: Tx,
  args: PersistArgs,
): Promise<void> {
  if (args.purpose === "intake_interpret") {
    const result = args.validated;
    for (const [index, service] of result.services.entries()) {
      await tx.insert(serviceCandidates).values({
        id: newId(),
        draftId: args.draftId,
        modelCallId: args.modelCallId,
        offeringId: service.offeringId,
        rank: index + 1,
        fitBand: service.fitBand,
        coverage: service.coverage,
        gaps: service.gaps,
        relatedOfferingKeys: service.relatedOfferingKeys,
        rationale: service.rationale,
      });
    }
    await persistIntakeQuestions(tx, args, result);
    // The same combined call evaluated the catalog; its asset view persists
    // as a real assessment so the reviewer flow needs no separate pre-submit
    // asset call.
    await persistAssetProposals(tx, args, { candidates: result.assets });
    return;
  }
  if (args.purpose === "asset_match") {
    await persistAssetProposals(tx, args, args.validated);
    return;
  }
  const result = args.validated;
  const assessmentId = newId();
  await tx.insert(riskAssessments).values({
    id: assessmentId,
    draftId: args.draftId,
    modelCallId: args.modelCallId,
    status: "succeeded",
    policyCorpusHash: args.corpus.hash,
    revisionId: args.revisionId,
    requestGeneration: args.requestGeneration,
    origin: "live",
  });
  for (const finding of result.findings) {
    await tx.insert(riskFindings).values({
      id: newId(),
      assessmentId,
      policyRuleId: finding.policyRuleId,
      kind: finding.kind,
      evidence: finding.evidence,
      missingInformation: finding.missingInformation,
      proposedSeverity: finding.proposedSeverity,
      rationale: finding.rationale,
    });
  }
  await resetReviewTaskForNewAssessment(tx, args, "risk");
}

/**
 * Persist newly generated follow-up questions as assistant turns. Three
 * generated questions TOTAL per draft, across every intake run — a retry or
 * refinement never widens the interview, and a repeated question is never
 * asked twice.
 */
async function persistIntakeQuestions(
  tx: Tx,
  args: PersistArgs,
  result: IntakeResult,
): Promise<void> {
  const turns = await tx
    .select({ actor: draftTurns.actor, content: draftTurns.content })
    .from(draftTurns)
    .where(eq(draftTurns.draftId, args.draftId))
    .orderBy(asc(draftTurns.ordinal));
  const asked = new Set(
    turns
      .filter((turn) => turn.actor === "assistant")
      .map((turn) => turn.content.trim().toLowerCase()),
  );
  let ordinal = turns.length;
  let remaining = Math.max(0, 3 - asked.size);
  for (const question of result.questions) {
    if (remaining <= 0) break;
    if (asked.has(question.trim().toLowerCase())) continue;
    await tx.insert(draftTurns).values({
      id: newId(),
      draftId: args.draftId,
      ordinal,
      actor: "assistant",
      modelCallId: args.modelCallId,
      content: question,
    });
    asked.add(question.trim().toLowerCase());
    ordinal += 1;
    remaining -= 1;
  }
}

/**
 * A durable job failure leaves an honest failed assessment on the record for
 * asset and risk purposes, so review shows a blocker with a retry action.
 */
export async function persistFailedAssessment(
  tx: Tx,
  args: {
    purpose: ModelPurpose;
    draftId: string;
    revisionId: string | null;
    requestGeneration: number;
    modelCallId: string | null;
    corpusHash: string;
    sanitizedError: string;
  },
): Promise<void> {
  if (args.purpose === "asset_match") {
    await tx.insert(assetAssessments).values({
      id: newId(),
      draftId: args.draftId,
      modelCallId: args.modelCallId,
      status: "failed",
      catalogCorpusHash: args.corpusHash,
      revisionId: args.revisionId,
      requestGeneration: args.requestGeneration,
      sanitizedError: args.sanitizedError,
      origin: "live",
    });
    await resetReviewTaskForNewAssessment(tx, args, "assets");
  }
  if (args.purpose === "risk_assess") {
    await tx.insert(riskAssessments).values({
      id: newId(),
      draftId: args.draftId,
      modelCallId: args.modelCallId,
      status: "failed",
      policyCorpusHash: args.corpusHash,
      revisionId: args.revisionId,
      requestGeneration: args.requestGeneration,
      sanitizedError: args.sanitizedError,
      origin: "live",
    });
    await resetReviewTaskForNewAssessment(tx, args, "risk");
  }
}
