import { additionalRequests } from "./additional-requests.ts";
import { scenarioFixtures } from "./scenario-fixtures.ts";
import { requestScenarios } from "./scenarios.ts";
import { reviewCoordinatorKeyFor, seedActors } from "./actors.ts";
import { corpusHash } from "../models/corpus.ts";
import { contentHash, daysBefore, stableUuid } from "./stable.ts";
import type { SeedData } from "./types.ts";

type CatalogRow = SeedData["catalogItems"][number];
type ReviewArea = "assets" | "risk" | "rice";
type PolicyRow = SeedData["policyRules"][number];

interface RequestInput {
  key: string;
  title: string;
  problem: string;
  affectedPeople: string;
  acceptanceCriteria: string[];
  requirements: string[];
  constraints: string[];
  unknowns: string[];
  requesterActorKey: string;
  organizationKey: string;
  serviceOfferingKey: string | null;
  assetKeys: string[];
  rejectedAssetKeys: string[];
  policyCodes: string[];
  stage: "submitted" | "under_review" | "first_review_completed";
  conversation: Array<{ actor: "submitter" | "assistant"; content: string }>;
  rice: {
    reach: number;
    impact: number;
    confidence: number;
    effort: number;
  } | null;
  // A lifecycle marker seeds the extra evidence a phase needs: "received"
  // omits every assessment so the request stays pre-review; "waiting" adds an
  // open clarification; "delivery" adds a confirmed handoff; "resolved" adds a
  // confirmed handoff and a resolution.
  lifecycle?: "received" | "waiting" | "delivery" | "resolved";
}

interface BuildArgs {
  actorIds: Map<string, string>;
  organizationIds: Map<string, string>;
  offeringIds: Map<string, string>;
  catalogIds: Map<string, string>;
  policyIds: Map<string, string>;
  policyRules: PolicyRow[];
  catalogItems: CatalogRow[];
  referenceTime: string;
}

interface ContextArgs extends BuildArgs {
  catalogCorpusHash: string;
  staleCatalogHash: string;
  policyCorpusHash: string;
}

interface Context extends ContextArgs {
  input: RequestInput;
  index: number;
  draftId: string;
  requestId: string;
  requesterActorId: string;
  organizationId: string;
  created: string;
  submitted: string;
  updated: string;
  intakeCallId: string;
  assetCallId: string;
  riskCallId: string;
  assetFailed: boolean;
  riskFailed: boolean;
  serviceCandidateId: string | null;
  currentRiceVersion: number | null;
  catalogCorpusHash: string;
  staleCatalogHash: string;
  policyCorpusHash: string;
}

export type RequestData = Pick<
  SeedData,
  | "drafts"
  | "modelCalls"
  | "draftTurns"
  | "serviceCandidates"
  | "requests"
  | "taskCompletions"
  | "reviewTasks"
  | "assetAssessments"
  | "assetCandidates"
  | "assetCandidateDecisions"
  | "riskAssessments"
  | "riskFindings"
  | "riskFindingDecisions"
  | "riceScores"
  | "auditEvents"
  | "requestContentRevisions"
  | "clarificationRequests"
  | "deliveryHandoffs"
  | "requestResolutions"
>;

const scoredKeys = new Set([
  "budget-office-azure-deployment",
  "no-number-for-how-it-went",
  "callers-asking-where-it-stands",
  "funding-panel-scoring-drift",
  "grant-closeout-evidence",
  "quarterly-service-feedback",
  "cloud-release-rollback",
  "permissions-outlive-the-job",
]);
const twoVersionKeys = new Set([
  "budget-office-azure-deployment",
  "callers-asking-where-it-stands",
]);

/**
 * Identity revision for the immutable evidence tree (asset/risk model
 * calls, assessments, candidates, findings, and their decisions). The
 * fixture upgrade appends any evidence row a database is missing, so a
 * corrected evidence generation must carry new identities; making the
 * revision part of the seed itself means fixture reset owns the corrected
 * rows on fresh and upgraded databases alike.
 */
const EVIDENCE_REVISION = ":u2";

export function buildRequests(args: BuildArgs): RequestData {
  // The hashes must equal what collectCorpus computes over the seeded rows,
  // or every seeded assessment reads corpus-stale and the whole queue
  // demands a refresh, so the seed reuses the production formula.
  const eligibleCatalog = args.catalogItems.filter(
    (item) =>
      item.publicationState === "published" &&
      item.approvalStatus === "approved",
  );
  const catalogCorpusHash = corpusHash(
    eligibleCatalog.map((item) => [item.id, item.currentVersion]),
  );
  // One under-review example deliberately predates the newest catalog item,
  // so the queue's "Refresh the assessment" action stays demonstrable with
  // an honest cause: the corpus gained a member after that assessment ran.
  const staleCatalogHash = corpusHash(
    eligibleCatalog
      .filter((item) => item.itemKey !== "state-messaging-gateway")
      .map((item) => [item.id, item.currentVersion]),
  );
  const policyCorpusHash = corpusHash(
    args.policyRules
      .filter((rule) => rule.lifecycle === "active")
      .map((rule) => [rule.id, rule.contentHash]),
  );
  const contextArgs = {
    ...args,
    catalogCorpusHash,
    staleCatalogHash,
    policyCorpusHash,
  };
  const fixtures = buildRequestInputs().map((input, index) =>
    buildRequestFixture(contextFor(contextArgs, input, index)),
  );
  fixtures.push(quotaFixture(args));
  return mergeFixtures(fixtures);
}

