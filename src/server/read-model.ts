import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  actors,
  assetAssessments,
  assetCandidates,
  clarificationRequests,
  deliveryHandoffs,
  externalWorkItems,
  modelJobs,
  organizations,
  requestResolutions,
  requests,
  requestWorkItemLinks,
  reviewInputRequests,
  reviewInputResponses,
  reviewTasks,
  riceScores,
  riskAssessments,
  riskFindingDecisions,
  riskFindings,
  workSystems,
} from "../db/schema.ts";
import {
  businessDaysBetween,
  defaultWaitThresholds,
  type WaitThresholds,
} from "../domain/business-days.ts";
import {
  requestStages,
  riskSeverities,
  routingStates,
} from "../domain/constants.ts";
import { currentCorpusHashes } from "../models/corpus.ts";
import { isCurrentReviewInput } from "../domain/review-inputs.ts";
import { deriveWorkItemHealth } from "../workflow/delivery.ts";
import { selectCurrentAssessment } from "../workflow/review.ts";
import {
  parseInput,
  uuidSchema,
  withReadSnapshot,
  type Db,
  type Tx,
} from "../workflow/shared.ts";

/**
 * Every current request with its derived phase, action, and attention. The
 * batch reads run in one repeatable-read snapshot (or join the caller's), so
 * a concurrent write cannot pair one request's events with another moment.
 */
export function enrichedRequests(
  thresholds: WaitThresholds = defaultWaitThresholds,
  requestIds?: string[],
  reader?: Tx,
): Promise<EnrichedRequestRow[]> {
  const ids = requestIds?.map((id) => parseInput(uuidSchema, id));
  const parsed = parseThresholds(thresholds);
  return withReadSnapshot((tx) => loadEnrichedRows(tx, parsed, ids), reader);
}

export function phaseFields(row: EnrichedRequestRow) {
  return {
    phase: row.phase,
    phaseSince: row.phaseSince,
    waitingOn: row.waitingOn,
    businessDaysInPhase: row.businessDaysInPhase,
    overdue: row.overdue,
    actionNeeded: row.actionNeeded,
    needsAttention: row.needsAttention,
  };
}

export const requestPhaseTokens = [
  "received",
  "review",
  "waiting",
  "approved",
  "delivery",
  "resolved",
] as const;

export type RequestPhase = (typeof requestPhaseTokens)[number];

export const actionNeededTokens = [
  "wait_for_preparation",
  "retry_assessment",
  "refresh_preparation",
  "review_usage_limit",
  "review_assets",
  "review_risk",
  "score_rice",
  "complete_first_review",
  "wait_for_requester",
  "retry_handoff",
  "execute_handoff",
  "monitor_delivery",
  "record_outcome",
  "none",
] as const;

export type ActionNeeded = (typeof actionNeededTokens)[number];

export const thresholdsSchema = z.object({
  internalBusinessDays: z.number().int().min(1).max(30),
  requesterBusinessDays: z.number().int().min(1).max(30),
});

interface BaseRow {
  requestId: string;
  displayId: string;
  title: string;
  stage: (typeof requestStages)[number];
  routingState: (typeof routingStates)[number];
  rowVersion: number;
  requesterName: string;
  organizationName: string;
  coordinatorActorId: string | null;
  createdAt: string;
  updatedAt: string;
  nextOwner: string | null;
  deliveryOwnerActorId: string | null;
  deliveryOwnerName: string | null;
  nextTask: string | null;
  fixtureKey: string | null;
  currentRiceScoreId: string | null;
  currentRevisionId: string | null;
  sourceDraftId: string;
  fixtureGeneration: number;
  firstReviewCompletedAt: string | null;
  score: string | null;
  reachUnit: string | null;
  reachPeriod: string | null;
}

type Reader = Db | Tx;

async function baseRows(db: Reader, ids?: string[]): Promise<BaseRow[]> {
  if (ids && ids.length === 0) return [];
  const deliveryOwner = alias(actors, "delivery_owner");
  const query = db
    .select({
      requestId: requests.id,
      displayId: requests.displayId,
      title: requests.title,
      stage: requests.stage,
      routingState: requests.routingState,
      rowVersion: requests.rowVersion,
      requesterName: actors.displayName,
      organizationName: organizations.name,
      coordinatorActorId: requests.coordinatingActorId,
      createdAt: requests.createdAt,
      updatedAt: requests.updatedAt,
      nextOwner: requests.nextOwner,
      deliveryOwnerActorId: requests.deliveryOwnerActorId,
      deliveryOwnerName: deliveryOwner.displayName,
      nextTask: requests.nextTask,
      fixtureKey: requests.fixtureKey,
      currentRiceScoreId: requests.currentRiceScoreId,
      currentRevisionId: requests.currentRevisionId,
      sourceDraftId: requests.sourceDraftId,
      fixtureGeneration: requests.fixtureGeneration,
      firstReviewCompletedAt: requests.firstReviewCompletedAt,
      score: riceScores.score,
      reachUnit: riceScores.reachUnit,
      reachPeriod: riceScores.reachPeriod,
    })
    .from(requests)
    .innerJoin(actors, eq(actors.id, requests.requesterActorId))
    .innerJoin(
      organizations,
      eq(organizations.id, requests.requestingOrganizationId),
    )
    .leftJoin(riceScores, eq(riceScores.id, requests.currentRiceScoreId))
    .leftJoin(
      deliveryOwner,
      eq(deliveryOwner.id, requests.deliveryOwnerActorId),
    );
  const filtered = ids ? query.where(inArray(requests.id, ids)) : query;
  return filtered.orderBy(asc(requests.createdAt), asc(requests.id));
}

