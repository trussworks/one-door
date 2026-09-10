import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  actors,
  assetAssessments,
  assetCandidateDecisions,
  assetCandidates,
  catalogFieldDecisions,
  catalogItems,
  drafts,
  modelCalls,
  modelJobs,
  organizations,
  policyRules,
  requests,
  riceScores,
  riskAssessments,
  riskFindingDecisions,
  riskFindings,
  serviceCandidates,
  serviceOfferings,
} from "../db/schema.ts";
import { defaultWaitThresholds } from "../domain/business-days.ts";
import type { PriorityView } from "../domain/priority.ts";
import { collectCorpus, currentCorpusHashes } from "../models/corpus.ts";
import { listDraftJobs } from "../models/jobs.ts";
import { getRequestRecord } from "../workflow/clarification.ts";
import { getDeliveryState } from "../workflow/delivery.ts";
import { readPriority } from "../workflow/priority.ts";
import { readReviewInputs } from "../workflow/review-inputs.ts";
import {
  assetFitDecisionRows,
  currentLogicalJobs,
  getAssetPreview,
  getIntakeState,
  questionStates,
} from "../workflow/intake.ts";
import { getOwnDraft, getOwnRequest } from "../workflow/requester.ts";
import {
  completedAssessmentId,
  getReviewState,
  selectCurrentAssessment,
} from "../workflow/review.ts";
import {
  parseInput,
  uuidSchema,
  withReadSnapshot,
  type Db,
  type Tx,
  type VisitorContext,
} from "../workflow/shared.ts";
import { enrichedRequests, phaseFields } from "./read-model.ts";
import { administratorNotes, recordEvidence } from "./record-evidence.ts";

export async function requestView(
  context: VisitorContext,
  id: string,
  requesterView: boolean,
) {
  const requestId = parseInput(uuidSchema, id);
  // One repeatable-read snapshot for every read in the view: ownership, the
  // record, review and delivery state, derived status, evidence, and jobs
  // all describe the same committed moment even under concurrent review.
  return withReadSnapshot(async (tx) => {
    if (requesterView) await getOwnRequest(context, requestId, tx);
    const record = await getRequestRecord(requestId, tx);
    const review = await getReviewState(requestId, tx);
    const delivery = await getDeliveryState(requestId, tx);
    const enriched = await enrichedRequests(
      defaultWaitThresholds,
      [requestId],
      tx,
    );
    const status = enriched[0] ?? null;
    const facts = await requestFacts(tx, requestId);
    const assessments = await assessmentRows(tx, facts.draftId, facts);
    const [candidates, findings, scores] = await Promise.all([
      candidateRows(tx, assessments.assetAssessment),
      findingRows(tx, assessments.riskAssessment?.id),
      tx
        .select()
        .from(riceScores)
        .where(eq(riceScores.requestId, requestId))
        .orderBy(desc(riceScores.version)),
    ]);
    const jobs = await listDraftJobs(facts.draftId, tx);
    const currentJobs = await currentLogicalJobs(tx, facts.draftId, requestId);
    const parentRequest = await relatedParent(tx, facts.parentRequestId);
    const followUps = await followUpRows(tx, requestId);
    const choices = await serviceChoices(tx, requestId);
    const evidence = await recordEvidence(tx, requestId, facts.draftId);
    const notes = requesterView ? [] : await administratorNotes(tx, requestId);
    const assetFitDecisions = await assetFitDecisionRows(
      tx,
      facts.draftId,
      assessments.assetAssessment?.modelCallId ?? null,
    );
    const { priority, inputRequests } = await priorityAndInputs(
      tx,
      requestId,
      requesterView,
    );
    return {
      record,
      review,
      delivery,
      status: status === null ? null : phaseFields(status),
      attention: status?.attention ?? null,
      thresholds: defaultWaitThresholds,
      ...facts,
      ...assessments,
      candidates,
      findings,
      scores,
      jobs,
      serviceChoices: choices,
      serviceEvaluation: await serviceEvaluationFor(tx, facts.draftId),
      intakeDialogue: await questionStates(tx, facts.draftId),
      evidence,
      administratorNotes: notes,
      assetFitDecisions,
      priority,
      inputRequests,
      currentJobs,
      parentRequest,
      followUps,
    };
  });
}