function contextFor(
  args: ContextArgs,
  input: RequestInput,
  index: number,
): Context {
  const created = daysBefore(args.referenceTime, 45 - index);
  return {
    ...args,
    input,
    index,
    draftId: stableUuid("draft", input.key),
    requestId: stableUuid("request", input.key),
    requesterActorId: required(
      args.actorIds,
      input.requesterActorKey,
      "requester actor",
    ),
    organizationId: required(
      args.organizationIds,
      input.organizationKey,
      "request organization",
    ),
    created,
    submitted: shiftMinutes(created, 60),
    updated: daysBefore(args.referenceTime, index % 12),
    intakeCallId: stableUuid("model-call", input.key + ":intake"),
    assetCallId: stableUuid(
      "model-call",
      input.key + ":asset" + EVIDENCE_REVISION,
    ),
    riskCallId: stableUuid(
      "model-call",
      input.key + ":risk" + EVIDENCE_REVISION,
    ),
    assetFailed: input.key === "archived-board-packets",
    riskFailed: input.key === "retiring-benefit-calculation",
    serviceCandidateId: input.serviceOfferingKey
      ? stableUuid("service-candidate", input.key + ":1")
      : null,
    currentRiceVersion: riceVersion(input),
  };
}

/**
 * Every completed first review scored RICE before completing — the review
 * checklist requires a saved estimate — so completed-stage examples are
 * always scored alongside the deliberately scored in-progress ones.
 */
function scored(input: RequestInput): boolean {
  return input.stage === "first_review_completed" || scoredKeys.has(input.key);
}

function buildRequestFixture(context: Context): RequestData {
  // A received example is pre-review: it ran intake but no asset or risk
  // preparation, so it carries the intake call only and no assessments.
  const received = context.input.lifecycle === "received";
  const asset = buildAssets(context);
  const risk = buildRisks(context);
  const extras = lifecycleEvidence(context);
  return {
    drafts: [draft(context)],
    modelCalls: received
      ? modelCalls(context).slice(0, 1)
      : modelCalls(context),
    draftTurns: turns(context),
    serviceCandidates: serviceCandidate(context),
    requests: [requestRow(context)],
    taskCompletions: taskCompletions(context),
    reviewTasks: received ? [] : reviewTaskRows(context),
    assetAssessments: received ? [] : [asset.assessment],
    assetCandidates: received ? [] : asset.candidates,
    assetCandidateDecisions: received ? [] : asset.decisions,
    riskAssessments: received ? [] : [risk.assessment],
    riskFindings: received ? [] : risk.findings,
    riskFindingDecisions: received ? [] : risk.decisions,
    riceScores: received ? [] : buildRice(context),
    auditEvents: auditRows(context),
    requestContentRevisions: extras.revisions,
    clarificationRequests: extras.clarifications,
    deliveryHandoffs: extras.handoffs,
    requestResolutions: extras.resolutions,
  };
}

function draft(context: Context): SeedData["drafts"][number] {
  return {
    id: context.draftId,
    fixtureKey: "draft:" + context.input.key,
    visitorId: null,
    requesterActorId: context.requesterActorId,
    requestingOrganizationId: context.organizationId,
    rawNeed: context.input.conversation[0]?.content ?? context.input.problem,
    structuredContent: structuredRequest(context.input),
    fieldOrigins: {
      problem: "customer_confirmed",
      affectedPeople: "customer_confirmed",
      acceptanceCriteria: "customer_confirmed",
      requirements: "customer_confirmed",
      constraints: "customer_confirmed",
      unknowns: "customer_confirmed",
    },
    state: "submitted",
    currentStep: "submitted",
    rowVersion: 1,
    createdAt: context.created,
    updatedAt: context.submitted,
    submittedAt: context.submitted,
  };
}

function modelCalls(context: Context): SeedData["modelCalls"] {
  const assetOutput = context.assetFailed
    ? null
    : {
        catalogItemKeys: context.input.assetKeys,
        noMatch: context.input.assetKeys.length === 0,
      };
  const riskOutput = context.riskFailed
    ? null
    : { policyCodes: context.input.policyCodes };
  return [
    modelCall({
      id: context.intakeCallId,
      key: context.input.key + ":intake",
      draftId: context.draftId,
      purpose: "intake_interpret",
      status: "succeeded",
      output: {
        structuredRequest: structuredRequest(context.input),
        serviceOfferingKeys: context.input.serviceOfferingKey
          ? [context.input.serviceOfferingKey]
          : [],
      },
      createdAt: shiftMinutes(context.submitted, -20),
      completedAt: shiftMinutes(context.submitted, -19),
    }),
    modelCall({
      id: context.assetCallId,
      key: context.input.key + ":asset" + EVIDENCE_REVISION,
      draftId: context.draftId,
      purpose: "asset_match",
      status: context.assetFailed ? "failed" : "succeeded",
      output: assetOutput,
      error: context.assetFailed
        ? "The fixture provider returned an incomplete candidate record."
        : null,
      corpusVersions: { catalogItems: assetCorpusHash(context) },
      createdAt: shiftMinutes(context.submitted, -10),
      completedAt: shiftMinutes(context.submitted, -9),
    }),
    modelCall({
      id: context.riskCallId,
      key: context.input.key + ":risk" + EVIDENCE_REVISION,
      draftId: context.draftId,
      purpose: "risk_assess",
      status: context.riskFailed ? "failed" : "succeeded",
      output: riskOutput,
      error: context.riskFailed
        ? "The fixture provider did not return a complete risk assessment."
        : null,
      corpusVersions: { policyRules: context.policyCorpusHash },
      createdAt: shiftMinutes(context.submitted, -10),
      completedAt: shiftMinutes(context.submitted, -9),
    }),
  ];
}