interface EventFacts {
  openQuestionAskedAt: string | null;
  lastAnswerAt: string | null;
  handoff: {
    status: "intended" | "confirmed" | "failed";
    confirmedAt: string | null;
    createdAt: string;
    sanitizedError: string | null;
  } | null;
  resolution: { outcome: string; createdAt: string } | null;
}

async function eventFacts(
  db: Reader,
  rows: BaseRow[],
): Promise<Map<string, EventFacts>> {
  const ids = rows.map((row) => row.requestId);
  const generationOf = new Map(
    rows.map((row) => [row.requestId, row.fixtureGeneration]),
  );
  const facts = new Map<string, EventFacts>(
    ids.map((id) => [
      id,
      {
        openQuestionAskedAt: null,
        lastAnswerAt: null,
        handoff: null,
        resolution: null,
      },
    ]),
  );
  if (ids.length === 0) return facts;
  const [questions, handoffs, resolutions] = await Promise.all([
    db
      .select({
        requestId: clarificationRequests.requestId,
        requestGeneration: clarificationRequests.requestGeneration,
        askedAt: clarificationRequests.askedAt,
        answeredAt: clarificationRequests.answeredAt,
      })
      .from(clarificationRequests)
      .where(inArray(clarificationRequests.requestId, ids)),
    db
      .select()
      .from(deliveryHandoffs)
      .where(inArray(deliveryHandoffs.requestId, ids)),
    db
      .select()
      .from(requestResolutions)
      .where(inArray(requestResolutions.requestId, ids)),
  ]);
  const currentFact = (row: {
    requestId: string;
    requestGeneration: number;
  }) =>
    row.requestGeneration === generationOf.get(row.requestId)
      ? facts.get(row.requestId)
      : undefined;
  mergeQuestionFacts(questions, currentFact);
  for (const row of handoffs) {
    const fact = currentFact(row);
    if (fact)
      fact.handoff = {
        status: row.status,
        confirmedAt: row.confirmedAt,
        createdAt: row.createdAt,
        sanitizedError: row.sanitizedError,
      };
  }
  for (const row of resolutions) {
    const fact = currentFact(row);
    if (fact)
      fact.resolution = { outcome: row.outcome, createdAt: row.createdAt };
  }
  return facts;
}

function mergeQuestionFacts(
  questions: Array<{
    requestId: string;
    requestGeneration: number;
    askedAt: string;
    answeredAt: string | null;
  }>,
  currentFact: (row: {
    requestId: string;
    requestGeneration: number;
  }) => EventFacts | undefined,
): void {
  for (const row of questions) {
    const fact = currentFact(row);
    if (!fact) continue;
    if (row.answeredAt === null) fact.openQuestionAskedAt = row.askedAt;
    else if (fact.lastAnswerAt === null || row.answeredAt > fact.lastAnswerAt)
      fact.lastAnswerAt = row.answeredAt;
  }
}

interface AssessmentFacts {
  assetId: string | null;
  assetStatus: "succeeded" | "failed" | null;
  assetStale: boolean;
  riskId: string | null;
  riskStatus: "succeeded" | "failed" | null;
  riskStale: boolean;
  /** A current assessment whose corpus hash no longer matches the live one. */
  corpusStale: boolean;
  readyAt: string | null;
}

interface AssessmentRowLite {
  draftId: string;
  status: "succeeded" | "failed";
  revisionId: string | null;
  requestGeneration: number;
  origin: string;
  corpusHash: string;
  createdAt: string;
  id: string;
}

/**
 * Currency and reversion follow the workflow's own shared rules: the
 * revision/generation gate plus corpus-hash preference, so an A -> B -> A
 * corpus reversion re-selects the cached A assessment here too.
 */
function currentAssessment(
  rows: AssessmentRowLite[],
  request: BaseRow,
  currency: { currentHash: string; approvedId: string | null },
): AssessmentRowLite | null {
  const mine = rows
    .filter((row) => row.draftId === request.sourceDraftId)
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? b.id.localeCompare(a.id)
        : b.createdAt.localeCompare(a.createdAt),
    );
  return selectCurrentAssessment(mine, request, (row) => row.corpusHash, {
    currentHash: currency.currentHash,
    approvedId: currency.approvedId,
  });
}

