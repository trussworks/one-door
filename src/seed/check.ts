import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { riskDomains } from "../domain/constants.ts";
import { buildSeedData } from "./build.ts";
import { catalogItems } from "./catalog.ts";
import { contentHash, SEED_NOW } from "./stable.ts";

const seed = buildSeedData();
const secondSeed = buildSeedData();

assert.equal(contentHash(seed), contentHash(secondSeed), "seed is not stable");
assert.equal(seed.organizations.length, 23);
assert.equal(seed.actors.length, 18);
assert.equal(seed.serviceOfferings.length, 12);
assert.equal(seed.catalogItems.length, 55);
assert.equal(seed.policyRules.length, 20);
assert.equal(seed.inventorySources.length, 3);
assert.equal(seed.inventorySourceRecords.length, 108);
assert.equal(seed.inventoryConflicts.length, 12);
assert.equal(seed.requests.length, 29);
assert.equal(seed.taskCompletions.length, 37);
assert.equal(seed.externalWorkItems.length, 18);

for (const [name, values] of Object.entries(seed)) {
  const rows = values as Array<{ fixtureKey?: string | null }>;
  const fixtureKeys = rows
    .map((row) =>
      "fixtureKey" in row
        ? (row.fixtureKey as string | null | undefined)
        : null,
    )
    .filter((value): value is string => Boolean(value));
  assertUnique(fixtureKeys, name + " fixture keys");
}

const organizationIds = ids(seed.organizations);
const actorIds = ids(seed.actors);
const visitorIds = ids(seed.visitors);
const offeringIds = ids(seed.serviceOfferings);
const draftIds = ids(seed.drafts);
const modelCallIds = ids(seed.modelCalls);
const serviceCandidateIds = ids(seed.serviceCandidates);
const requestIds = ids(seed.requests);
const inventorySourceIds = ids(seed.inventorySources);
const inventoryRunIds = ids(seed.inventorySyncRuns);
const sourceRecordIds = ids(seed.inventorySourceRecords);
const catalogIds = ids(seed.catalogItems);
const conflictIds = ids(seed.inventoryConflicts);
const assetAssessmentIds = ids(seed.assetAssessments);
const assetCandidateIds = ids(seed.assetCandidates);
const assetDecisionIds = ids(seed.assetCandidateDecisions);
const policyIds = ids(seed.policyRules);
const riskAssessmentIds = ids(seed.riskAssessments);
const riskFindingIds = ids(seed.riskFindings);
const riskDecisionIds = ids(seed.riskFindingDecisions);
const riceIds = ids(seed.riceScores);
const workItemIds = ids(seed.externalWorkItems);

for (const organization of seed.organizations)
  if (organization.parentId) assert(organizationIds.has(organization.parentId));
for (const actor of seed.actors)
  if (actor.organizationId) assert(organizationIds.has(actor.organizationId));
for (const visitor of seed.visitors) assert(actorIds.has(visitor.actorId));
for (const row of seed.wip) assert(visitorIds.has(row.visitorId));
for (const offering of seed.serviceOfferings)
  assert(organizationIds.has(offering.ownerOrganizationId));