function turns(context: Context): SeedData["draftTurns"] {
  const rows = context.input.conversation.map((turn, index) => ({
    id: stableUuid("draft-turn", context.input.key + ":" + index),
    fixtureKey: "draft-turn:" + context.input.key + ":" + index,
    draftId: context.draftId,
    ordinal: index,
    actor:
      turn.actor === "submitter"
        ? ("customer" as const)
        : ("assistant" as const),
    actorId: turn.actor === "submitter" ? context.requesterActorId : null,
    modelCallId: turn.actor === "assistant" ? context.intakeCallId : null,
    content: turn.content,
    createdAt: shiftMinutes(context.created, index * 4),
    replyToTurnId: null as string | null,
  }));
  // A requester turn that directly follows an assistant question is that
  // question's answer. Opening statements and any turn without a preceding
  // question stay unlinked, so no answer is ever invented.
  for (let index = 1; index < rows.length; index += 1) {
    if (
      rows[index].actor === "customer" &&
      rows[index - 1].actor === "assistant"
    )
      rows[index].replyToTurnId = rows[index - 1].id;
  }
  return rows;
}

function serviceCandidate(context: Context): SeedData["serviceCandidates"] {
  if (!context.input.serviceOfferingKey || !context.serviceCandidateId)
    return [];
  return [
    {
      id: context.serviceCandidateId,
      fixtureKey: "service-candidate:" + context.input.key + ":1",
      draftId: context.draftId,
      modelCallId: context.intakeCallId,
      offeringId: required(
        context.offeringIds,
        context.input.serviceOfferingKey,
        "service offering",
      ),
      rank: 1,
      fitBand: "strong",
      coverage: context.input.requirements.slice(0, 4),
      gaps: context.input.unknowns,
      relatedOfferingKeys: relatedOfferings(context.input.key),
      rationale:
        "The offering covers the confirmed outcome and material requirements while preserving the stated unknowns.",
      decision: "accepted",
      decidedByActorId: context.requesterActorId,
      decisionReason: null,
      decidedAt: shiftMinutes(context.submitted, -15),
    },
  ];
}

// Several named internal staff carry delivery, so the administrator list shows
// more than one next owner across completed reviews.
const deliveryLeadKeys = ["devon-okafor", "elena-castellanos", "jordan-lee"];

function deliveryLeadFor(index: number): string {
  return deliveryLeadKeys[index % deliveryLeadKeys.length];
}

function displayNameOf(key: string): string {
  const actor = seedActors.find((seed) => seed.key === key);
  if (!actor) throw new Error("unknown seed actor: " + key);
  return actor.displayName;
}

/**
 * A completed review carries a delivery owner and a next task, so the
 * administrator list shows a next owner rather than a blank. The task text is
 * derived verbatim from the request's first acceptance criterion.
 */
function deliveryOwnership(context: Context): {
  nextOwner: string | null;
  deliveryOwnerActorId: string | null;
  nextTask: string | null;
} {
  const criterion = context.input.acceptanceCriteria[0];
  if (context.input.stage !== "first_review_completed" || !criterion)
    return { nextOwner: null, deliveryOwnerActorId: null, nextTask: null };
  const leadKey = deliveryLeadFor(context.index);
  const nextTask = "Verify: " + criterion;
  return {
    nextOwner: displayNameOf(leadKey) + " — " + nextTask,
    deliveryOwnerActorId: required(context.actorIds, leadKey, "delivery lead"),
    nextTask,
  };
}

/**
 * Extra evidence a lifecycle marker needs. A fixture-owned key exempts each row
 * from the reset generation bump (see advanceStrandedGenerations), so a seeded
 * delivery or resolved example survives a repeated reset.
 */
function lifecycleEvidence(context: Context): {
  revisions: SeedData["requestContentRevisions"];
  clarifications: SeedData["clarificationRequests"];
  handoffs: SeedData["deliveryHandoffs"];
  resolutions: SeedData["requestResolutions"];
} {
  const life = context.input.lifecycle;
  const rows: ReturnType<typeof lifecycleEvidence> = {
    revisions: [],
    clarifications: [],
    handoffs: [],
    resolutions: [],
  };
  // The open clarification references a submission revision by a composite
  // key, so the waiting example seeds that revision alongside it.
  if (life === "waiting") {
    rows.revisions.push(submissionRevision(context));
    rows.clarifications.push(openClarification(context));
  }
  // Completing a first review always records a handoff, so an approved example
  // is actionable (Send the handoff); delivery and resolved confirm it.
  if (context.input.stage === "first_review_completed") {
    const confirmed = life === "delivery" || life === "resolved";
    rows.handoffs.push(handoff(context, confirmed ? "confirmed" : "intended"));
  }
  if (life === "resolved") rows.resolutions.push(resolution(context));
  return rows;
}

function revisionId(context: Context): string {
  return stableUuid("request-revision", context.input.key);
}

function submissionRevision(
  context: Context,
): SeedData["requestContentRevisions"][number] {
  return {
    id: revisionId(context),
    requestId: context.requestId,
    revisionNumber: 1,
    content: structuredRequest(context.input),
    source: "submission",
    authoredByActorId: context.requesterActorId,
    visitorId: null,
    createdAt: context.submitted,
  };
}

function openClarification(
  context: Context,
): SeedData["clarificationRequests"][number] {
  return {
    id: stableUuid("clarification", context.input.key),
    fixtureKey: "clarification:" + context.input.key,
    requestId: context.requestId,
    revisionId: revisionId(context),
    question: context.input.unknowns[0] ?? context.input.problem,
    askedByActorId: required(
      context.actorIds,
      "elena-castellanos",
      "review coordinator",
    ),
    askedAt: context.updated,
    answer: null,
    answeredAt: null,
    answerRevisionId: null,
    requestGeneration: 1,
    origin: "fixture",
  };
}