async function assessmentFacts(
  db: Reader,
  rows: BaseRow[],
  corpusHashes: { asset: string; risk: string },
): Promise<Map<string, AssessmentFacts>> {
  const draftIds = rows.map((row) => row.sourceDraftId);
  const facts = new Map<string, AssessmentFacts>();
  if (draftIds.length === 0) return facts;
  const completedIds = rows
    .filter((row) => row.stage === "first_review_completed")
    .map((row) => row.requestId);
  const approvedRows = completedIds.length
    ? await db
        .select({
          requestId: reviewTasks.requestId,
          area: reviewTasks.area,
          completedAssessmentId: reviewTasks.completedAssessmentId,
        })
        .from(reviewTasks)
        .where(
          and(
            inArray(reviewTasks.requestId, completedIds),
            eq(reviewTasks.state, "completed"),
          ),
        )
    : [];
  const approvedOf = new Map<
    string,
    { assets: string | null; risk: string | null }
  >();
  for (const row of approvedRows) {
    const entry = approvedOf.get(row.requestId) ?? { assets: null, risk: null };
    if (row.area === "assets") entry.assets = row.completedAssessmentId;
    if (row.area === "risk") entry.risk = row.completedAssessmentId;
    approvedOf.set(row.requestId, entry);
  }
  const [assetRows, riskRows] = await Promise.all([
    db
      .select({
        id: assetAssessments.id,
        draftId: assetAssessments.draftId,
        status: assetAssessments.status,
        revisionId: assetAssessments.revisionId,
        requestGeneration: assetAssessments.requestGeneration,
        origin: assetAssessments.origin,
        corpusHash: assetAssessments.catalogCorpusHash,
        createdAt: assetAssessments.createdAt,
      })
      .from(assetAssessments)
      .where(inArray(assetAssessments.draftId, draftIds)),
    db
      .select({
        id: riskAssessments.id,
        draftId: riskAssessments.draftId,
        status: riskAssessments.status,
        revisionId: riskAssessments.revisionId,
        requestGeneration: riskAssessments.requestGeneration,
        origin: riskAssessments.origin,
        corpusHash: riskAssessments.policyCorpusHash,
        createdAt: riskAssessments.createdAt,
      })
      .from(riskAssessments)
      .where(inArray(riskAssessments.draftId, draftIds)),
  ]);
  for (const request of rows)
    facts.set(
      request.requestId,
      assessmentFactsFor(request, assetRows, riskRows, {
        corpusHashes,
        approved: approvedOf.get(request.requestId) ?? {
          assets: null,
          risk: null,
        },
      }),
    );
  return facts;
}

function hashStale(
  row: AssessmentRowLite | null,
  currentHash: string,
): boolean {
  return row !== null && row.corpusHash !== currentHash;
}

function assessmentFactsFor(
  request: BaseRow,
  assetRows: AssessmentRowLite[],
  riskRows: AssessmentRowLite[],
  context: {
    corpusHashes: { asset: string; risk: string };
    approved: { assets: string | null; risk: string | null };
  },
): AssessmentFacts {
  const { corpusHashes, approved } = context;
  const asset = currentAssessment(assetRows, request, {
    currentHash: corpusHashes.asset,
    approvedId: approved.assets,
  });
  const risk = currentAssessment(riskRows, request, {
    currentHash: corpusHashes.risk,
    approvedId: approved.risk,
  });
  const assetStale = hashStale(asset, corpusHashes.asset);
  const riskStale = hashStale(risk, corpusHashes.risk);
  return {
    assetId: asset?.id ?? null,
    assetStatus: asset?.status ?? null,
    assetStale,
    riskId: risk?.id ?? null,
    riskStatus: risk?.status ?? null,
    riskStale,
    corpusStale: assetStale || riskStale,
    readyAt: assessmentsReadyAt(asset, risk),
  };
}

function assessmentsReadyAt(
  asset: AssessmentRowLite | null,
  risk: AssessmentRowLite | null,
): string | null {
  if (!asset || !risk) return null;
  return asset.createdAt > risk.createdAt ? asset.createdAt : risk.createdAt;
}

export interface ReviewTaskFact {
  area: "assets" | "risk" | "rice";
  state: "pending" | "in_progress" | "completed";
  assigneeActorId: string | null;
  completedAt: string | null;
  /** The assessment the completion reviewed; identity gates approval. */
  completedAssessmentId: string | null;
}

async function reviewTaskFacts(
  db: Reader,
  ids: string[],
): Promise<Map<string, ReviewTaskFact[]>> {
  const facts = new Map<string, ReviewTaskFact[]>();
  if (ids.length === 0) return facts;
  const rows = await db
    .select({
      requestId: reviewTasks.requestId,
      area: reviewTasks.area,
      state: reviewTasks.state,
      assigneeActorId: reviewTasks.assigneeActorId,
      completedAt: reviewTasks.completedAt,
      completedAssessmentId: reviewTasks.completedAssessmentId,
    })
    .from(reviewTasks)
    .where(inArray(reviewTasks.requestId, ids))
    .orderBy(asc(reviewTasks.area));
  for (const row of rows) {
    const list = facts.get(row.requestId) ?? [];
    list.push(row);
    facts.set(row.requestId, list);
  }
  return facts;
}

type SourceHealth = "current" | "stale" | "failed";

export interface WorkLinkFact {
  workItemId: string;
  relationship: string;
  system: string;
  externalId: string;
  title: string;
  sourceStatus: string;
  syncHealth: SourceHealth;
  /** Health with the system's freshness interval applied. */
  derivedHealth: SourceHealth;
  closedAt: string | null;
}