function requesterPriority(priority: PriorityView): PriorityView {
  return {
    ...priority,
    factors: priority.factors.map((factor) => {
      const proposals = factor.proposals.filter(
        (proposal) => proposal.source === "requester",
      );
      const ownProposalIds = new Set(proposals.map((proposal) => proposal.id));
      return {
        ...factor,
        proposals,
        decisions: factor.decisions.filter(
          (decision) =>
            decision.proposalId !== null &&
            ownProposalIds.has(decision.proposalId),
        ),
      };
    }),
  };
}

async function priorityAndInputs(
  tx: Tx,
  requestId: string,
  requesterView: boolean,
) {
  const [savedPriority, allInputs] = await Promise.all([
    readPriority(tx, requestId),
    readReviewInputs(tx, requestId),
  ]);
  const waiting = allInputs.some(
    (input) =>
      input.current && input.area === "rice" && input.state !== "resolved",
  );
  const priority = waiting
    ? { ...savedPriority, complete: false, scoreId: null, score: null }
    : savedPriority;
  return {
    priority: requesterView ? requesterPriority(priority) : priority,
    inputRequests: requesterView
      ? allInputs.filter((input) => input.audience === "requester")
      : allInputs,
  };
}

/**
 * One owned draft view from a single repeatable-read snapshot, so the
 * conversation, generated questions, asset preview, service options, and
 * job statuses always agree with each other while the interface polls.
 */
export async function draftView(
  context: VisitorContext,
  draftIdInput: unknown,
) {
  const draftId = parseInput(uuidSchema, draftIdInput);
  return withReadSnapshot(async (tx) => {
    const draft = await getOwnDraft(context, draftId, tx);
    const intake = await getIntakeState(context, draftId, tx);
    const assetPreview = await getAssetPreview(context, draftId, tx);
    const services = await serviceOptions(draftId, tx);
    const jobs = await listDraftJobs(draftId, tx);
    const currentJobs = await currentLogicalJobs(tx, draftId);
    return {
      draft,
      intake,
      assetPreview,
      serviceOptions: services,
      jobs,
      currentJobs,
    };
  });
}

export function serviceOptions(draftIdInput: unknown, reader?: Tx) {
  const draftId = parseInput(uuidSchema, draftIdInput);
  return withReadSnapshot(
    (db) =>
      db
        .select({
          id: serviceCandidates.id,
          offeringId: serviceOfferings.id,
          name: serviceOfferings.name,
          description: serviceOfferings.description,
          coverage: serviceCandidates.coverage,
          gaps: serviceCandidates.gaps,
          rationale: serviceCandidates.rationale,
          modelCallId: serviceCandidates.modelCallId,
          decision: serviceCandidates.decision,
        })
        .from(serviceCandidates)
        .innerJoin(
          serviceOfferings,
          eq(serviceOfferings.id, serviceCandidates.offeringId),
        )
        .where(eq(serviceCandidates.draftId, draftId))
        .orderBy(asc(serviceCandidates.rank)),
    reader,
  );
}

async function requestFacts(db: Db | Tx, requestId: string) {
  const [row] = await db
    .select({
      rawNeed: drafts.rawNeed,
      draftId: drafts.id,
      requestId: requests.id,
      stage: requests.stage,
      fixtureKey: requests.fixtureKey,
      organizationName: organizations.name,
      requesterName: actors.displayName,
      currentRevisionId: requests.currentRevisionId,
      fixtureGeneration: requests.fixtureGeneration,
      parentRequestId: drafts.parentRequestId,
    })
    .from(requests)
    .innerJoin(drafts, eq(drafts.id, requests.sourceDraftId))
    .innerJoin(
      organizations,
      eq(organizations.id, requests.requestingOrganizationId),
    )
    .innerJoin(actors, eq(actors.id, requests.requesterActorId))
    .where(eq(requests.id, requestId));
  return row;
}

/**
 * Currency here is the workflow's own isCurrentAssessment rule, so an
 * old-generation live result can never reappear through the API after a
 * fixture reset.
 */