function handoff(
  context: Context,
  status: "intended" | "confirmed",
): SeedData["deliveryHandoffs"][number] {
  const leadKey = deliveryLeadFor(context.index);
  return {
    id: stableUuid("delivery-handoff", context.input.key),
    fixtureKey: "delivery-handoff:" + context.input.key,
    requestId: context.requestId,
    targetSystem: "servicenow",
    nextOwner: displayNameOf(leadKey),
    workPlan: [],
    retryKey: "fixture:delivery-handoff:" + context.input.key,
    status,
    sanitizedError: null,
    confirmedAt: status === "confirmed" ? context.updated : null,
    requestGeneration: 1,
    rowVersion: 1,
    createdAt: context.updated,
  };
}

// Codex-authored resolution summary for the resolved lifecycle example.
const RESOLVED_SUMMARY =
  "The survey is available after appointments, and staff can review ratings separately from comments.";

function resolution(context: Context): SeedData["requestResolutions"][number] {
  return {
    id: stableUuid("request-resolution", context.input.key),
    fixtureKey: "request-resolution:" + context.input.key,
    requestId: context.requestId,
    outcome: "fulfilled_new",
    summary: RESOLVED_SUMMARY,
    reason: null,
    resolvedByActorId: required(
      context.actorIds,
      deliveryLeadFor(context.index),
      "delivery lead",
    ),
    requestGeneration: 1,
    createdAt: context.updated,
  };
}

function requestRow(context: Context): SeedData["requests"][number] {
  const currentRiceScoreId = context.currentRiceVersion
    ? stableUuid(
        "rice-score",
        context.input.key + ":" + context.currentRiceVersion,
      )
    : null;
  return {
    id: context.requestId,
    displayId: "OD-" + String(1001 + context.index),
    fixtureKey: "request:" + context.input.key,
    ownerVisitorId: null,
    requesterActorId: context.requesterActorId,
    requestingOrganizationId: context.organizationId,
    sourceDraftId: context.draftId,
    selectedServiceCandidateId: context.serviceCandidateId,
    routingState: context.serviceCandidateId
      ? "service_selected"
      : "routing_requested",
    title: context.input.title,
    problem: context.input.problem,
    affectedPeople: context.input.affectedPeople,
    acceptanceCriteria: context.input.acceptanceCriteria,
    requirements: context.input.requirements,
    constraints: context.input.constraints,
    unknowns: context.input.unknowns,
    stage: context.input.stage,
    coordinatingActorId:
      context.input.stage === "submitted"
        ? null
        : required(
            context.actorIds,
            reviewCoordinatorKeyFor(context.input.key),
            "review coordinator",
          ),
    currentRiceScoreId,
    ...deliveryOwnership(context),
    rowVersion: 1,
    createdAt: context.submitted,
    updatedAt: context.updated,
    firstReviewCompletedAt:
      context.input.stage === "first_review_completed" ? context.updated : null,
  };
}

function taskCompletions(context: Context): SeedData["taskCompletions"] {
  const rows: SeedData["taskCompletions"] = [
    {
      id: stableUuid("task-completion", context.input.key + ":requester"),
      fixtureKey: "task-completion:" + context.input.key + ":requester",
      requestId: context.requestId,
      actorId: context.requesterActorId,
      visitorId: null,
      taskType: "requester_submission",
      actingView: "requester",
      rating: ratingFor(context.index),
      origin: "fixture",
      idempotencyKey: "fixture:" + context.input.key + ":requester-submission",
      completedAt: context.submitted,
    },
  ];
  if (context.input.stage === "first_review_completed")
    rows.push(contributorCompletion(context));
  return rows;
}

function contributorCompletion(
  context: Context,
): SeedData["taskCompletions"][number] {
  return {
    id: stableUuid("task-completion", context.input.key + ":contributor"),
    fixtureKey: "task-completion:" + context.input.key + ":contributor",
    requestId: context.requestId,
    actorId: required(
      context.actorIds,
      "elena-castellanos",
      "review coordinator",
    ),
    visitorId: null,
    taskType: "contributor_first_review",
    actingView: "contributor",
    rating: ratingFor(context.index + 3),
    origin: "fixture",
    idempotencyKey: "fixture:" + context.input.key + ":first-review",
    completedAt: context.updated,
  };
}

function reviewTaskRows(context: Context): SeedData["reviewTasks"] {
  return (["assets", "risk", "rice"] as const).map((area, index) => {
    const state = reviewState(context.input.stage, index);
    return {
      id: stableUuid("review-task", context.input.key + ":" + area),
      fixtureKey: "review-task:" + context.input.key + ":" + area,
      requestId: context.requestId,
      area,
      responsibleCapability: capabilityFor(area),
      assigneeActorId:
        context.input.stage === "submitted"
          ? null
          : required(context.actorIds, assigneeFor(area), "review assignee"),
      state,
      rowVersion: 1,
      createdAt: context.submitted,
      updatedAt: context.updated,
      completedAt: state === "completed" ? context.updated : null,
      // A completed area records the assessment it reviewed; the read model
      // pins that evidence even after later corpus drift.
      completedAssessmentId:
        state === "completed" ? pinnedAssessmentId(context, area) : null,
    };
  });
}

function pinnedAssessmentId(context: Context, area: ReviewArea): string | null {
  if (area === "assets")
    return stableUuid(
      "asset-assessment",
      context.input.key + EVIDENCE_REVISION,
    );
  if (area === "risk")
    return stableUuid("risk-assessment", context.input.key + EVIDENCE_REVISION);
  return null;
}