/** Current-generation links only; earlier generations are history. */
async function workLinkFacts(
  db: Reader,
  rows: BaseRow[],
): Promise<Map<string, WorkLinkFact[]>> {
  const facts = new Map<string, WorkLinkFact[]>();
  const ids = rows.map((row) => row.requestId);
  if (ids.length === 0) return facts;
  const generationOf = new Map(
    rows.map((row) => [row.requestId, row.fixtureGeneration]),
  );
  const links = await db
    .select({
      requestId: requestWorkItemLinks.requestId,
      requestGeneration: requestWorkItemLinks.requestGeneration,
      fixtureKey: requestWorkItemLinks.fixtureKey,
      workItemId: requestWorkItemLinks.workItemId,
      relationship: requestWorkItemLinks.relationship,
      system: externalWorkItems.system,
      externalId: externalWorkItems.externalId,
      title: externalWorkItems.title,
      sourceStatus: externalWorkItems.sourceStatus,
      syncHealth: externalWorkItems.syncHealth,
      lastSynchronizedAt: externalWorkItems.lastSynchronizedAt,
      closedAt: externalWorkItems.closedAt,
      expectedFreshnessHours: workSystems.expectedFreshnessHours,
    })
    .from(requestWorkItemLinks)
    .innerJoin(
      externalWorkItems,
      eq(externalWorkItems.id, requestWorkItemLinks.workItemId),
    )
    .innerJoin(workSystems, eq(workSystems.system, externalWorkItems.system))
    .where(inArray(requestWorkItemLinks.requestId, ids));
  const nowMs = Date.now();
  for (const row of links) {
    // Baseline fixture links stay current at any generation, like fixture
    // assessments; participant links bind to their generation.
    if (
      row.fixtureKey === null &&
      row.requestGeneration !== generationOf.get(row.requestId)
    )
      continue;
    const list = facts.get(row.requestId) ?? [];
    list.push({
      workItemId: row.workItemId,
      relationship: row.relationship,
      system: row.system,
      externalId: row.externalId,
      title: row.title,
      sourceStatus: row.sourceStatus,
      syncHealth: row.syncHealth,
      derivedHealth: deriveWorkItemHealth(
        row,
        row.expectedFreshnessHours,
        nowMs,
      ),
      closedAt: row.closedAt,
    });
    facts.set(row.requestId, list);
  }
  return facts;
}

interface PreparationJobs {
  assetJobStatus: string | null;
  riskJobStatus: string | null;
}

/**
 * Latest preparation-job status per purpose for the current revision and
 * generation. A capped job persists no assessment (the worker returns before
 * the provider call), so without the job status a capped request would look
 * like ordinary waiting.
 */
async function jobFacts(
  db: Reader,
  rows: BaseRow[],
  corpusHashes: { asset: string; risk: string },
): Promise<Map<string, PreparationJobs>> {
  const facts = new Map<string, PreparationJobs>(
    rows.map((row) => [
      row.requestId,
      { assetJobStatus: null, riskJobStatus: null },
    ]),
  );
  const draftIds = rows.map((row) => row.sourceDraftId);
  if (draftIds.length === 0) return facts;
  const jobs = await db
    .select({
      draftId: modelJobs.draftId,
      purpose: modelJobs.purpose,
      status: modelJobs.status,
      revisionId: modelJobs.revisionId,
      requestGeneration: modelJobs.requestGeneration,
      corpusHash: modelJobs.corpusHash,
      createdAt: modelJobs.createdAt,
      id: modelJobs.id,
    })
    .from(modelJobs)
    .where(inArray(modelJobs.draftId, draftIds))
    .orderBy(asc(modelJobs.createdAt), asc(modelJobs.id));
  for (const request of rows)
    facts.set(
      request.requestId,
      currentJobStatuses(request, jobs, corpusHashes),
    );
  return facts;
}

interface JobRowLite {
  draftId: string;
  purpose: string;
  status: string;
  revisionId: string | null;
  requestGeneration: number;
  corpusHash: string;
}

/**
 * A job for the current corpus wins over any later job for another corpus
 * (A -> B -> A reversion); without a corpus match the last matching job
 * still reports as history-shaped status.
 */
function currentJobStatuses(
  request: BaseRow,
  jobs: JobRowLite[],
  corpusHashes: { asset: string; risk: string },
): PreparationJobs {
  return {
    assetJobStatus: purposeJobStatus(
      request,
      jobs,
      "asset_match",
      corpusHashes.asset,
    ),
    riskJobStatus: purposeJobStatus(
      request,
      jobs,
      "risk_assess",
      corpusHashes.risk,
    ),
  };
}

function purposeJobStatus(
  request: BaseRow,
  jobs: JobRowLite[],
  purpose: string,
  currentHash: string,
): string | null {
  let status: string | null = null;
  let matched = false;
  // Ascending order: within each preference tier, the last job wins.
  for (const job of jobs) {
    if (job.purpose !== purpose) continue;
    if (job.draftId !== request.sourceDraftId) continue;
    if (job.revisionId !== request.currentRevisionId) continue;
    if (job.requestGeneration !== request.fixtureGeneration) continue;
    const matches = job.corpusHash === currentHash;
    if (matches || !matched) status = job.status;
    matched = matched || matches;
  }
  return status;
}

