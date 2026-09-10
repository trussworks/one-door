import { and, desc, eq } from "drizzle-orm";
import {
  assetAssessments,
  requests,
  reviewTasks,
  riskAssessments,
} from "../db/schema.ts";
import { collectCorpus } from "../models/corpus.ts";
import type { Db, Tx } from "./shared.ts";

type RequestRow = typeof requests.$inferSelect;

/**
 * An assessment counts only when it evaluated the current content revision
 * (strict equality: NULL matches only NULL) and, for live assessments, only
 * in the fixture generation it was prepared for. Fixture-origin assessments
 * are reference evidence: a reset that restores the content and clears the
 * pointer makes them current again while live results read as historical.
 */
export function isCurrentAssessment(
  request: { currentRevisionId: string | null; fixtureGeneration: number },
  assessment: {
    revisionId: string | null;
    origin: string;
    requestGeneration: number;
  },
): boolean {
  if (assessment.revisionId !== request.currentRevisionId) return false;
  return (
    assessment.origin === "fixture" ||
    assessment.requestGeneration === request.fixtureGeneration
  );
}

type AssetLookup =
  | { blocker: "ASSET_ASSESSMENT_MISSING" | "ASSET_ASSESSMENT_FAILED" }
  | { assessment: typeof assetAssessments.$inferSelect };

export interface AssessmentCurrency {
  currentHash: string;
  /**
   * The assessment a completed review recorded as its evidence. Once first
   * review is closed, the approved evidence is what the reader sees; a
   * later corpus change must not silently swap the visible proposal set
   * with no dispatch. While review is open, the corpus preference stands.
   */
  approvedId?: string | null;
}

/**
 * Among revision/generation-current assessments (newest first), the one
 * prepared for the current corpus wins; otherwise the newest stays selected
 * and reads as stale. Identity, not creation order, decides a reversion:
 * when the corpus goes A -> B -> A, the cached A assessment is current
 * again and the later B one becomes history. A recorded approval pins its
 * own evidence ahead of both rules.
 */
export function selectCurrentAssessment<
  T extends {
    id: string;
    revisionId: string | null;
    origin: string;
    requestGeneration: number;
  },
>(
  rows: T[],
  request: { currentRevisionId: string | null; fixtureGeneration: number },
  corpusHashOf: (row: T) => string,
  currency: AssessmentCurrency,
): T | null {
  const eligible = rows.filter((row) => isCurrentAssessment(request, row));
  if (currency.approvedId) {
    const approved = eligible.find((row) => row.id === currency.approvedId);
    if (approved) return approved;
  }
  return (
    eligible.find((row) => corpusHashOf(row) === currency.currentHash) ??
    eligible[0] ??
    null
  );
}

/**
 * The assessment a completed review area recorded as its evidence; null
 * while the area is open or where old data predates identity binding.
 */
export async function completedAssessmentId(
  tx: Db | Tx,
  requestId: string,
  area: "assets" | "risk",
): Promise<string | null> {
  const [task] = await tx
    .select({ id: reviewTasks.completedAssessmentId })
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.requestId, requestId),
        eq(reviewTasks.area, area),
        eq(reviewTasks.state, "completed"),
      ),
    )
    .limit(1);
  return task?.id ?? null;
}

/** The current-revision asset assessment, or the blocker explaining why not. */
export async function currentAssetAssessment(
  tx: Db | Tx,
  request: RequestRow,
): Promise<AssetLookup> {
  const rows = await tx
    .select()
    .from(assetAssessments)
    .where(eq(assetAssessments.draftId, request.sourceDraftId))
    .orderBy(desc(assetAssessments.createdAt), desc(assetAssessments.id));
  const current = selectCurrentAssessment(
    rows,
    request,
    (row) => row.catalogCorpusHash,
    {
      currentHash: (await collectCorpus(tx, "asset_match")).hash,
      approvedId:
        request.stage === "first_review_completed"
          ? await completedAssessmentId(tx, request.id, "assets")
          : null,
    },
  );
  if (!current) return { blocker: "ASSET_ASSESSMENT_MISSING" as const };
  if (current.status !== "succeeded")
    return { blocker: "ASSET_ASSESSMENT_FAILED" as const };
  return { assessment: current };
}

type RiskLookup =
  | { blocker: "RISK_ASSESSMENT_MISSING" | "RISK_ASSESSMENT_FAILED" }
  | { assessment: typeof riskAssessments.$inferSelect };

export async function currentRiskAssessment(
  tx: Db | Tx,
  request: RequestRow,
): Promise<RiskLookup> {
  const rows = await tx
    .select()
    .from(riskAssessments)
    .where(eq(riskAssessments.draftId, request.sourceDraftId))
    .orderBy(desc(riskAssessments.createdAt), desc(riskAssessments.id));
  const current = selectCurrentAssessment(
    rows,
    request,
    (row) => row.policyCorpusHash,
    {
      currentHash: (await collectCorpus(tx, "risk_assess")).hash,
      approvedId:
        request.stage === "first_review_completed"
          ? await completedAssessmentId(tx, request.id, "risk")
          : null,
    },
  );
  if (!current) return { blocker: "RISK_ASSESSMENT_MISSING" as const };
  if (current.status !== "succeeded")
    return { blocker: "RISK_ASSESSMENT_FAILED" as const };
  return { assessment: current };
}