/** The one deliberately stale example keeps its pre-drift corpus hash. */
function assetCorpusHash(context: Context): string {
  return context.input.key === "levee-settlement-imagery"
    ? context.staleCatalogHash
    : context.catalogCorpusHash;
}

function buildAssets(context: Context): {
  assessment: SeedData["assetAssessments"][number];
  candidates: SeedData["assetCandidates"];
  decisions: SeedData["assetCandidateDecisions"];
} {
  const assessment = {
    id: stableUuid("asset-assessment", context.input.key + EVIDENCE_REVISION),
    fixtureKey: "asset-assessment:" + context.input.key + EVIDENCE_REVISION,
    draftId: context.draftId,
    modelCallId: context.assetCallId,
    status: context.assetFailed ? "failed" : "succeeded",
    catalogCorpusHash: assetCorpusHash(context),
    sanitizedError: context.assetFailed
      ? "The fixture provider returned an incomplete candidate record."
      : null,
    origin: "fixture",
    createdAt: shiftMinutes(context.submitted, -9),
  } as const;
  if (context.assetFailed) return { assessment, candidates: [], decisions: [] };
  const proposed = [
    ...context.input.assetKeys.map((itemKey) => ({ itemKey, rejected: false })),
    ...context.input.rejectedAssetKeys.map((itemKey) => ({
      itemKey,
      rejected: true,
    })),
  ];
  const built = proposed.map((item, index) =>
    assetCandidate({
      context,
      assessmentId: assessment.id,
      itemKey: item.itemKey,
      index,
      rejected: item.rejected,
    }),
  );
  return {
    assessment,
    candidates: built.map((item) => item.candidate),
    decisions: built
      .map((item) => item.decision)
      .filter((item): item is SeedData["assetCandidateDecisions"][number] =>
        Boolean(item),
      ),
  };
}

function assetCandidate({
  context,
  assessmentId,
  itemKey,
  index,
  rejected,
}: {
  context: Context;
  assessmentId: string;
  itemKey: string;
  index: number;
  rejected: boolean;
}): {
  candidate: SeedData["assetCandidates"][number];
  decision: SeedData["assetCandidateDecisions"][number] | null;
} {
  const candidateId = stableUuid(
    "asset-candidate",
    context.input.key + ":" + itemKey + EVIDENCE_REVISION,
  );
  const decision = assetDecisionKind(context, index, rejected);
  const decisionId = decision
    ? stableUuid(
        "asset-candidate-decision",
        context.input.key + ":" + itemKey + ":1" + EVIDENCE_REVISION,
      )
    : null;
  return {
    candidate: {
      id: candidateId,
      fixtureKey:
        "asset-candidate:" +
        context.input.key +
        ":" +
        itemKey +
        EVIDENCE_REVISION,
      assessmentId,
      catalogItemId: required(context.catalogIds, itemKey, "asset candidate"),
      catalogVersion: 1,
      rank: index + 1,
      fitBand: fitBand(rejected, index),
      coverage: assetCoverage(context, index, rejected),
      gaps: rejected
        ? context.input.requirements.slice(1)
        : context.input.unknowns,
      dependencies: assetDependencies(itemKey),
      rationale: assetRationale(rejected),
      currentDecisionId: decisionId,
    },
    decision:
      decisionId && decision
        ? {
            id: decisionId,
            fixtureKey:
              "asset-candidate-decision:" +
              context.input.key +
              ":" +
              itemKey +
              ":1" +
              EVIDENCE_REVISION,
            candidateId,
            decision,
            actorId: required(
              context.actorIds,
              "elena-castellanos",
              "asset reviewer",
            ),
            reason:
              decision === "rejected"
                ? "The asset does not cover the material requirement identified in the request."
                : null,
            origin: "fixture",
            createdAt: context.updated,
          }
        : null,
  };
}

function buildRisks(context: Context): {
  assessment: SeedData["riskAssessments"][number];
  findings: SeedData["riskFindings"];
  decisions: SeedData["riskFindingDecisions"];
} {
  const assessment = {
    id: stableUuid("risk-assessment", context.input.key + EVIDENCE_REVISION),
    fixtureKey: "risk-assessment:" + context.input.key + EVIDENCE_REVISION,
    draftId: context.draftId,
    modelCallId: context.riskCallId,
    status: context.riskFailed ? "failed" : "succeeded",
    policyCorpusHash: context.policyCorpusHash,
    sanitizedError: context.riskFailed
      ? "The fixture provider did not return a complete risk assessment."
      : null,
    origin: "fixture",
    createdAt: shiftMinutes(context.submitted, -9),
  } as const;
  if (context.riskFailed) return { assessment, findings: [], decisions: [] };
  const built = context.input.policyCodes.map((code, index) =>
    riskFinding(context, assessment.id, code, index),
  );
  return {
    assessment,
    findings: built.map((item) => item.finding),
    decisions: built
      .map((item) => item.decision)
      .filter((item): item is SeedData["riskFindingDecisions"][number] =>
        Boolean(item),
      ),
  };
}