export type RiskSeverity = (typeof riskSeverities)[number];

/**
 * The reviewer queue's risk summary from the current assessment only. The
 * states keep unavailable or failed preparation and a drifted (stale)
 * result distinct from a genuine low-risk outcome, and an obsolete
 * assessment never ranks as current.
 */
export interface RiskFacts {
  status: "unassessed" | "preparing" | "failed" | "stale" | "assessed";
  /** Highest counted severity after human overrides; null when no open risk. */
  highestSeverity: RiskSeverity | null;
  /** Supported-risk findings a human has not cleared. */
  openFindings: number;
  /** Missing-information findings a human has not cleared. */
  missingInformation: number;
}

interface RiskFindingLite {
  assessmentId: string;
  kind: "supported_risk" | "missing_information";
  proposedSeverity: RiskSeverity | null;
  decision: string | null;
  finalSeverity: RiskSeverity | null;
}

async function riskFindingFacts(
  db: Reader,
  riskIds: string[],
): Promise<Map<string, RiskFindingLite[]>> {
  const byAssessment = new Map<string, RiskFindingLite[]>();
  if (riskIds.length === 0) return byAssessment;
  const rows = await db
    .select({
      assessmentId: riskFindings.assessmentId,
      kind: riskFindings.kind,
      proposedSeverity: riskFindings.proposedSeverity,
      decision: riskFindingDecisions.decision,
      finalSeverity: riskFindingDecisions.finalSeverity,
    })
    .from(riskFindings)
    .leftJoin(
      riskFindingDecisions,
      eq(riskFindingDecisions.id, riskFindings.currentDecisionId),
    )
    .where(inArray(riskFindings.assessmentId, riskIds));
  for (const row of rows) {
    const bucket = byAssessment.get(row.assessmentId) ?? [];
    bucket.push(row);
    byAssessment.set(row.assessmentId, bucket);
  }
  return byAssessment;
}

export const severityRank: Record<RiskSeverity, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const noRisk = {
  highestSeverity: null,
  openFindings: 0,
  missingInformation: 0,
};

function unpreparedRisk(
  assessments: AssessmentFacts,
  jobs: PreparationJobs,
): RiskFacts {
  if (assessments.riskStatus === "failed")
    return { status: "failed", ...noRisk };
  const jobStatus = jobs.riskJobStatus;
  if (jobStatus === "queued" || jobStatus === "leased")
    return { status: "preparing", ...noRisk };
  if (jobStatus === "failed" || jobStatus === "capped")
    return { status: "failed", ...noRisk };
  return { status: "unassessed", ...noRisk };
}

/**
 * Cleared findings are human not-applicable rulings and count nowhere; an
 * override replaces the proposed severity with the human one. A succeeded
 * assessment with everything cleared reads assessed with no open risk —
 * distinguishable from one that was never prepared.
 */
function riskFactsFor(
  assessments: AssessmentFacts,
  jobs: PreparationJobs,
  findings: RiskFindingLite[],
): RiskFacts {
  if (assessments.riskId === null || assessments.riskStatus !== "succeeded")
    return unpreparedRisk(assessments, jobs);
  // Partition by resolution, not by the immutable finding kind: an
  // overridden information gap becomes an open risk at the human severity,
  // and a supported risk sent to follow-up is also an information gap.
  const counted = findings.filter((row) => row.decision !== "cleared");
  const gaps = counted.filter(
    (row) =>
      (row.kind === "missing_information" && row.decision !== "overridden") ||
      row.decision === "follow_up_required",
  );
  const open = counted.filter(
    (row) => row.kind === "supported_risk" || row.decision === "overridden",
  );
  let highest: RiskSeverity | null = null;
  for (const finding of open) {
    const severity =
      finding.decision === "overridden"
        ? finding.finalSeverity
        : finding.proposedSeverity;
    if (
      severity !== null &&
      (highest === null || severityRank[severity] > severityRank[highest])
    )
      highest = severity;
  }
  return {
    status: assessments.riskStale ? "stale" : "assessed",
    highestSeverity: highest,
    openFindings: open.length,
    missingInformation: gaps.length,
  };
}

interface RequestBundle {
  base: BaseRow;
  events: EventFacts;
  assessments: AssessmentFacts;
  jobs: PreparationJobs;
  tasks: ReviewTaskFact[];
  links: WorkLinkFact[];
  riskFindings: RiskFindingLite[];
  inputRequests: ReviewInputSummary[];
}

type InputRow = typeof reviewInputRequests.$inferSelect;
type InputResponse = typeof reviewInputResponses.$inferSelect;
type InputSummaryRow = Pick<
  InputRow,
  | "id"
  | "area"
  | "audience"
  | "factor"
  | "candidateId"
  | "findingId"
  | "question"
  | "scope"
  | "expertise"
  | "assigneeActorId"
  | "askedByActorId"
  | "state"
  | "rowVersion"
  | "createdAt"
  | "updatedAt"
