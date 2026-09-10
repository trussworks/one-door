import { additionalRequests } from "./additional-requests.ts";
import { scenarioFixtures } from "./scenario-fixtures.ts";
import { requestScenarios } from "./scenarios.ts";
import { contentHash, daysBefore, stableUuid } from "./stable.ts";
import type { SeedData } from "./types.ts";

type CatalogRow = SeedData["catalogItems"][number];
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

export function buildRequests(args: BuildArgs): RequestData {
  const catalogCorpusHash = contentHash(
    args.catalogItems.map((item) => [
      item.itemKey,
      item.currentVersion,
      item.publicationState,
      item.approvalStatus,
    ]),
  );
  const policyCorpusHash = contentHash(
    args.policyRules.map((rule) => [rule.code, rule.version, rule.lifecycle]),
  );
  const contextArgs = { ...args, catalogCorpusHash, policyCorpusHash };
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
    assetCallId: stableUuid("model-call", input.key + ":asset"),
    riskCallId: stableUuid("model-call", input.key + ":risk"),
    assetFailed: input.key === "archived-board-packets",
    riskFailed: input.key === "retiring-benefit-calculation",
    serviceCandidateId: input.serviceOfferingKey
      ? stableUuid("service-candidate", input.key + ":1")
      : null,
    currentRiceVersion: riceVersion(input.key),
  };
}

function buildRequestFixture(context: Context): RequestData {
  const asset = buildAssets(context);
  const risk = buildRisks(context);
  const riceScores = buildRice(context);
  return {
    drafts: [draft(context)],
    modelCalls: modelCalls(context),
    draftTurns: turns(context),
    serviceCandidates: serviceCandidate(context),
    requests: [requestRow(context)],
    taskCompletions: taskCompletions(context),
    reviewTasks: reviewTaskRows(context),
    assetAssessments: [asset.assessment],
    assetCandidates: asset.candidates,
    assetCandidateDecisions: asset.decisions,
    riskAssessments: [risk.assessment],
    riskFindings: risk.findings,
    riskFindingDecisions: risk.decisions,
    riceScores,
    auditEvents: auditRows(context),
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
      key: context.input.key + ":asset",
      draftId: context.draftId,
      purpose: "asset_match",
      status: context.assetFailed ? "failed" : "succeeded",
      output: assetOutput,
      error: context.assetFailed
        ? "The fixture provider returned an incomplete candidate record."
        : null,
      corpusVersions: { catalog: context.catalogCorpusHash },
      createdAt: shiftMinutes(context.submitted, -10),
      completedAt: shiftMinutes(context.submitted, -9),
    }),
    modelCall({
      id: context.riskCallId,
      key: context.input.key + ":risk",
      draftId: context.draftId,
      purpose: "risk_assess",
      status: context.riskFailed ? "failed" : "succeeded",
      output: riskOutput,
      error: context.riskFailed
        ? "The fixture provider did not return a complete risk assessment."
        : null,
      corpusVersions: { policies: context.policyCorpusHash },
      createdAt: shiftMinutes(context.submitted, -10),
      completedAt: shiftMinutes(context.submitted, -9),
    }),
  ];
}

function turns(context: Context): SeedData["draftTurns"] {
  return context.input.conversation.map((turn, index) => ({
    id: stableUuid("draft-turn", context.input.key + ":" + index),
    fixtureKey: "draft-turn:" + context.input.key + ":" + index,
    draftId: context.draftId,
    ordinal: index,
    actor: turn.actor === "submitter" ? "customer" : "assistant",
    actorId: turn.actor === "submitter" ? context.requesterActorId : null,
    modelCallId: turn.actor === "assistant" ? context.intakeCallId : null,
    content: turn.content,
    createdAt: shiftMinutes(context.created, index * 4),
  }));
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
        : required(context.actorIds, "elena-castellanos", "review coordinator"),
    currentRiceScoreId,
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
    };
  });
}

function buildAssets(context: Context): {
  assessment: SeedData["assetAssessments"][number];
  candidates: SeedData["assetCandidates"];
  decisions: SeedData["assetCandidateDecisions"];
} {
  const assessment = {
    id: stableUuid("asset-assessment", context.input.key),
    fixtureKey: "asset-assessment:" + context.input.key,
    draftId: context.draftId,
    modelCallId: context.assetCallId,
    status: context.assetFailed ? "failed" : "succeeded",
    catalogCorpusHash: context.catalogCorpusHash,
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
    context.input.key + ":" + itemKey,
  );
  const decision = assetDecisionKind(context, index, rejected);
  const decisionId = decision
    ? stableUuid(
        "asset-candidate-decision",
        context.input.key + ":" + itemKey + ":1",
      )
    : null;
  return {
    candidate: {
      id: candidateId,
      fixtureKey: "asset-candidate:" + context.input.key + ":" + itemKey,
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
              ":1",
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
    id: stableUuid("risk-assessment", context.input.key),
    fixtureKey: "risk-assessment:" + context.input.key,
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
  const findingId = stableUuid("risk-finding", context.input.key + ":" + code);
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
      fixtureKey: "risk-finding:" + context.input.key + ":" + code,
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
      context.input.key + ":" + code + ":1",
    ),
    fixtureKey:
      "risk-finding-decision:" + context.input.key + ":" + code + ":1",
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
  if (!scoredKeys.has(context.input.key)) return [];
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

function capabilityFor(area: "assets" | "risk" | "rice"): string {
  if (area === "assets") return "review_existing_assets";
  if (area === "risk") return "review_risk";
  return "estimate_delivery_effort";
}

function assigneeFor(area: "assets" | "risk" | "rice"): string {
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

function riceVersion(key: string): number | null {
  if (!scoredKeys.has(key)) return null;
  return twoVersionKeys.has(key) ? 2 : 1;
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
