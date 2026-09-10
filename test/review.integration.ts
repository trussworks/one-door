// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { collectCorpus } from "../src/models/corpus.ts";
import { withDb } from "../src/workflow/shared.ts";
import {
  askClarification,
  answerClarification,
  assignReview,
  completeFirstReview,
  createVisitor,
  executeHandoff,
  getDeliveryState,
  getReviewState,
  recordAssetOutcome,
  recordRiskOutcome,
  recordRouting,
  resolveRequest,
  saveAssetDecision,
  saveDraft,
  saveRiceScore,
  saveRiskDecision,
  submitRequest,
  updateWorkItemStatus,
  WorkflowError,
  type ActorContext,
  type VisitorContext,
} from "../src/workflow/index.ts";

const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at an isolated database this check may write to.",
    );
  }
  return url;
}

async function runScript(name: string, url: string): Promise<void> {
  const script = fileURLToPath(new URL(`scripts/${name}`, repoRoot));
  await run(process.execPath, ["--experimental-strip-types", script], {
    cwd: fileURLToPath(repoRoot),
    env: { ...process.env, DATABASE_URL: url },
  });
}

async function expectCode(
  code: string,
  action: () => Promise<unknown>,
  label: string,
): Promise<WorkflowError> {
  try {
    await action();
  } catch (error) {
    assert.ok(
      error instanceof WorkflowError,
      `${label}: expected WorkflowError, got ${String(error)}`,
    );
    assert.equal(error.code, code, `${label}: wrong code (${error.message})`);
    return error;
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`);
}

const url = databaseUrl();
process.env.DATABASE_URL = url;
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function submitLiveRequest(visitor: VisitorContext, label: string) {
  const draft = await saveDraft(visitor, {
    organizationId: organization.id,
    rawNeed: `Need for the ${label} journey.`,
    content: {
      title: `Review-slice journey ${label}`,
      problem: "The office needs a reviewed path for this request.",
      affectedPeople: "Office staff",
      acceptanceCriteria: ["The request passes first review"],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready",
  });
  const submitted = await submitRequest(visitor, {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  return { draftId: draft.draftId, requestId: submitted.requestId };
}

async function currentRevisionId(requestId: string): Promise<string> {
  const [row] = await sql.unsafe<{ id: string }[]>(
    `SELECT current_revision_id AS id FROM requests WHERE id = '${requestId}'`,
  );
  assert.ok(row.id, "request has a current revision");
  return row.id;
}

// Approval now compares the stored corpus hash with the current collectCorpus
// hash, so scaffolds record the real current hash at insert time.
async function currentCorpusHash(
  purpose: "asset_match" | "risk_assess",
): Promise<string> {
  return withDb(async (db) => (await collectCorpus(db, purpose)).hash);
}

async function scaffoldAssetAssessment(
  draftId: string,
  revisionId: string,
  status: "succeeded" | "failed",
): Promise<string> {
  const id = randomUUID();
  const error = status === "failed" ? "'scaffolded failure'" : "NULL";
  const hash = await currentCorpusHash("asset_match");
  await sql.unsafe(`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, sanitized_error, origin, revision_id)
    VALUES ('${id}', '${draftId}', '${status}', '${hash}', ${error}, 'live', '${revisionId}')
  `);
  return id;
}

async function scaffoldRiskAssessment(
  draftId: string,
  revisionId: string,
): Promise<string> {
  const id = randomUUID();
  const hash = await currentCorpusHash("risk_assess");
  await sql.unsafe(`
    INSERT INTO risk_assessments
      (id, draft_id, status, policy_corpus_hash, origin, revision_id)
    VALUES ('${id}', '${draftId}', 'succeeded', '${hash}', 'live', '${revisionId}')
  `);
  return id;
}

async function scaffoldCandidate(
  assessmentId: string,
  catalogItemId: string,
  catalogVersion: number,
  rank: number,
): Promise<string> {
  const id = randomUUID();
  await sql.unsafe(`
    INSERT INTO asset_candidates
      (id, assessment_id, catalog_item_id, catalog_version, rank, fit_band,
       coverage, gaps, dependencies, rationale)
    VALUES ('${id}', '${assessmentId}', '${catalogItemId}', ${catalogVersion},
       ${rank}, 'strong', '{}', '{}', '{}', 'scaffolded candidate')
  `);
  return id;
}

async function scaffoldFinding(
  assessmentId: string,
  policyRuleId: string,
): Promise<string> {
  const id = randomUUID();
  await sql.unsafe(`
    INSERT INTO risk_findings
      (id, assessment_id, policy_rule_id, kind, evidence, proposed_severity, rationale)
    VALUES ('${id}', '${assessmentId}', '${policyRuleId}', 'supported_risk',
       'scaffolded evidence', 'moderate', 'scaffolded rationale')
  `);
  return id;
}

const riceFactors = (personaId: string) => ({
  reach: 200,
  reachUnit: "staff",
  reachPeriod: "first year",
  reachRationale: "office headcount",
  reachActorId: personaId,
  impact: 2,
  impactRationale: "removes a manual step",
  impactActorId: personaId,
  confidence: 0.8,
  confidenceRationale: "based on prior rollouts",
  confidenceActorId: personaId,
  effort: 4,
  effortRationale: "one quarter of one team",
  effortActorId: personaId,
});

let organization: { id: string };

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const personas = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' ORDER BY id LIMIT 2`,
  );
  // Live task completions require a visitor id, so the reviewer carries the
  // browser session that drives the demo.
  const reviewerVisitor = await createVisitor();
  const reviewer: ActorContext = {
    actorId: personas[0].id,
    actingView: "contributor",
    visitorId: reviewerVisitor.visitorId,
  };
  const coordinator = personas[1] ?? personas[0];
  const [catalogItem] = await sql.unsafe<
    { id: string; current_version: number }[]
  >(
    `SELECT id, current_version FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     LIMIT 1`,
  );
  assert.ok(catalogItem, "an eligible catalog item exists in the seed");
  const [activeRule] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`,
  );
  assert.ok(activeRule, "an active policy rule exists in the seed");

  // ── 1. R1: evidence gates on the way to approval ─────────────────────────
  const alice = await createVisitor();
  const r1 = await submitLiveRequest(alice, "R1");

  let state = await getReviewState(r1.requestId);
  for (const expected of [
    "ASSET_ASSESSMENT_MISSING",
    "RISK_ASSESSMENT_MISSING",
  ]) {
    assert.ok(
      state.blockers.includes(expected as never),
      `fresh request blocked by ${expected}`,
    );
  }

  assert.ok(
    !state.blockers.includes("RICE_MISSING"),
    "unscored priority does not block first review",
  );

  await expectCode(
    "VALIDATION_FAILED",
    () =>
      completeFirstReview(reviewer, {
        requestId: r1.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
      }),
    "complete without expectedRowVersion",
  );
  let blocked = await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      completeFirstReview(reviewer, {
        requestId: r1.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        expectedRowVersion: state.rowVersion,
      }),
    "complete without evidence",
  );
  assert.match(blocked.detail ?? "", /ASSET_ASSESSMENT_MISSING/);

  const asked = await askClarification(reviewer, {
    requestId: r1.requestId,
    question: "Which office signs off on the data?",
    expectedRowVersion: state.rowVersion,
  });
  state = await getReviewState(r1.requestId);
  blocked = await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      completeFirstReview(reviewer, {
        requestId: r1.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        expectedRowVersion: state.rowVersion,
      }),
    "complete while waiting on the requester",
  );
  assert.match(blocked.detail ?? "", /OPEN_CLARIFICATION/);
  state = await getReviewState(r1.requestId);
  await answerClarification(alice, {
    requestId: r1.requestId,
    expectedRowVersion: state.rowVersion,
    clarificationId: asked.clarificationId,
    answer: "The Budget Office signs off.",
  });

  // Assessments against the now-current revision (the answer's revision).
  const r1Revision = await currentRevisionId(r1.requestId);
  const r1Assets = await scaffoldAssetAssessment(
    r1.draftId,
    r1Revision,
    "succeeded",
  );
  const candidateId = await scaffoldCandidate(
    r1Assets,
    catalogItem.id,
    catalogItem.current_version,
    1,
  );
  const r1Risk = await scaffoldRiskAssessment(r1.draftId, r1Revision);
  const finding1 = await scaffoldFinding(r1Risk, activeRule.id);
  const finding2 = await scaffoldFinding(r1Risk, activeRule.id);

  // ── 2. Assignment and per-area review work ───────────────────────────────
  state = await getReviewState(r1.requestId);
  await expectCode(
    "NOT_FOUND",
    () =>
      assignReview(reviewer, {
        requestId: r1.requestId,
        coordinatorActorId: randomUUID(),
        expectedRowVersion: state.rowVersion,
      }),
    "assign unknown coordinator",
  );
  const assigned = await assignReview(reviewer, {
    requestId: r1.requestId,
    coordinatorActorId: coordinator.id,
    assignments: [{ area: "assets", assigneeActorId: reviewer.actorId }],
    expectedRowVersion: state.rowVersion,
  });
  state = await getReviewState(r1.requestId);
  assert.equal(state.coordinatingActorId, coordinator.id);
  assert.equal(state.tasks.length, 3, "all three review areas exist");
  assert.equal(
    state.tasks.find((task) => task.area === "assets")?.assigneeActorId,
    reviewer.actorId,
  );

  await expectCode(
    "VALIDATION_FAILED",
    () =>
      saveAssetDecision(reviewer, {
        requestId: r1.requestId,
        candidateId,
        decision: "rejected",
        expectedRowVersion: assigned.rowVersion,
      }),
    "rejection without a reason",
  );
  await expectCode(
    "NOT_FOUND",
    () =>
      saveAssetDecision(reviewer, {
        requestId: r1.requestId,
        candidateId: randomUUID(),
        decision: "accepted",
        expectedRowVersion: assigned.rowVersion,
      }),
    "candidate outside the current assessment",
  );
  const accepted = await saveAssetDecision(reviewer, {
    requestId: r1.requestId,
    candidateId,
    decision: "accepted",
    expectedRowVersion: assigned.rowVersion,
  });
  await expectCode(
    "INVALID_STATE",
    () =>
      recordAssetOutcome(reviewer, {
        requestId: r1.requestId,
        outcome: "no_match",
        expectedRowVersion: accepted.rowVersion,
      }),
    "no-match while an accepted candidate stands",
  );
  const assetsDone = await recordAssetOutcome(reviewer, {
    requestId: r1.requestId,
    outcome: "accepted",
    expectedRowVersion: accepted.rowVersion,
  });

  await expectCode(
    "VALIDATION_FAILED",
    () =>
      saveRiskDecision(reviewer, {
        requestId: r1.requestId,
        findingId: finding2,
        decision: "overridden",
        rationale: "severity is lower here",
        expectedRowVersion: assetsDone.rowVersion,
      }),
    "override without a final severity",
  );
  const followUp = await saveRiskDecision(reviewer, {
    requestId: r1.requestId,
    findingId: finding1,
    decision: "follow_up_required",
    rationale: "waiting on the vendor attestation",
    expectedRowVersion: assetsDone.rowVersion,
  });
  const overrode = await saveRiskDecision(reviewer, {
    requestId: r1.requestId,
    findingId: finding2,
    decision: "overridden",
    finalSeverity: "low",
    rationale: "mitigated by the existing contract",
    expectedRowVersion: followUp.rowVersion,
  });
  state = await getReviewState(r1.requestId);
  assert.ok(
    state.blockers.includes("RISK_FOLLOW_UP_OPEN"),
    "open follow-up blocks approval",
  );
  const confirmed = await saveRiskDecision(reviewer, {
    requestId: r1.requestId,
    findingId: finding1,
    decision: "confirmed",
    expectedRowVersion: overrode.rowVersion,
  });
  const [history] = await sql.unsafe<{ total: string; current: string }[]>(`
    SELECT
      (SELECT count(*) FROM risk_finding_decisions WHERE finding_id = '${finding1}')::text AS total,
      (SELECT decision FROM risk_finding_decisions d
        JOIN risk_findings f ON f.current_decision_id = d.id
        WHERE f.id = '${finding1}') AS current
  `);
  assert.equal(Number(history.total), 2, "superseded decision preserved");
  assert.equal(history.current, "confirmed", "pointer moved to the new one");
  state = await getReviewState(r1.requestId);
  assert.equal(
    state.tasks.find((task) => task.area === "risk")?.state,
    "completed",
    "risk area closes when every finding settles",
  );

  await expectCode(
    "VALIDATION_FAILED",
    () =>
      saveRiceScore(reviewer, {
        requestId: r1.requestId,
        ...riceFactors(reviewer.actorId),
        effort: 0,
        expectedRowVersion: confirmed.rowVersion,
      }),
    "zero effort",
  );
  const scored = await saveRiceScore(reviewer, {
    requestId: r1.requestId,
    ...riceFactors(coordinator.id),
    expectedRowVersion: confirmed.rowVersion,
  });
  assert.equal(scored.version, 1);
  assert.equal(scored.score, 80, "200 * 2 * 0.8 / 4");
  const [factorActors] = await sql.unsafe<{ distinct_actor: string }[]>(`
    SELECT DISTINCT reach_actor_id::text AS distinct_actor FROM rice_scores
    WHERE request_id = '${r1.requestId}'
  `);
  assert.equal(
    factorActors.distinct_actor,
    coordinator.id,
    "responsible factor actor recorded",
  );
  state = await getReviewState(r1.requestId);
  assert.deepEqual(
    state.blockers,
    ["NEXT_OWNER_MISSING"],
    "only the next owner remains outstanding",
  );

  // ── 3. Catalog eligibility and the next owner ────────────────────────────
  await sql.unsafe(
    `UPDATE catalog_items SET current_version = current_version + 1
     WHERE id = '${catalogItem.id}'`,
  );
  blocked = await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      completeFirstReview(reviewer, {
        requestId: r1.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        nextOwner: "OIT Application Services",
        expectedRowVersion: state.rowVersion,
      }),
    "complete against a version-stale catalog item",
  );
  assert.match(blocked.detail ?? "", /CATALOG_INELIGIBLE/);
  await sql.unsafe(
    `UPDATE catalog_items SET current_version = ${catalogItem.current_version}
     WHERE id = '${catalogItem.id}'`,
  );

  blocked = await expectCode(
    "APPROVAL_BLOCKED",
    () =>
      completeFirstReview(reviewer, {
        requestId: r1.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        expectedRowVersion: state.rowVersion,
      }),
    "complete without a next owner",
  );
  assert.match(blocked.detail ?? "", /NEXT_OWNER_MISSING/);
  const routed = await recordRouting(reviewer, {
    requestId: r1.requestId,
    nextOwner: "OIT Application Services",
    expectedRowVersion: state.rowVersion,
  });
  state = await getReviewState(r1.requestId);
  assert.deepEqual(state.blockers, [], "no approval blockers remain");

  // ── 4. Completion: once per request, globally, with replay ───────────────
  const keyOne = randomUUID();
  const completed = await completeFirstReview(reviewer, {
    requestId: r1.requestId,
    rating: 4,
    idempotencyKey: keyOne,
    targetSystem: "servicenow",
    workPlan: [
      { title: "Provision the environment", relationship: "required" },
      { title: "Notify the office", relationship: "supporting" },
    ],
    expectedRowVersion: routed.rowVersion,
  });
  assert.equal(completed.stage, "first_review_completed");
  assert.ok(completed.handoffId, "handoff intent recorded with approval");

  const [milestone] = await sql.unsafe<
    { total: string; rating: string; audits: string }[]
  >(`
    SELECT
      (SELECT count(*) FROM task_completions
        WHERE request_id = '${r1.requestId}'
          AND task_type = 'contributor_first_review')::text AS total,
      (SELECT rating FROM task_completions
        WHERE request_id = '${r1.requestId}'
          AND task_type = 'contributor_first_review')::text AS rating,
      (SELECT count(*) FROM audit_events
        WHERE subject_id = '${r1.requestId}'
          AND event_type = 'first_review_completed')::text AS audits
  `);
  assert.deepEqual(
    milestone,
    { total: "1", rating: "4", audits: "1" },
    "milestone, rating, and audit exist exactly once",
  );

  let uniqueCode: string | undefined;
  let uniqueConstraint: string | undefined;
  try {
    await sql.unsafe(`
      INSERT INTO task_completions
        (id, request_id, actor_id, visitor_id, task_type, acting_view, rating,
         origin, idempotency_key)
      VALUES ('${randomUUID()}', '${r1.requestId}', '${coordinator.id}',
        '${reviewerVisitor.visitorId}', 'contributor_first_review',
        'contributor', 5, 'live', '${randomUUID()}')
    `);
  } catch (error) {
    uniqueCode = (error as { code?: string }).code;
    uniqueConstraint = (error as { constraint_name?: string }).constraint_name;
  }
  assert.equal(
    uniqueCode,
    "23505",
    "second milestone rejected by the database",
  );
  assert.equal(uniqueConstraint, "task_completions_once_per_request");

  const replayed = await completeFirstReview(reviewer, {
    requestId: r1.requestId,
    rating: 1,
    idempotencyKey: keyOne,
    targetSystem: "servicenow",
  });
  assert.equal(
    replayed.handoffId,
    completed.handoffId,
    "replay returns intent",
  );
  await expectCode(
    "INVALID_STATE",
    () =>
      completeFirstReview(reviewer, {
        requestId: r1.requestId,
        rating: 5,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
      }),
    "second completion with a new key",
  );

  // ── 5. Post-approval immutability ────────────────────────────────────────
  for (const [label, action] of [
    [
      "asset decision after approval",
      () =>
        saveAssetDecision(reviewer, {
          requestId: r1.requestId,
          candidateId,
          decision: "accepted",
          expectedRowVersion: completed.rowVersion,
        }),
    ],
    [
      "routing after approval",
      () =>
        recordRouting(reviewer, {
          requestId: r1.requestId,
          nextOwner: "Someone else",
          expectedRowVersion: completed.rowVersion,
        }),
    ],
    [
      "clarification after approval",
      () =>
        askClarification(reviewer, {
          requestId: r1.requestId,
          question: "Too late to reopen review",
        }),
    ],
  ] as const) {
    await expectCode("INVALID_STATE", action, label);
  }

  const reprioritized = await saveRiceScore(reviewer, {
    requestId: r1.requestId,
    ...riceFactors(reviewer.actorId),
    expectedRowVersion: completed.rowVersion,
  });
  assert.ok(
    reprioritized.rowVersion > completed.rowVersion,
    "priority remains editable after first review",
  );
  assert.equal(
    (await getReviewState(r1.requestId)).stage,
    "first_review_completed",
    "scoring does not reopen first review",
  );

  // ── 6. Simulated delivery: fail, retry, idempotent confirm ───────────────
  let resolutionError = await expectCode(
    "RESOLUTION_BLOCKED",
    () =>
      resolveRequest(reviewer, {
        requestId: r1.requestId,
        outcome: "fulfilled_mixed",
        summary: "Delivered through the shared platform.",
        expectedRowVersion: reprioritized.rowVersion,
      }),
    "fulfillment before the handoff confirms",
  );
  assert.match(resolutionError.detail ?? "", /HANDOFF_NOT_CONFIRMED/);

  const failedAttempt = await executeHandoff(reviewer, {
    requestId: r1.requestId,
    simulateFailure: true,
  });
  assert.equal(
    failedAttempt.status,
    "failed",
    "failure is durable, not thrown",
  );
  let delivery = await getDeliveryState(r1.requestId);
  assert.equal(delivery.handoff?.status, "failed");
  assert.equal(delivery.handoff?.sanitizedError, "simulated_delivery_failure");

  const confirmedHandoff = await executeHandoff(reviewer, {
    requestId: r1.requestId,
  });
  assert.equal(confirmedHandoff.status, "confirmed");
  assert.equal(
    confirmedHandoff.links.length,
    2,
    "one required, one supporting",
  );
  assert.ok(
    confirmedHandoff.links.every((link) => link.externalId.startsWith("SIM-")),
    "delivery records are locally simulated",
  );
  const again = await executeHandoff(reviewer, { requestId: r1.requestId });
  assert.equal(again.links.length, 2, "retry creates no duplicate records");
  delivery = await getDeliveryState(r1.requestId);
  assert.equal(delivery.handoff?.status, "confirmed");
  assert.equal(delivery.handoff?.sanitizedError, null);

  // ── 7. Work status: simulated and fixture records only ───────────────────
  // Fixture records recover through the same local simulation path; only a
  // record modeling a real import is refused (delivery-lineage section 8
  // covers the refusal and the audit shape).
  const [fixtureItem] = await sql.unsafe<
    { id: string; source_status: string }[]
  >(
    `SELECT id, source_status FROM external_work_items
     WHERE fixture_key IS NOT NULL LIMIT 1`,
  );
  const fixtureRecovered = await updateWorkItemStatus(reviewer, {
    workItemId: fixtureItem.id,
    sourceStatus: fixtureItem.source_status,
  });
  assert.equal(
    fixtureRecovered.workItemId,
    fixtureItem.id,
    "a fixture work item accepts the local simulation path",
  );

  const required = confirmedHandoff.links.find(
    (link) => link.relationship === "required",
  );
  const supporting = confirmedHandoff.links.find(
    (link) => link.relationship === "supporting",
  );
  assert.ok(required && supporting);

  // ── 8. Resolution gates: required work, stale sources, then success ──────
  resolutionError = await expectCode(
    "RESOLUTION_BLOCKED",
    () =>
      resolveRequest(reviewer, {
        requestId: r1.requestId,
        outcome: "fulfilled_mixed",
        summary: "Delivered through the shared platform.",
        expectedRowVersion: reprioritized.rowVersion,
      }),
    "fulfillment while required work is open",
  );
  assert.match(resolutionError.detail ?? "", /REQUIRED_WORK_OPEN/);

  await updateWorkItemStatus(reviewer, {
    workItemId: required.workItemId,
    sourceStatus: "closed",
    closed: true,
    syncHealth: "stale",
  });
  resolutionError = await expectCode(
    "RESOLUTION_BLOCKED",
    () =>
      resolveRequest(reviewer, {
        requestId: r1.requestId,
        outcome: "fulfilled_mixed",
        summary: "Delivered through the shared platform.",
        expectedRowVersion: reprioritized.rowVersion,
      }),
    "fulfillment on stale source data",
  );
  assert.match(resolutionError.detail ?? "", /STALE_SOURCE/);

  await updateWorkItemStatus(reviewer, {
    workItemId: required.workItemId,
    sourceStatus: "closed",
    closed: true,
    syncHealth: "current",
  });
  const resolved = await resolveRequest(reviewer, {
    requestId: r1.requestId,
    outcome: "fulfilled_mixed",
    summary: "Delivered through the shared platform.",
    expectedRowVersion: reprioritized.rowVersion,
  });
  assert.equal(resolved.outcome, "fulfilled_mixed");
  await expectCode(
    "INVALID_STATE",
    () =>
      resolveRequest(reviewer, {
        requestId: r1.requestId,
        outcome: "fulfilled_reuse",
        summary: "Trying to resolve twice.",
        expectedRowVersion: resolved.rowVersion,
      }),
    "second resolution",
  );
  let resolutionUpdate: string | undefined;
  try {
    await sql.unsafe(
      `UPDATE request_resolutions SET summary = 'edited'
       WHERE request_id = '${r1.requestId}'`,
    );
  } catch (error) {
    resolutionUpdate = (error as { code?: string }).code;
  }
  assert.equal(resolutionUpdate, "55000", "resolutions are immutable");

  // ── 9. R2: failed assessment, retired rule, closure without fulfillment ──
  const bella = await createVisitor();
  const r2 = await submitLiveRequest(bella, "R2");
  const r2Revision = await currentRevisionId(r2.requestId);
  await scaffoldAssetAssessment(r2.draftId, r2Revision, "failed");
  const r2Risk = await scaffoldRiskAssessment(r2.draftId, r2Revision);
  const retiredRuleId = randomUUID();
  await sql.unsafe(`
    INSERT INTO policy_rules
      (id, code, version, lifecycle, domain, title, rule, trigger_terms,
       default_severity, citation, content_hash)
    VALUES ('${retiredRuleId}', 'TEST-RETIRED-${retiredRuleId.slice(0, 8)}', 1,
       'retired', 'security', 'Retired probe rule', 'Probe body', '{}',
       'low', 'probe citation', 'probe-hash-${retiredRuleId.slice(0, 8)}')
  `);
  await scaffoldFinding(r2Risk, retiredRuleId);

  state = await getReviewState(r2.requestId);
  for (const expected of ["ASSET_ASSESSMENT_FAILED", "RISK_RULE_RETIRED"]) {
    assert.ok(
      state.blockers.includes(expected as never),
      `R2 blocked by ${expected}`,
    );
  }

  await expectCode(
    "VALIDATION_FAILED",
    () =>
      resolveRequest(reviewer, {
        requestId: r2.requestId,
        outcome: "closed_without_fulfillment",
        summary: "The office withdrew the request.",
        expectedRowVersion: state.rowVersion,
      }),
    "closure without a reason",
  );
  const closed = await resolveRequest(reviewer, {
    requestId: r2.requestId,
    outcome: "closed_without_fulfillment",
    summary: "The office withdrew the request.",
    reason: "The requesting office withdrew before review finished.",
    expectedRowVersion: state.rowVersion,
  });
  assert.equal(closed.outcome, "closed_without_fulfillment");
  await expectCode(
    "INVALID_STATE",
    () =>
      completeFirstReview(reviewer, {
        requestId: r2.requestId,
        rating: 3,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        nextOwner: "Nobody",
        expectedRowVersion: closed.rowVersion,
      }),
    "completion after resolution",
  );

  // ── 10. R3: no-match path, zero work items, concurrent completion ────────
  const carol = await createVisitor();
  const r3 = await submitLiveRequest(carol, "R3");
  const r3Revision = await currentRevisionId(r3.requestId);
  const r3Assets = await scaffoldAssetAssessment(
    r3.draftId,
    r3Revision,
    "succeeded",
  );
  await scaffoldRiskAssessment(r3.draftId, r3Revision);
  assert.ok(r3Assets);

  state = await getReviewState(r3.requestId);
  const noMatch = await recordAssetOutcome(reviewer, {
    requestId: r3.requestId,
    outcome: "no_match",
    expectedRowVersion: state.rowVersion,
  });
  const r3RiskDone = await recordRiskOutcome(reviewer, {
    requestId: r3.requestId,
    expectedRowVersion: noMatch.rowVersion,
  });
  const r3Scored = await saveRiceScore(reviewer, {
    requestId: r3.requestId,
    ...riceFactors(reviewer.actorId),
    expectedRowVersion: r3RiskDone.rowVersion,
  });

  const raceKeys = [randomUUID(), randomUUID()];
  const raceResults = await Promise.allSettled(
    raceKeys.map((key) =>
      completeFirstReview(reviewer, {
        requestId: r3.requestId,
        rating: 5,
        idempotencyKey: key,
        targetSystem: "azure_devops",
        nextOwner: "OIT Platform Team",
        workPlan: [],
        expectedRowVersion: r3Scored.rowVersion,
      }),
    ),
  );
  const wins = raceResults.filter((result) => result.status === "fulfilled");
  const losses = raceResults.filter((result) => result.status === "rejected");
  assert.equal(wins.length, 1, "exactly one concurrent completion wins");
  assert.equal(losses.length, 1);
  const loss = (losses[0] as PromiseRejectedResult).reason as WorkflowError;
  assert.ok(loss instanceof WorkflowError, String(loss));
  assert.equal(loss.code, "INVALID_STATE", "loser gets the stable code");
  const winner = (
    wins[0] as PromiseFulfilledResult<{ handoffId: string | null }>
  ).value;
  const winnerKey =
    raceKeys[raceResults.findIndex((result) => result.status === "fulfilled")];
  const r3Replay = await completeFirstReview(reviewer, {
    requestId: r3.requestId,
    rating: 2,
    idempotencyKey: winnerKey,
    targetSystem: "azure_devops",
  });
  assert.equal(r3Replay.handoffId, winner.handoffId, "race replay by key");
  const [r3Milestones] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM task_completions
     WHERE request_id = '${r3.requestId}'
       AND task_type = 'contributor_first_review'`,
  );
  assert.equal(Number(r3Milestones.total), 1, "race left a single milestone");

  const r3Handoff = await executeHandoff(reviewer, { requestId: r3.requestId });
  assert.equal(r3Handoff.status, "confirmed");
  assert.equal(
    r3Handoff.links.length,
    0,
    "an empty work plan confirms cleanly",
  );
  const r3Resolved = await resolveRequest(reviewer, {
    requestId: r3.requestId,
    outcome: "fulfilled_reuse",
    summary: "Fulfilled with the existing shared service.",
    expectedRowVersion: (await getReviewState(r3.requestId)).rowVersion,
  });
  assert.equal(r3Resolved.outcome, "fulfilled_reuse");

  console.log(
    [
      "Review and delivery slice checks passed:",
      "  approval blocked on evidence, clarifications, follow-ups, retired rules, catalog drift, and missing owner",
      "  decisions and RICE versions append with history and factor actors preserved",
      "  the first-review milestone is globally once per request, replayable by key, and race-safe",
      "  the simulated handoff fails durably, retries, and confirms idempotently with local records only",
      "  resolution enforces required work, stale-source protection, closure reasons, immutability, and terminality",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