function riskFinding(
  context: Context,
  assessmentId: string,
  code: string,
  index: number,
): {
  finding: SeedData["riskFindings"][number];
  decision: SeedData["riskFindingDecisions"][number] | null;
} {
  const findingId = stableUuid(
    "risk-finding",
    context.input.key + ":" + code + EVIDENCE_REVISION,
  );
  const missing =
    context.input.key === "budget-office-azure-deployment" && code === "SEC-05";
  const rule = context.policyRules.find((candidate) => candidate.code === code);
  if (!rule) throw new Error("Missing policy rule: " + code);
  const decision = riskDecision({
    context,
    findingId,
    code,
    index,
    missing,
  });
  return {
    finding: {
      id: findingId,
      fixtureKey:
        "risk-finding:" + context.input.key + ":" + code + EVIDENCE_REVISION,
      assessmentId,
      policyRuleId: required(context.policyIds, code, "risk rule"),
      kind: missing ? "missing_information" : "supported_risk",
      evidence: missing
        ? null
        : "The confirmed request contains facts addressed by rule " +
          code +
          ".",
      missingInformation: missing
        ? "The product owner has not confirmed the application data classification."
        : null,
      proposedSeverity: missing ? null : rule.defaultSeverity,
      rationale: missing
        ? "The production control set cannot be selected until the data classification is known."
        : "The rule applies to a material requirement or constraint in the confirmed request.",
      currentDecisionId: decision?.id ?? null,
    },
    decision,
  };
}

function riskDecision({
  context,
  findingId,
  code,
  index,
  missing,
}: {
  context: Context;
  findingId: string;
  code: string;
  index: number;
  missing: boolean;
}): SeedData["riskFindingDecisions"][number] | null {
  const decision = riskDecisionKind(context, index, missing);
  if (!decision) return null;
  const rationaleNeeded =
    decision === "overridden" || decision === "follow_up_required";
  return {
    id: stableUuid(
      "risk-finding-decision",
      context.input.key + ":" + code + ":1" + EVIDENCE_REVISION,
    ),
    fixtureKey:
      "risk-finding-decision:" +
      context.input.key +
      ":" +
      code +
      ":1" +
      EVIDENCE_REVISION,
    findingId,
    decision,
    finalSeverity: decision === "overridden" ? "moderate" : null,
    actorId: required(context.actorIds, "jordan-lee", "risk reviewer"),
    rationale: rationaleNeeded
      ? "The reviewer recorded the missing evidence and required owner before the request advances."
      : null,
    origin: "fixture",
    createdAt: context.updated,
  };
}

function buildRice(context: Context): SeedData["riceScores"] {
  if (!scored(context.input)) return [];
  const base = context.input.rice ?? {
    reach: 100 + context.index * 75,
    impact: context.index % 2 === 0 ? 2 : 1,
    confidence: 0.8,
    effort: 3 + (context.index % 4),
  };
  const count = twoVersionKeys.has(context.input.key) ? 2 : 1;
  return Array.from({ length: count }, (_, index) =>
    riceScore(context, base, index + 1, count),
  );
}

function riceScore(
  context: Context,
  base: NonNullable<RequestInput["rice"]>,
  version: number,
  versionCount: number,
): SeedData["riceScores"][number] {
  const confidence =
    version === 1 ? base.confidence : Math.max(0.4, base.confidence - 0.2);
  const applicantReach = context.input.key === "callers-asking-where-it-stands";
  return {
    id: stableUuid("rice-score", context.input.key + ":" + version),
    fixtureKey: "rice-score:" + context.input.key + ":" + version,
    requestId: context.requestId,
    version,
    reach: String(base.reach),
    reachUnit: applicantReach ? "applicants" : "staff members",
    reachPeriod: applicantReach ? "quarter" : "first year",
    reachRationale:
      "The responsible reviewer entered the population and period stated by the program office.",
    reachActorId: riceReviewer(context),
    impact: String(base.impact),
    impactRationale:
      "The expected outcome was compared with the published impact rubric.",
    impactActorId: riceReviewer(context),
    confidence: String(confidence),
    confidenceRationale:
      version === 1
        ? "The first assessment used the evidence available at intake."
        : "The reviewer reduced confidence after identifying an unmeasured assumption.",
    confidenceActorId: riceReviewer(context),
    effort: String(base.effort),
    effortRationale:
      "The delivery lead entered person-months for the current implementation path.",
    effortActorId: required(context.actorIds, "devon-okafor", "delivery lead"),
    score: ((base.reach * base.impact * confidence) / base.effort).toFixed(4),
    rubricVersion: "rice-rubric-v1",
    formulaVersion: "rice-v1",
    createdByActorId: riceReviewer(context),
    origin: "fixture",
    createdAt: shiftMinutes(context.updated, -(versionCount - version) * 120),
  };
}

function auditRows(context: Context): SeedData["auditEvents"] {
  const rows = [
    audit({
      key: context.input.key + ":submitted",
      eventType: "request_submitted",
      requestId: context.requestId,
      actorId: context.requesterActorId,
      actingView: "requester",
      createdAt: context.submitted,
      payload: { displayId: "OD-" + String(1001 + context.index) },
    }),
    audit({
      key: context.input.key + ":prepared",
      eventType: "review_material_prepared",
      requestId: context.requestId,
      actorId: required(context.actorIds, "one-door-system", "system actor"),
      actingView: null,
      createdAt: shiftMinutes(context.submitted, 1),
      payload: {
        assetStatus: context.assetFailed ? "failed" : "succeeded",
        riskStatus: context.riskFailed ? "failed" : "succeeded",
      },
    }),
  ];
  if (context.input.stage !== "submitted")
    rows.push(reviewOpenedAudit(context));
  if (context.input.stage === "first_review_completed")
    rows.push(reviewCompletedAudit(context));
  return rows;
}

function reviewOpenedAudit(context: Context): SeedData["auditEvents"][number] {
  return audit({
    key: context.input.key + ":review-opened",
    eventType: "first_review_opened",
    requestId: context.requestId,
    actorId: required(
      context.actorIds,
      "elena-castellanos",
      "review coordinator",
    ),
    actingView: "contributor",
    createdAt: shiftMinutes(context.submitted, 60),
    payload: {},
  });
}