for (const draft of seed.drafts) {
  assert(actorIds.has(draft.requesterActorId));
  assert(organizationIds.has(draft.requestingOrganizationId));
  if (draft.visitorId) assert(visitorIds.has(draft.visitorId));
}
for (const call of seed.modelCalls) {
  assert(draftIds.has(call.draftId));
  if (call.visitorId) assert(visitorIds.has(call.visitorId));
}
for (const turn of seed.draftTurns) {
  assert(draftIds.has(turn.draftId));
  if (turn.actorId) assert(actorIds.has(turn.actorId));
  if (turn.modelCallId) assert(modelCallIds.has(turn.modelCallId));
}
// A requester turn directly after an assistant question is its answer; a
// question is answered at most once, and no answer is invented elsewhere.
{
  const turnsByDraft = Object.groupBy(seed.draftTurns, (turn) => turn.draftId);
  let answered = 0;
  for (const rows of Object.values(turnsByDraft)) {
    const ordered = [...(rows ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const replies = new Set<string>();
    for (let index = 0; index < ordered.length; index += 1) {
      const turn = ordered[index];
      const reply = (turn as { replyToTurnId?: string | null }).replyToTurnId;
      const previous = index > 0 ? ordered[index - 1] : null;
      if (
        turn.actor === "customer" &&
        previous?.actor === "assistant" &&
        index > 0
      ) {
        assert.equal(
          reply,
          previous.id,
          turn.fixtureKey + " does not answer the preceding question",
        );
        answered += 1;
      } else {
        assert.equal(
          reply ?? null,
          null,
          turn.fixtureKey + " invents an answer",
        );
      }
      if (reply) {
        assert(!replies.has(reply), turn.fixtureKey + " duplicates an answer");
        replies.add(reply);
      }
    }
  }
  assert(answered > 0, "no seeded conversation carries an answered question");
}
for (const candidate of seed.serviceCandidates) {
  assert(draftIds.has(candidate.draftId));
  assert(modelCallIds.has(candidate.modelCallId));
  assert(offeringIds.has(candidate.offeringId));
}
for (const request of seed.requests) {
  assert(draftIds.has(request.sourceDraftId));
  assert(actorIds.has(request.requesterActorId));
  assert(organizationIds.has(request.requestingOrganizationId));
  if (request.selectedServiceCandidateId)
    assert(serviceCandidateIds.has(request.selectedServiceCandidateId));
  if (request.currentRiceScoreId)
    assert(riceIds.has(request.currentRiceScoreId));
}
for (const completion of seed.taskCompletions) {
  assert(requestIds.has(completion.requestId));
  assert(actorIds.has(completion.actorId));
}
for (const source of seed.inventorySources)
  assert(organizationIds.has(source.ownerOrganizationId));
for (const run of seed.inventorySyncRuns)
  assert(inventorySourceIds.has(run.sourceId));
for (const record of seed.inventorySourceRecords) {
  assert(inventoryRunIds.has(record.runId));
  assert(inventorySourceIds.has(record.sourceId));
  if (record.priorRecordId) assert(sourceRecordIds.has(record.priorRecordId));
}
for (const conflict of seed.inventoryConflicts) {
  assert(inventoryRunIds.has(conflict.openedByRunId));
  if (conflict.reopenedByRunId)
    assert(inventoryRunIds.has(conflict.reopenedByRunId));
  if (conflict.catalogItemId) assert(catalogIds.has(conflict.catalogItemId));
}
for (const member of seed.inventoryConflictMembers) {
  assert(conflictIds.has(member.conflictId));
  assert(sourceRecordIds.has(member.sourceRecordId));
}
const recordFieldsById = new Map(
  seed.inventorySourceRecords.map((record) => [
    record.id,
    record.normalizedFields as Record<string, unknown>,
  ]),
);
for (const decision of seed.catalogFieldDecisions) {
  assert(catalogIds.has(decision.catalogItemId));
  if (decision.sourceRecordId)
    assert(sourceRecordIds.has(decision.sourceRecordId));
  assert(actorIds.has(decision.decidedByActorId));
  if (decision.sourceRecordId && !decision.rationale) {
    const observed = recordFieldsById.get(decision.sourceRecordId)?.[
      decision.fieldName
    ];
    assert(
      JSON.stringify(observed) === JSON.stringify(decision.value),
      "source-only field decision without value-bearing evidence: " +
        decision.fixtureKey,
    );
  }
}
for (const source of seed.catalogItemSources) {
  assert(catalogIds.has(source.catalogItemId));
  assert(sourceRecordIds.has(source.sourceRecordId));
}
for (const task of seed.reviewTasks) {
  assert(requestIds.has(task.requestId));
  if (task.assigneeActorId) assert(actorIds.has(task.assigneeActorId));
}
for (const assessment of seed.assetAssessments) {
  assert(draftIds.has(assessment.draftId));
  if (assessment.modelCallId) assert(modelCallIds.has(assessment.modelCallId));
}
for (const candidate of seed.assetCandidates) {
  assert(assetAssessmentIds.has(candidate.assessmentId));
  assert(catalogIds.has(candidate.catalogItemId));
  if (candidate.currentDecisionId)
    assert(assetDecisionIds.has(candidate.currentDecisionId));
}
for (const decision of seed.assetCandidateDecisions) {
  assert(assetCandidateIds.has(decision.candidateId));
  assert(actorIds.has(decision.actorId));
}
for (const assessment of seed.riskAssessments) {
  assert(draftIds.has(assessment.draftId));
  if (assessment.modelCallId) assert(modelCallIds.has(assessment.modelCallId));
}
for (const finding of seed.riskFindings) {
  assert(riskAssessmentIds.has(finding.assessmentId));
  assert(policyIds.has(finding.policyRuleId));
  if (finding.currentDecisionId)
    assert(riskDecisionIds.has(finding.currentDecisionId));
}
for (const decision of seed.riskFindingDecisions) {
  assert(riskFindingIds.has(decision.findingId));
  assert(actorIds.has(decision.actorId));
}
for (const score of seed.riceScores) {
  assert(requestIds.has(score.requestId));
  assert(actorIds.has(score.reachActorId));
  assert(actorIds.has(score.impactActorId));
  assert(actorIds.has(score.confidenceActorId));
  assert(actorIds.has(score.effortActorId));
}
for (const link of seed.requestWorkItemLinks) {
  assert(requestIds.has(link.requestId));
  assert(workItemIds.has(link.workItemId));
}

const requestSignatures = seed.requests.map((request) =>
  contentHash({
    problem: request.problem,
    acceptanceCriteria: request.acceptanceCriteria,
    requirements: request.requirements,
    constraints: request.constraints,
  }),
);
assertUnique(requestSignatures, "request content signatures");

const actorById = new Map(seed.actors.map((actor) => [actor.id, actor]));
for (const request of seed.requests) {
  const actor = actorById.get(request.requesterActorId);
  assert(actor, "requester actor is missing");
  assert.equal(
    actor.organizationId,
    request.requestingOrganizationId,
    request.displayId + " requester and organization disagree",
  );
  if (request.routingState === "service_selected") {
    assert(request.selectedServiceCandidateId);
  } else {
    assert.equal(request.selectedServiceCandidateId, null);
  }
}
assert(
  seed.requests.filter(
    (request) => request.routingState === "routing_requested",
  ).length >= 3,
);

assert(
  seed.catalogItems.some(
    (item) => item.itemKey === "colorado-azure-landing-zone",
  ),
);
assert(
  seed.catalogItems.some(
    (item) => item.itemKey === "azure-devops-delivery-platform",
  ),
);
assert.equal(catalogSourcesWithoutNewItems(), 50);
for (const domain of riskDomains) {
  assert(
    seed.policyRules.some((rule) => rule.domain === domain),
    "no policy rule covers " + domain,
  );
}

for (const run of seed.inventorySyncRuns) {
  const count = seed.inventorySourceRecords.filter(
    (record) => record.runId === run.id,
  ).length;
  assert.equal(count, run.recordCount, run.fixtureKey + " count differs");
}
assert(seed.inventorySourceRecords.some((record) => record.state === "stale"));
assert(seed.inventorySyncRuns.some((run) => run.status === "failed"));
for (const state of ["open", "resolved", "reopened"]) {
  assert(
    seed.inventoryConflicts.some((conflict) => conflict.state === state),
    "no inventory conflict is " + state,
  );
}
for (const item of seed.catalogItems) {
  assert(
    seed.catalogItemSources.some((source) => source.catalogItemId === item.id),
    item.itemKey + " has no source record",
  );
  assert(
    seed.catalogFieldDecisions.some(
      (decision) => decision.catalogItemId === item.id,
    ),
    item.itemKey + " has no field provenance",
  );
}

const successfulNoMatches = seed.assetAssessments.filter(
  (assessment) =>
    assessment.status === "succeeded" &&
    !seed.assetCandidates.some(
      (candidate) => candidate.assessmentId === assessment.id,
    ),
);
assert(successfulNoMatches.length >= 1);
assert(
  seed.assetAssessments.some((assessment) => assessment.status === "failed"),
);
assert(
  seed.assetCandidateDecisions.some(
    (decision) => decision.decision === "rejected" && Boolean(decision.reason),
  ),
);
assert(
  seed.riskFindings.some((finding) => finding.kind === "missing_information"),
);
assert(
  seed.riskAssessments.some((assessment) => assessment.status === "failed"),
);
assert(
  seed.riskFindingDecisions.some(
    (decision) => decision.decision === "overridden",
  ),
);
assert(
  seed.riskFindingDecisions.some(
    (decision) => decision.decision === "follow_up_required",
  ),
);

const scoredRequestIds = new Set(
  seed.riceScores.map((score) => score.requestId),
);
assert.equal(scoredRequestIds.size, 13);
assert(seed.requests.length - scoredRequestIds.size > scoredRequestIds.size);
assert.equal(
  [...scoredRequestIds].filter(
    (requestId) =>
      seed.riceScores.filter((score) => score.requestId === requestId).length >
      1,
  ).length,
  2,
);
for (const request of seed.requests) {
  if (!request.currentRiceScoreId) continue;
  const score = seed.riceScores.find(
    (candidate) => candidate.id === request.currentRiceScoreId,
  );
  assert.equal(score?.requestId, request.id);
}

// A completed first review satisfied its own checklist: a saved RICE score,
// every area completed, and the reviewed assessments pinned as evidence.
const completedRequests = seed.requests.filter(
  (request) => request.stage === "first_review_completed",
);
assert(completedRequests.length >= 3);
for (const request of completedRequests) {
  assert(
    request.currentRiceScoreId,
    request.displayId + " completed review lacks a RICE score",
  );
  const tasks = seed.reviewTasks.filter(
    (task) => task.requestId === request.id,
  );
  assert.equal(tasks.length, 3);
  for (const task of tasks) {
    assert.equal(
      task.state,
      "completed",
      request.displayId + " has an open " + task.area + " task",
    );
    if (task.area === "assets")
      assert(
        task.completedAssessmentId &&
          assetAssessmentIds.has(task.completedAssessmentId),
        request.displayId + " assets task is not pinned to its assessment",
      );
    if (task.area === "risk")
      assert(
        task.completedAssessmentId &&
          riskAssessmentIds.has(task.completedAssessmentId),
        request.displayId + " risk task is not pinned to its assessment",
      );
  }
  const findings = seed.riskFindings.filter((finding) =>
    seed.riskAssessments.some(
      (assessment) =>
        assessment.id === finding.assessmentId &&
        seed.drafts.some(
          (draft) =>
            draft.id === assessment.draftId &&
            draft.id ===
              seed.requests.find((row) => row.id === request.id)?.sourceDraftId,
        ),
    ),
  );
  for (const finding of findings)
    assert(
      finding.currentDecisionId,
      request.displayId + " completed review left a finding undecided",
    );
}

assert.equal(
  seed.taskCompletions.filter(
    (completion) => completion.taskType === "requester_submission",
  ).length,
  seed.requests.length,
);
assert.equal(
  seed.taskCompletions.filter(
    (completion) => completion.taskType === "contributor_first_review",
  ).length,
  seed.requests.filter((request) => request.stage === "first_review_completed")
    .length,
);
assert(
  seed.taskCompletions.every((completion) => completion.origin === "fixture"),
);
const satisfied = seed.taskCompletions.filter(
  (completion) =>
    completion.taskType === "requester_submission" && completion.rating >= 4,
).length;
const requesterTotal = seed.taskCompletions.filter(
  (completion) => completion.taskType === "requester_submission",
).length;
assert.notEqual((satisfied / requesterTotal) * 100, 90);

const linksByWorkItem = Object.groupBy(
  seed.requestWorkItemLinks,
  (link) => link.workItemId,
);
assert(seed.externalWorkItems.some((item) => !linksByWorkItem[item.id]));
assert(
  Object.values(linksByWorkItem).some((links) => (links?.length ?? 0) > 1),
);
const systemsByRequest = new Map<string, Set<string>>();
const workById = new Map(seed.externalWorkItems.map((item) => [item.id, item]));
for (const link of seed.requestWorkItemLinks) {
  const systems = systemsByRequest.get(link.requestId) ?? new Set<string>();
  const item = workById.get(link.workItemId);
  if (item) systems.add(item.system);
  systemsByRequest.set(link.requestId, systems);
}
assert([...systemsByRequest.values()].some((systems) => systems.size > 1));
assert(seed.workSystems.some((system) => system.syncHealth === "failed"));

for (const request of seed.requests) {
  assert(request.createdAt && request.updatedAt);
  assert(Date.parse(request.createdAt) <= Date.parse(request.updatedAt));
  assert(Date.parse(request.updatedAt) <= Date.parse(SEED_NOW));
}

const deterministicSeedFiles = (await readdir(new URL(".", import.meta.url)))
  .filter((name) => name.endsWith(".ts"))
  .filter((name) => name !== "check.ts");
for (const file of deterministicSeedFiles) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  assert(
    !source.includes("Math." + "random("),
    file + " uses ambient randomness",
  );
  assert(!source.includes("Date." + "now("), file + " uses the ambient clock");
}

console.log(
  [
    "Seed data is valid:",
    "  29 distinct requests and 30 drafts",
    "  12 service offerings and 55 governed catalog items",
    "  108 immutable source records and 12 conflicts",
    "  20 policy rules across 6 domains",
    "  18 external work items with zero/one/many request links",
  ].join("\n"),
);

function ids<T extends { id: string }>(rows: T[]): Set<string> {
  return new Set(rows.map((row) => row.id));
}

function assertUnique(values: string[], label: string): void {
  assert.equal(new Set(values).size, values.length, "duplicate " + label);
}

function catalogSourcesWithoutNewItems(): number {
  const newKeys = new Set([
    "colorado-azure-landing-zone",
    "azure-devops-delivery-platform",
    "application-observability-service",
    "state-container-registry",
    "state-messaging-gateway",
  ]);
  return catalogItems.filter((item) => !newKeys.has(item.key)).length;
}