async function assessmentRows(
  db: Db | Tx,
  draftId: string,
  request: {
    requestId: string;
    stage: string;
    currentRevisionId: string | null;
    fixtureGeneration: number;
  },
) {
  const [assets, risks, corpusHashes] = await Promise.all([
    db
      .select()
      .from(assetAssessments)
      .where(eq(assetAssessments.draftId, draftId))
      .orderBy(desc(assetAssessments.createdAt), desc(assetAssessments.id)),
    db
      .select()
      .from(riskAssessments)
      .where(eq(riskAssessments.draftId, draftId))
      .orderBy(desc(riskAssessments.createdAt), desc(riskAssessments.id)),
    currentCorpusHashes(db),
  ]);
  const approved =
    request.stage === "first_review_completed"
      ? {
          assets: await completedAssessmentId(db, request.requestId, "assets"),
          risk: await completedAssessmentId(db, request.requestId, "risk"),
        }
      : { assets: null, risk: null };
  return {
    assetAssessment: selectCurrentAssessment(
      assets,
      request,
      (row) => row.catalogCorpusHash,
      { currentHash: corpusHashes.asset, approvedId: approved.assets },
    ),
    riskAssessment: selectCurrentAssessment(
      risks,
      request,
      (row) => row.policyCorpusHash,
      { currentHash: corpusHashes.risk, approvedId: approved.risk },
    ),
  };
}

async function candidateRows(
  db: Db | Tx,
  assessment: { id: string; modelCallId: string | null } | null | undefined,
) {
  if (!assessment) return [];
  const assessmentId = assessment.id;
  const rows = await db
    .select({
      id: assetCandidates.id,
      catalogItemId: assetCandidates.catalogItemId,
      name: sql<string>`coalesce(${assetCandidates.name}, ${catalogItems.name})`,
      catalogVersion: assetCandidates.catalogVersion,
      currentVersion: catalogItems.currentVersion,
      currentDescription: catalogItems.description,
      currentCapabilities: catalogItems.capabilities,
      coverage: assetCandidates.coverage,
      gaps: assetCandidates.gaps,
      dependencies: assetCandidates.dependencies,
      rationale: assetCandidates.rationale,
      proposedByActorId: assetCandidates.proposedByActorId,
      decision: assetCandidateDecisions.decision,
      reason: assetCandidateDecisions.reason,
      decisionActorId: assetCandidateDecisions.actorId,
      decidedAt: assetCandidateDecisions.createdAt,
    })
    .from(assetCandidates)
    .innerJoin(catalogItems, eq(catalogItems.id, assetCandidates.catalogItemId))
    .leftJoin(
      assetCandidateDecisions,
      eq(assetCandidateDecisions.id, assetCandidates.currentDecisionId),
    )
    .where(eq(assetCandidates.assessmentId, assessmentId))
    .orderBy(asc(assetCandidates.rank));
  return attachCitedCatalogText(db, rows, assessment.modelCallId);
}

type SnapshotRecord = {
  catalogItemId: string;
  version: number;
  description: string;
  capabilities: string[];
};

function isSnapshotRecord(record: unknown): record is SnapshotRecord {
  if (typeof record !== "object" || record === null) return false;
  const fields = record as Record<string, unknown>;
  return (
    typeof fields.catalogItemId === "string" &&
    typeof fields.version === "number" &&
    typeof fields.description === "string" &&
    Array.isArray(fields.capabilities) &&
    fields.capabilities.every((entry) => typeof entry === "string")
  );
}

async function citedSnapshotRecords(
  db: Db | Tx,
  modelCallId: string | null,
): Promise<SnapshotRecord[]> {
  if (!modelCallId) return [];
  const [job] = await db
    .select({ corpusSnapshot: modelJobs.corpusSnapshot })
    .from(modelJobs)
    .where(eq(modelJobs.currentModelCallId, modelCallId))
    .limit(1);
  const records = job?.corpusSnapshot?.records;
  if (!Array.isArray(records)) return [];
  return records.filter(isSnapshotRecord);
}

type CandidateTextRow = {
  catalogItemId: string;
  catalogVersion: number;
  currentVersion: number;
  currentDescription: string;
  currentCapabilities: string[];
};