function reviewCompletedAudit(
  context: Context,
): SeedData["auditEvents"][number] {
  return audit({
    key: context.input.key + ":review-complete",
    eventType: "first_review_completed",
    requestId: context.requestId,
    actorId: required(
      context.actorIds,
      "elena-castellanos",
      "review coordinator",
    ),
    actingView: "contributor",
    createdAt: context.updated,
    payload: {},
  });
}

function quotaFixture(args: BuildArgs): RequestData {
  const draftId = stableUuid("draft", "quota-paused-example");
  const actorId = required(args.actorIds, "nadia-brant", "quota actor");
  const at = daysBefore(args.referenceTime, 1);
  return {
    drafts: [
      {
        id: draftId,
        fixtureKey: "draft:quota-paused-example",
        visitorId: null,
        requesterActorId: actorId,
        requestingOrganizationId: required(
          args.organizationIds,
          "constituent-services",
          "quota organization",
        ),
        rawNeed: "We need help choosing the right service.",
        structuredContent: {},
        fieldOrigins: {},
        state: "open",
        currentStep: "model_limit",
        rowVersion: 1,
        createdAt: at,
        updatedAt: at,
        submittedAt: null,
      },
    ],
    modelCalls: [
      modelCall({
        id: stableUuid("model-call", "quota-paused-example:intake"),
        key: "quota-paused-example:intake",
        draftId,
        purpose: "intake_interpret",
        status: "denied",
        output: null,
        error: "The configured daily model limit was reached.",
        createdAt: at,
        completedAt: at,
      }),
    ],
    draftTurns: [
      {
        id: stableUuid("draft-turn", "quota-paused-example:0"),
        fixtureKey: "draft-turn:quota-paused-example:0",
        draftId,
        ordinal: 0,
        actor: "customer",
        actorId,
        modelCallId: null,
        content: "We need help choosing the right service.",
        createdAt: at,
      },
    ],
    serviceCandidates: [],
    requests: [],
    taskCompletions: [],
    reviewTasks: [],
    assetAssessments: [],
    assetCandidates: [],
    assetCandidateDecisions: [],
    riskAssessments: [],
    riskFindings: [],
    riskFindingDecisions: [],
    riceScores: [],
    auditEvents: [],
    requestContentRevisions: [],
    clarificationRequests: [],
    deliveryHandoffs: [],
    requestResolutions: [],
  };
}

function buildRequestInputs(): RequestInput[] {
  const anchors = requestScenarios.map((scenario) => {
    const fixture =
      scenarioFixtures[scenario.key as keyof typeof scenarioFixtures];
    if (!fixture)
      throw new Error("Missing scenario fixture mapping: " + scenario.key);
    return {
      key: scenario.key,
      title: scenario.title,
      problem: scenario.problem,
      affectedPeople: scenario.affectedUsers,
      acceptanceCriteria: scenario.successMetrics,
      requirements: scenario.requirements,
      constraints: scenario.constraints,
      unknowns: scenario.constraints.filter((constraint) =>
        /unknown|do not know|not yet|guess/i.test(constraint),
      ),
      requesterActorKey: fixture.requesterActorKey,
      organizationKey: fixture.organizationKey,
      serviceOfferingKey: fixture.serviceOfferingKey,
      assetKeys: scenario.expectedCatalogMatches,
      rejectedAssetKeys: scenario.rejectedCatalogMatches ?? [],
      policyCodes: scenario.expectedPolicyRules,
      stage: fixture.stage,
      conversation: scenario.conversation,
      rice: scenario.riceReviewed ?? scenario.riceDraft,
    } satisfies RequestInput;
  });
  const extras = additionalRequests.map((request): RequestInput => ({
    ...request,
    rejectedAssetKeys: [],
    conversation: [
      { actor: "submitter", content: request.problem },
      {
        actor: "assistant",
        content:
          "I captured the outcome, acceptance criteria, requirements, constraints, and remaining unknowns for your review.",
      },
    ],
    rice: null,
  }));
  return [...anchors, ...extras];
}

function modelCall({
  id,
  key,
  draftId,
  purpose,
  status,
  output,
  error = null,
  corpusVersions = {},
  createdAt,
  completedAt,
}: {
  id: string;
  key: string;
  draftId: string;
  purpose: "intake_interpret" | "asset_match" | "risk_assess";
  status: "succeeded" | "failed" | "denied";
  output: Record<string, unknown> | null;
  error?: string | null;
  corpusVersions?: Record<string, unknown>;
  createdAt: string;
  completedAt: string;
}): SeedData["modelCalls"][number] {
  return {
    id,
    fixtureKey: "model-call:" + key,
    draftId,
    visitorId: null,
    purpose,
    provider: "fixture",
    model: "seeded-claude-response",
    promptVersion: "v1",
    inputHash: contentHash({ draftId, purpose }),
    corpusVersions,
    status,
    attemptCount: status === "failed" ? 2 : 1,
    reservedCostMicros: 0,
    actualCostMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: status === "denied" ? 0 : 650,
    validatedOutput: output,
    sanitizedError: error,
    idempotencyKey: "fixture:" + key,
    origin: "fixture",
    createdAt,
    completedAt,
  };
}

function audit({
  key,
  eventType,
  requestId,
  actorId,
  actingView,
  createdAt,
  payload,
}: {
  key: string;
  eventType: string;
  requestId: string;
  actorId: string;
  actingView: "requester" | "contributor" | null;
  createdAt: string;
  payload: Record<string, unknown>;
}): SeedData["auditEvents"][number] {
  return {
    id: stableUuid("audit-event", key),
    actorId,
    visitorId: null,
    actingView,
    eventType,
    subjectType: "request",
    subjectId: requestId,
    payload,
    origin: "fixture",
    createdAt,
  };
}