> & { assigneeName: string | null; askedByName: string };
type ResponseSummary = Pick<
  InputResponse,
  "id" | "outcome" | "respondentActorId" | "createdAt" | "contributionId"
> & { respondentName: string };

export interface ReviewInputSummary extends InputSummaryRow {
  latestResponse: ResponseSummary | null;
  businessDaysWaiting: number;
  overdue: boolean;
}

async function inputRequestFacts(
  db: Reader,
  rows: BaseRow[],
  assessments: Map<string, AssessmentFacts>,
) {
  const ids = rows.map((row) => row.requestId);
  const facts = new Map<
    string,
    Array<InputSummaryRow & { latestResponse: ResponseSummary | null }>
  >();
  if (!ids.length) return facts;
  const assignee = alias(actors, "input_assignee");
  const [questions, replies] = await Promise.all([
    db
      .select({
        input: reviewInputRequests,
        askedByName: actors.displayName,
        assigneeName: assignee.displayName,
        candidateAssessmentId: assetCandidates.assessmentId,
        findingAssessmentId: riskFindings.assessmentId,
      })
      .from(reviewInputRequests)
      .innerJoin(actors, eq(actors.id, reviewInputRequests.askedByActorId))
      .leftJoin(assignee, eq(assignee.id, reviewInputRequests.assigneeActorId))
      .leftJoin(
        assetCandidates,
        eq(assetCandidates.id, reviewInputRequests.candidateId),
      )
      .leftJoin(
        riskFindings,
        eq(riskFindings.id, reviewInputRequests.findingId),
      )
      .where(
        and(
          inArray(reviewInputRequests.requestId, ids),
          ne(reviewInputRequests.state, "resolved"),
        ),
      )
      .orderBy(asc(reviewInputRequests.createdAt), asc(reviewInputRequests.id)),
    latestInputResponses(db, ids),
  ]);
  const requestsById = new Map(rows.map((row) => [row.requestId, row]));
  const responsesById = new Map(
    replies.map((row) => [row.inputRequestId, row]),
  );
  for (const { input, ...names } of questions) {
    const request = requestsById.get(input.requestId);
    const selected = assessments.get(input.requestId);
    if (
      !request ||
      !selected ||
      !isCurrentReviewInput({ ...input, ...names }, request, {
        assetAssessmentId: selected.assetId,
        riskAssessmentId: selected.riskId,
      })
    )
      continue;
    const summaries = facts.get(input.requestId) ?? [];
    summaries.push({
      ...input,
      ...names,
      latestResponse: responsesById.get(input.id) ?? null,
    });
    facts.set(input.requestId, summaries);
  }
  return facts;
}

function latestInputResponses(db: Reader, requestIds: string[]) {
  return db
    .selectDistinctOn([reviewInputResponses.inputRequestId], {
      inputRequestId: reviewInputResponses.inputRequestId,
      id: reviewInputResponses.id,
      outcome: reviewInputResponses.outcome,
      respondentActorId: reviewInputResponses.respondentActorId,
      respondentName: actors.displayName,
      createdAt: reviewInputResponses.createdAt,
      contributionId: reviewInputResponses.contributionId,
    })
    .from(reviewInputResponses)
    .innerJoin(
      reviewInputRequests,
      eq(reviewInputRequests.id, reviewInputResponses.inputRequestId),
    )
    .innerJoin(actors, eq(actors.id, reviewInputResponses.respondentActorId))
    .where(inArray(reviewInputRequests.requestId, requestIds))
    .orderBy(
      asc(reviewInputResponses.inputRequestId),
      desc(reviewInputResponses.inputVersion),
    );
}

function inputWaits(
  inputs: Array<InputSummaryRow & { latestResponse: ResponseSummary | null }>,
  nowIso: string,
  thresholds: WaitThresholds,
): ReviewInputSummary[] {
  return inputs.map((input) => {
    const businessDaysWaiting = businessDaysBetween(
      input.latestResponse?.createdAt ?? input.createdAt,
      nowIso,
    );
    const threshold =
      input.latestResponse || input.audience === "internal"
        ? thresholds.internalBusinessDays
        : thresholds.requesterBusinessDays;
    return {
      ...input,
      businessDaysWaiting,
      overdue: businessDaysWaiting >= threshold,
    };
  });
}

export interface PhaseStatus {
  phase: RequestPhase;
  phaseSince: string;
  waitingOn: "requester" | "internal" | null;
  businessDaysInPhase: number;
  overdue: boolean;
}

function laterOf(...times: Array<string | null>): string {
  let latest = "";
  for (const time of times) if (time !== null && time > latest) latest = time;
  return latest;
}

/** Phases past first review, decided purely by immutable milestone rows. */
function settledPhase(
  bundle: RequestBundle,
): { phase: RequestPhase; phaseSince: string } | null {
  const { base, events } = bundle;
  if (events.resolution)
    return { phase: "resolved", phaseSince: events.resolution.createdAt };
  if (events.handoff?.status === "confirmed")
    return {
      phase: "delivery",
      phaseSince: events.handoff.confirmedAt ?? events.handoff.createdAt,
    };
  if (base.stage === "first_review_completed")
    return {
      phase: "approved",
      phaseSince:
        base.firstReviewCompletedAt ??
        events.handoff?.createdAt ??
        base.createdAt,
    };
  return null;
}