// Historical cards use the cited version's model snapshot, then field history.
// Missing provenance stays null rather than borrowing the current description.
async function attachCitedCatalogText<T extends CandidateTextRow>(
  db: Db | Tx,
  rows: T[],
  modelCallId: string | null,
) {
  const drifted = rows.filter(
    (row) => row.catalogVersion !== row.currentVersion,
  );
  const snapshots = drifted.length
    ? await citedSnapshotRecords(db, modelCallId)
    : [];
  const decisions = drifted.length
    ? await db
        .select({
          catalogItemId: catalogFieldDecisions.catalogItemId,
          fieldName: catalogFieldDecisions.fieldName,
          value: catalogFieldDecisions.value,
          canonicalVersion: catalogFieldDecisions.canonicalVersion,
        })
        .from(catalogFieldDecisions)
        .where(
          and(
            inArray(
              catalogFieldDecisions.catalogItemId,
              drifted.map((row) => row.catalogItemId),
            ),
            inArray(catalogFieldDecisions.fieldName, [
              "description",
              "capabilities",
            ]),
          ),
        )
    : [];
  return rows.map((row) => {
    const current = row.catalogVersion === row.currentVersion;
    const cited = (field: string): unknown => {
      const best = decisions
        .filter(
          (decision) =>
            decision.catalogItemId === row.catalogItemId &&
            decision.fieldName === field &&
            decision.canonicalVersion <= row.catalogVersion,
        )
        .sort((a, b) => b.canonicalVersion - a.canonicalVersion)[0];
      return best?.value ?? null;
    };
    const snapshot = current
      ? undefined
      : snapshots.find(
          (record) =>
            record.catalogItemId === row.catalogItemId &&
            record.version === row.catalogVersion,
        );
    // currentVersion stays on the row so the interface can name both the
    // cited and the current version.
    const { currentDescription, currentCapabilities, ...rest } = row;
    return {
      ...rest,
      catalogTextCurrent: current,
      description: current
        ? currentDescription
        : (snapshot?.description ??
          (cited("description") as string | null) ??
          null),
      capabilities: current
        ? currentCapabilities
        : (snapshot?.capabilities ??
          (cited("capabilities") as string[] | null) ??
          null),
    };
  });
}

async function findingRows(db: Db | Tx, assessmentId: string | undefined) {
  if (!assessmentId) return [];
  return db
    .select({
      id: riskFindings.id,
      kind: riskFindings.kind,
      evidence: riskFindings.evidence,
      missingInformation: riskFindings.missingInformation,
      severity: riskFindings.proposedSeverity,
      rationale: riskFindings.rationale,
      ruleCode: policyRules.code,
      ruleTitle: policyRules.title,
      ruleVersion: policyRules.version,
      ruleIsDemo: sql<boolean>`${policyRules.fixtureKey} is not null`,
      rule: policyRules.rule,
      domain: policyRules.domain,
      citation: policyRules.citation,
      decision: riskFindingDecisions.decision,
      finalSeverity: riskFindingDecisions.finalSeverity,
      decisionRationale: riskFindingDecisions.rationale,
      decisionActorId: riskFindingDecisions.actorId,
      decidedAt: riskFindingDecisions.createdAt,
    })
    .from(riskFindings)
    .innerJoin(policyRules, eq(policyRules.id, riskFindings.policyRuleId))
    .leftJoin(
      riskFindingDecisions,
      eq(riskFindingDecisions.id, riskFindings.currentDecisionId),
    )
    .where(eq(riskFindings.assessmentId, assessmentId))
    .orderBy(asc(policyRules.code));
}

async function serviceChoices(db: Tx, requestId: string) {
  return db
    .select({
      name: serviceOfferings.name,
      version: serviceOfferings.version,
      rationale: serviceCandidates.rationale,
      decision: serviceCandidates.decision,
      /** The requester's own fit verdict — evidence, never routing. */
      requesterDecision: serviceCandidates.decision,
      reason: serviceCandidates.decisionReason,
      decidedAt: serviceCandidates.decidedAt,
      selected: sql<boolean>`${requests.selectedServiceCandidateId} IS NOT DISTINCT FROM ${serviceCandidates.id}`,
    })
    .from(requests)
    .innerJoin(
      serviceCandidates,
      eq(serviceCandidates.draftId, requests.sourceDraftId),
    )
    .innerJoin(
      serviceOfferings,
      eq(serviceOfferings.id, serviceCandidates.offeringId),
    )
    .where(
      and(
        eq(requests.id, requestId),
        or(
          eq(serviceCandidates.id, requests.selectedServiceCandidateId),
          isNotNull(serviceCandidates.decision),
          isNotNull(serviceCandidates.decisionReason),
        ),
      ),
    )
    .orderBy(asc(serviceCandidates.rank));
}