function mergeFixtures(fixtures: RequestData[]): RequestData {
  return {
    drafts: fixtures.flatMap((fixture) => fixture.drafts),
    modelCalls: fixtures.flatMap((fixture) => fixture.modelCalls),
    draftTurns: fixtures.flatMap((fixture) => fixture.draftTurns),
    serviceCandidates: fixtures.flatMap((fixture) => fixture.serviceCandidates),
    requests: fixtures.flatMap((fixture) => fixture.requests),
    taskCompletions: fixtures.flatMap((fixture) => fixture.taskCompletions),
    reviewTasks: fixtures.flatMap((fixture) => fixture.reviewTasks),
    assetAssessments: fixtures.flatMap((fixture) => fixture.assetAssessments),
    assetCandidates: fixtures.flatMap((fixture) => fixture.assetCandidates),
    assetCandidateDecisions: fixtures.flatMap(
      (fixture) => fixture.assetCandidateDecisions,
    ),
    riskAssessments: fixtures.flatMap((fixture) => fixture.riskAssessments),
    riskFindings: fixtures.flatMap((fixture) => fixture.riskFindings),
    riskFindingDecisions: fixtures.flatMap(
      (fixture) => fixture.riskFindingDecisions,
    ),
    riceScores: fixtures.flatMap((fixture) => fixture.riceScores),
    auditEvents: fixtures.flatMap((fixture) => fixture.auditEvents),
    requestContentRevisions: fixtures.flatMap(
      (fixture) => fixture.requestContentRevisions,
    ),
    clarificationRequests: fixtures.flatMap(
      (fixture) => fixture.clarificationRequests,
    ),
    deliveryHandoffs: fixtures.flatMap((fixture) => fixture.deliveryHandoffs),
    requestResolutions: fixtures.flatMap(
      (fixture) => fixture.requestResolutions,
    ),
  };
}

function structuredRequest(input: RequestInput): Record<string, unknown> {
  return {
    title: input.title,
    problem: input.problem,
    affectedPeople: input.affectedPeople,
    acceptanceCriteria: input.acceptanceCriteria,
    requirements: input.requirements,
    constraints: input.constraints,
    unknowns: input.unknowns,
  };
}

function relatedOfferings(requestKey: string): string[] {
  return requestKey === "budget-office-azure-deployment"
    ? ["application-identity-secrets", "delivery-pipeline-enablement"]
    : [];
}

function reviewState(
  stage: RequestInput["stage"],
  areaIndex: number,
): "pending" | "in_progress" | "completed" {
  if (stage === "first_review_completed") return "completed";
  if (stage === "under_review" && areaIndex < 2) return "in_progress";
  return "pending";
}

function capabilityFor(area: ReviewArea): string {
  if (area === "assets") return "review_existing_assets";
  if (area === "risk") return "review_risk";
  return "estimate_delivery_effort";
}

function assigneeFor(area: ReviewArea): string {
  if (area === "assets") return "elena-castellanos";
  if (area === "risk") return "jordan-lee";
  return "devon-okafor";
}

function fitBand(
  rejected: boolean,
  index: number,
): "weak" | "strong" | "possible" {
  if (rejected) return "weak";
  return index === 0 ? "strong" : "possible";
}

function assetDecisionKind(
  context: Context,
  index: number,
  rejected: boolean,
): "accepted" | "rejected" | null {
  if (rejected) return "rejected";
  if (context.input.stage === "first_review_completed") return "accepted";
  if (
    context.input.stage === "under_review" &&
    index === 0 &&
    context.index % 3 === 0
  )
    return "accepted";
  return null;
}

function assetCoverage(
  context: Context,
  index: number,
  rejected: boolean,
): string[] {
  if (rejected) return context.input.requirements.slice(0, 1);
  return context.input.requirements.slice(
    index,
    Math.min(context.input.requirements.length, index + 3),
  );
}

function assetDependencies(itemKey: string): string[] {
  return itemKey === "colorado-azure-landing-zone"
    ? ["application identity", "delivery pipeline"]
    : [];
}

function assetRationale(rejected: boolean): string {
  return rejected
    ? "The asset is nearby by category but does not perform the requested work."
    : "The catalog capability covers a material part of the confirmed request.";
}

function riskDecisionKind(
  context: Context,
  index: number,
  missing: boolean,
): "confirmed" | "overridden" | "follow_up_required" | null {
  if (context.input.key === "callers-asking-where-it-stands" && index === 0)
    return "overridden";
  if (context.input.stage === "first_review_completed")
    return missing ? "follow_up_required" : "confirmed";
  if (
    context.input.stage === "under_review" &&
    index === 0 &&
    context.index % 4 === 0
  )
    return "follow_up_required";
  return null;
}

function riceVersion(input: RequestInput): number | null {
  if (!scored(input)) return null;
  return twoVersionKeys.has(input.key) ? 2 : 1;
}

function riceReviewer(context: Context): string {
  return required(context.actorIds, "desmond-arkwright", "RICE reviewer");
}

function ratingFor(index: number): 1 | 2 | 3 | 4 | 5 {
  const ratings = [5, 4, 5, 4, 3, 5, 4, 5] as const;
  return ratings[index % ratings.length];
}

function shiftMinutes(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

function required<K, V>(values: Map<K, V>, key: K, label: string): V {
  const value = values.get(key);
  if (value === undefined) throw new Error("Missing " + label + ": " + key);
  return value;
}