function derivePhase(bundle: RequestBundle): {
  phase: RequestPhase;
  phaseSince: string;
} {
  const settled = settledPhase(bundle);
  if (settled) return settled;
  const { base, events, assessments } = bundle;
  if (events.openQuestionAskedAt)
    return { phase: "waiting", phaseSince: events.openQuestionAskedAt };
  if (assessments.assetStatus && assessments.riskStatus)
    return {
      phase: "review",
      phaseSince: laterOf(
        base.createdAt,
        events.lastAnswerAt,
        assessments.readyAt,
      ),
    };
  return {
    phase: "received",
    phaseSince: laterOf(base.createdAt, events.lastAnswerAt),
  };
}

function waitingParty(phase: RequestPhase): "requester" | "internal" | null {
  if (phase === "resolved") return null;
  return phase === "waiting" ? "requester" : "internal";
}

function isOverdue(
  phase: RequestPhase,
  businessDays: number,
  thresholds: WaitThresholds,
): boolean {
  if (phase === "waiting")
    return businessDays >= thresholds.requesterBusinessDays;
  if (phase === "received" || phase === "review")
    return businessDays >= thresholds.internalBusinessDays;
  return false;
}

function deriveStatus(
  bundle: RequestBundle,
  nowIso: string,
  thresholds: WaitThresholds,
): PhaseStatus {
  const { phase, phaseSince } = derivePhase(bundle);
  const businessDaysInPhase = businessDaysBetween(phaseSince, nowIso);
  return {
    phase,
    phaseSince,
    waitingOn: waitingParty(phase),
    businessDaysInPhase,
    overdue: isOverdue(phase, businessDaysInPhase, thresholds),
  };
}

/** Completed for the assessment that is current now — identity, not state. */
function areaReviewed(
  tasks: ReviewTaskFact[],
  area: "assets" | "risk",
  currentAssessmentId: string | null,
): boolean {
  const task = tasks.find((entry) => entry.area === area);
  return (
    task?.state === "completed" &&
    currentAssessmentId !== null &&
    task.completedAssessmentId === currentAssessmentId
  );
}

function reviewAction(bundle: RequestBundle): ActionNeeded {
  const { assessments, tasks } = bundle;
  // A capped replacement outranks retry and refresh: both would just queue
  // work the caps refuse to run.
  if (cappedPreparation(bundle)) return "review_usage_limit";
  if (
    assessments.assetStatus === "failed" ||
    assessments.riskStatus === "failed"
  )
    return "retry_assessment";
  if (assessments.corpusStale) return "refresh_preparation";
  if (
    !areaReviewed(tasks, "assets", assessments.assetId) ||
    bundle.inputRequests.some((input) => input.area === "assets")
  )
    return "review_assets";
  if (
    !areaReviewed(tasks, "risk", assessments.riskId) ||
    bundle.inputRequests.some((input) => input.area === "risk")
  )
    return "review_risk";
  return "complete_first_review";
}

function assessmentFailed(bundle: RequestBundle): boolean {
  return (
    bundle.assessments.assetStatus === "failed" ||
    bundle.assessments.riskStatus === "failed"
  );
}

/**
 * A capped preparation job blocks a side that needs replacing: an absent,
 * failed, or corpus-stale assessment. Queued or leased stays ordinary.
 */
function cappedPreparation(bundle: RequestBundle): boolean {
  const { assessments, jobs } = bundle;
  const assetNeedsWork =
    assessments.assetStatus === null ||
    assessments.assetStatus === "failed" ||
    assessments.assetStale;
  const riskNeedsWork =
    assessments.riskStatus === null ||
    assessments.riskStatus === "failed" ||
    assessments.riskStale;
  return (
    (assetNeedsWork && jobs.assetJobStatus === "capped") ||
    (riskNeedsWork && jobs.riskJobStatus === "capped")
  );
}

function deliveryAction(bundle: RequestBundle): ActionNeeded {
  const required = bundle.links.filter(
    (link) => link.relationship === "required",
  );
  // A confirmed handoff with no required tickets is deliverable as planned:
  // fulfillment without a ticket records its outcome instead of monitoring
  // forever. Supporting links never gate the outcome.
  const done = required.every(
    (link) => link.closedAt !== null && link.derivedHealth === "current",
  );
  return done ? "record_outcome" : "monitor_delivery";
}

function deriveAction(
  bundle: RequestBundle,
  phase: RequestPhase,
): ActionNeeded {
  if (phase === "resolved") return "none";
  if (phase === "waiting") return "wait_for_requester";
  if (phase === "received") {
    if (cappedPreparation(bundle)) return "review_usage_limit";
    if (assessmentFailed(bundle)) return "retry_assessment";
    return "wait_for_preparation";
  }
  if (phase === "approved")
    return bundle.events.handoff?.status === "failed"
      ? "retry_handoff"
      : "execute_handoff";
  if (phase === "delivery") return deliveryAction(bundle);
  return reviewAction(bundle);
}