/**
 * The intake call whose service candidates the view describes: the anchored
 * (confirmed) job when the submission adopted its evaluation, otherwise the
 * latest evaluated call as labeled history — never silently current.
 */
async function relevantIntakeCall(tx: Tx, draftId: string) {
  const [draft] = await tx
    .select({ anchored: drafts.confirmedIntakeJobId })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .limit(1);
  const anchored = draft?.anchored ?? null;
  const [call] = await tx
    .select({
      jobId: modelJobs.id,
      modelCallId: modelCalls.id,
      corpusVersions: modelCalls.corpusVersions,
    })
    .from(modelJobs)
    .innerJoin(modelCalls, eq(modelCalls.id, modelJobs.currentModelCallId))
    .where(
      and(
        eq(modelJobs.draftId, draftId),
        eq(modelJobs.purpose, "intake_interpret"),
        // A failed latest attempt has a call but no evaluation; it must not
        // shadow the last call that actually produced candidates.
        eq(modelCalls.status, "succeeded"),
        anchored ? eq(modelJobs.id, anchored) : undefined,
      ),
    )
    .orderBy(desc(modelJobs.createdAt))
    .limit(1);
  return call ? { ...call, anchored } : null;
}

/**
 * Every service candidate the relevant intake call evaluated, undecided
 * possibilities included, for the reviewer. matchesSubmission says the call
 * evaluated the words that were submitted; corpusCurrent says the offering
 * corpus is unchanged since the call ran.
 */
async function serviceEvaluationFor(tx: Tx, draftId: string) {
  const call = await relevantIntakeCall(tx, draftId);
  if (!call) return null;
  const rows = await tx
    .select({
      id: serviceCandidates.id,
      offeringId: serviceCandidates.offeringId,
      name: serviceOfferings.name,
      version: serviceOfferings.version,
      lifecycle: serviceOfferings.lifecycle,
      fitBand: serviceCandidates.fitBand,
      coverage: serviceCandidates.coverage,
      gaps: serviceCandidates.gaps,
      relatedOfferingKeys: serviceCandidates.relatedOfferingKeys,
      rationale: serviceCandidates.rationale,
      requesterDecision: serviceCandidates.decision,
      reason: serviceCandidates.decisionReason,
      decidedAt: serviceCandidates.decidedAt,
    })
    .from(serviceCandidates)
    .innerJoin(
      serviceOfferings,
      eq(serviceOfferings.id, serviceCandidates.offeringId),
    )
    .where(eq(serviceCandidates.modelCallId, call.modelCallId))
    .orderBy(asc(serviceCandidates.rank));
  const live = await collectCorpus(tx, "intake_interpret");
  const stored = (call.corpusVersions as { serviceOfferings?: unknown })
    .serviceOfferings;
  return {
    jobId: call.jobId,
    matchesSubmission: call.jobId === call.anchored,
    corpusCurrent:
      typeof stored === "string" &&
      stored === live.corpusVersions.serviceOfferings,
    candidates: rows,
  };
}

async function relatedParent(db: Db | Tx, parentRequestId: string | null) {
  if (!parentRequestId) return null;
  const [row] = await db
    .select({
      requestId: requests.id,
      displayId: requests.displayId,
      title: requests.title,
      stage: requests.stage,
    })
    .from(requests)
    .where(eq(requests.id, parentRequestId))
    .limit(1);
  return row ?? null;
}

/** Submitted follow-ups only: an unsubmitted linked draft has no request row. */
async function followUpRows(db: Db | Tx, requestId: string) {
  return db
    .select({
      requestId: requests.id,
      displayId: requests.displayId,
      title: requests.title,
      stage: requests.stage,
    })
    .from(requests)
    .innerJoin(drafts, eq(drafts.id, requests.sourceDraftId))
    .where(eq(drafts.parentRequestId, requestId))
    .orderBy(asc(requests.displayId));
}

export type DraftView = Awaited<ReturnType<typeof draftView>>;

export type RequestView = Awaited<ReturnType<typeof requestView>>;