export interface AttentionFlags {
  unansweredClarification: boolean;
  reviewOverdue: boolean;
  waitingOverdue: boolean;
  blockedDelivery: boolean;
  missingOwner: boolean;
  /** Preparation failed or its corpus went stale; approval is blocked. */
  stalePreparation: boolean;
  /** Preparation stopped at the usage caps; queued or leased is ordinary. */
  cappedPreparation: boolean;
}

function deliveryBlocked(bundle: RequestBundle): boolean {
  return (
    bundle.events.handoff?.status === "failed" ||
    bundle.links.some((link) => link.derivedHealth !== "current")
  );
}

function preparationStale(bundle: RequestBundle): boolean {
  return assessmentFailed(bundle) || bundle.assessments.corpusStale;
}

function deriveAttention(
  bundle: RequestBundle,
  status: PhaseStatus,
): AttentionFlags {
  const active = status.phase !== "resolved";
  const preApproval =
    status.phase === "received" ||
    status.phase === "review" ||
    status.phase === "waiting";
  return {
    unansweredClarification: status.phase === "waiting",
    reviewOverdue:
      (status.phase === "received" || status.phase === "review") &&
      status.overdue,
    waitingOverdue: status.phase === "waiting" && status.overdue,
    blockedDelivery: active && deliveryBlocked(bundle),
    missingOwner: active && bundle.base.coordinatorActorId === null,
    stalePreparation: preApproval && preparationStale(bundle),
    cappedPreparation: preApproval && cappedPreparation(bundle),
  };
}

function inputStatus(bundle: RequestBundle, phase: RequestPhase) {
  const inputRequests = phase === "resolved" ? [] : bundle.inputRequests;
  const inputAllocationNeeded = inputRequests.some(
    (input) => input.audience === "internal" && input.assigneeActorId === null,
  );
  const inputOverdue = inputRequests.some((input) => input.overdue);
  const priorityPending =
    phase !== "resolved" &&
    (bundle.base.score === null ||
      inputRequests.some((input) => input.area === "rice"));
  return {
    inputRequests,
    inputAllocationNeeded,
    inputOverdue,
    priorityPending,
    score: priorityPending ? null : bundle.base.score,
  };
}

function toEnrichedRow(
  bundle: RequestBundle,
  nowIso: string,
  thresholds: WaitThresholds,
) {
  const status = deriveStatus(bundle, nowIso, thresholds);
  const attention = deriveAttention(bundle, status);
  const base = bundle.base;
  const inputs = inputStatus(bundle, status.phase);
  return {
    ...base,
    ...inputs,
    origin: base.fixtureKey === null ? ("live" as const) : ("seed" as const),
    ...status,
    actionNeeded: deriveAction(bundle, status.phase),
    reviewTasks: bundle.tasks,
    assetAssessmentStatus: bundle.assessments.assetStatus,
    riskAssessmentStatus: bundle.assessments.riskStatus,
    assetJobStatus: bundle.jobs.assetJobStatus,
    riskJobStatus: bundle.jobs.riskJobStatus,
    handoffStatus: bundle.events.handoff?.status ?? null,
    resolutionOutcome: bundle.events.resolution?.outcome ?? null,
    risk: riskFactsFor(bundle.assessments, bundle.jobs, bundle.riskFindings),
    workLinks: bundle.links,
    attention,
    needsAttention:
      Object.values(attention).some(Boolean) ||
      inputs.inputAllocationNeeded ||
      inputs.inputOverdue,
  };
}

export type EnrichedRequestRow = ReturnType<typeof toEnrichedRow>;

async function loadEnrichedRows(
  db: Reader,
  thresholds: WaitThresholds,
  ids?: string[],
): Promise<EnrichedRequestRow[]> {
  const rows = await baseRows(db, ids);
  const rowIds = rows.map((row) => row.requestId);
  const corpusHashes = await currentCorpusHashes(db);
  const [events, assessments, jobs, tasks, links] = await Promise.all([
    eventFacts(db, rows),
    assessmentFacts(db, rows, corpusHashes),
    jobFacts(db, rows, corpusHashes),
    reviewTaskFacts(db, rowIds),
    workLinkFacts(db, rows),
  ]);
  const [findingRows, inputs] = await Promise.all([
    riskFindingFacts(
      db,
      [...assessments.values()]
        .map((fact) => fact.riskId)
        .filter((id): id is string => id !== null),
    ),
    inputRequestFacts(db, rows, assessments),
  ]);
  const nowIso = new Date().toISOString();
  return rows.map((base) => {
    const facts = assessments.get(base.requestId) as AssessmentFacts;
    return toEnrichedRow(
      {
        base,
        events: events.get(base.requestId) as EventFacts,
        assessments: facts,
        jobs: jobs.get(base.requestId) as PreparationJobs,
        tasks: tasks.get(base.requestId) ?? [],
        links: links.get(base.requestId) ?? [],
        riskFindings:
          facts.riskId === null ? [] : (findingRows.get(facts.riskId) ?? []),
        inputRequests: inputWaits(
          inputs.get(base.requestId) ?? [],
          nowIso,
          thresholds,
        ),
      },
      nowIso,
      thresholds,
    );
  });
}

function parseThresholds(input: unknown): WaitThresholds {
  return parseInput(thresholdsSchema, input);
}
