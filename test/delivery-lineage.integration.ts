// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { workItemView } from "../src/server/work-item.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { collectCorpus } from "../src/models/corpus.ts";
import { runWorkerOnce, type ModelProvider } from "../src/models/index.ts";
import {
  completeFirstReview,
  createVisitor,
  executeHandoff,
  getDeliveryState,
  getReviewState,
  linkWorkItem,
  recordAssetOutcome,
  recordRiskOutcome,
  recordRouting,
  resetFixtures,
  resolveRequest,
  saveAssetDecision,
  saveDraft,
  saveRiceScore,
  submitRequest,
  updateWorkItemStatus,
  WorkflowError,
  type ActorContext,
  type VisitorContext,
} from "../src/workflow/index.ts";
import { withDb } from "../src/workflow/shared.ts";
import { defaultWaitThresholds } from "../src/domain/business-days.ts";
import { enrichedRequests } from "../src/server/read-model.ts";
import { requestView } from "../src/server/request-views.ts";

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

async function submitLive(
  visitor: VisitorContext,
  organizationId: string,
  label: string,
) {
  const draft = await saveDraft(visitor, {
    organizationId,
    rawNeed: `Need for the ${label} delivery journey.`,
    content: {
      title: `Delivery lineage ${label} ${randomUUID().slice(0, 8)}`,
      problem: "The office needs traceable delivery work.",
      affectedPeople: "Office staff",
      acceptanceCriteria: ["Delivery lineage holds"],
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

async function scaffoldAssessments(
  draftId: string,
  revisionId: string | null,
  generation = 1,
) {
  const hashes = await withDb(async (db) => ({
    asset: (await collectCorpus(db, "asset_match")).hash,
    risk: (await collectCorpus(db, "risk_assess")).hash,
  }));
  const assetId = randomUUID();
  const riskId = randomUUID();
  const revisionSql = revisionId === null ? "NULL" : `'${revisionId}'`;
  await sql.unsafe(`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin, revision_id, request_generation)
    VALUES ('${assetId}', '${draftId}', 'succeeded', '${hashes.asset}', 'live', ${revisionSql}, ${generation});
    INSERT INTO risk_assessments
      (id, draft_id, status, policy_corpus_hash, origin, revision_id, request_generation)
    VALUES ('${riskId}', '${draftId}', 'succeeded', '${hashes.risk}', 'live', ${revisionSql}, ${generation});
  `);
  return { assetId, riskId };
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

const providerOf = (text: () => string): ModelProvider => ({
  async complete() {
    return { outputText: text(), inputTokens: 900, outputTokens: 400 };
  },
});

async function requestRowVersion(requestId: string): Promise<number> {
  const [row] = await sql.unsafe<{ v: number }[]>(
    `SELECT row_version AS v FROM requests WHERE id = '${requestId}'`,
  );
  return row.v;
}

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [persona] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' ORDER BY id LIMIT 1`,
  );
  const alice = await createVisitor();
  const reviewer: ActorContext = {
    actorId: persona.id,
    actingView: "contributor",
    visitorId: alice.visitorId,
  };

  async function completeReview(
    requestId: string,
    workPlan: Array<{ title: string; relationship: "required" | "supporting" }>,
  ) {
    const outcome = await recordAssetOutcome(reviewer, {
      requestId,
      outcome: "no_match",
      expectedRowVersion: await requestRowVersion(requestId),
    });
    const riskDone = await recordRiskOutcome(reviewer, {
      requestId,
      expectedRowVersion: outcome.rowVersion,
    });
    const scored = await saveRiceScore(reviewer, {
      requestId,
      ...riceFactors(persona.id),
      expectedRowVersion: riskDone.rowVersion,
    });
    const routed = await recordRouting(reviewer, {
      requestId,
      nextOwner: "OIT Application Services",
      expectedRowVersion: scored.rowVersion,
    });
    return completeFirstReview(reviewer, {
      requestId,
      rating: 4,
      idempotencyKey: randomUUID(),
      targetSystem: "servicenow",
      workPlan,
      expectedRowVersion: routed.rowVersion,
    });
  }

  // ── 1. Strong retry identity and link lineage ────────────────────────────
  const dl1 = await submitLive(alice, organization.id, "DL1");
  const [dl1Revision] = await sql.unsafe<{ id: string }[]>(
    `SELECT current_revision_id AS id FROM requests WHERE id = '${dl1.requestId}'`,
  );
  await scaffoldAssessments(dl1.draftId, dl1Revision.id);
  await completeReview(dl1.requestId, [
    { title: "Provision the environment", relationship: "required" },
    { title: "Notify the office", relationship: "supporting" },
  ]);
  const handedOff = await executeHandoff(reviewer, {
    requestId: dl1.requestId,
  });
  assert.equal(handedOff.status, "confirmed");
  const [retryKeyRow] = await sql.unsafe<{ retry_key: string }[]>(
    `SELECT retry_key FROM delivery_handoffs WHERE id = '${handedOff.handoffId}'`,
  );
  for (const [index, link] of handedOff.links.entries()) {
    assert.equal(
      link.externalId,
      `SIM-${retryKeyRow.retry_key}-${index + 1}`,
      "the full retry key is the item identity",
    );
  }
  const linkRows = await sql.unsafe<
    { handoff_id: string | null; request_generation: number }[]
  >(
    `SELECT handoff_id, request_generation FROM request_work_item_links
     WHERE request_id = '${dl1.requestId}'`,
  );
  assert.equal(linkRows.length, 2);
  for (const row of linkRows) {
    assert.equal(row.handoff_id, handedOff.handoffId, "link names its handoff");
    assert.equal(row.request_generation, 1, "link names its generation");
  }
  const retried = await executeHandoff(reviewer, { requestId: dl1.requestId });
  assert.equal(retried.links.length, 2, "retry links no duplicate work");

  // ── 2. Link an existing local item instead of creating one ───────────────
  // A pre-existing local record (not from any handoff); reruns make their
  // own instead of consuming the finite seeded pool.
  const unlinked = { id: randomUUID() };
  await sql.unsafe(`
    INSERT INTO external_work_items
      (id, system, external_id, title, source_status, source_url,
       source_updated_at, last_synchronized_at, sync_health)
    VALUES ('${unlinked.id}', 'servicenow', 'LOCAL-${randomUUID()}',
      'Pre-existing local record', 'open',
      'simulated:servicenow/local', now(), now(), 'current')
  `);
  const linked = await linkWorkItem(reviewer, {
    requestId: dl1.requestId,
    workItemId: unlinked.id,
    relationship: "supporting",
    expectedRowVersion: await requestRowVersion(dl1.requestId),
  });
  assert.equal(linked.workItemId, unlinked.id);
  await expectCode(
    "INVALID_STATE",
    async () =>
      linkWorkItem(reviewer, {
        requestId: dl1.requestId,
        workItemId: unlinked.id,
        relationship: "supporting",
        expectedRowVersion: await requestRowVersion(dl1.requestId),
      }),
    "duplicate link refused",
  );
  await expectCode(
    "NOT_FOUND",
    async () =>
      linkWorkItem(reviewer, {
        requestId: dl1.requestId,
        workItemId: randomUUID(),
        relationship: "supporting",
        expectedRowVersion: await requestRowVersion(dl1.requestId),
      }),
    "unknown work item",
  );
  const delivery = await getDeliveryState(dl1.requestId);
  assert.equal(delivery.links.length, 3, "created and linked items together");
  assert.ok(
    delivery.links.every((link) => typeof link.derivedHealth === "string"),
    "every link carries derived health",
  );

  // ── 3. Resolution honors derived freshness, not the stored flag ──────────
  const required = handedOff.links.find(
    (link) => link.relationship === "required",
  );
  const supporting = handedOff.links.find(
    (link) => link.relationship === "supporting",
  );
  assert.ok(required && supporting);
  await updateWorkItemStatus(reviewer, {
    workItemId: required.workItemId,
    sourceStatus: "closed",
    closed: true,
    syncHealth: "current",
  });
  await updateWorkItemStatus(reviewer, {
    workItemId: supporting.workItemId,
    sourceStatus: "closed",
    closed: true,
    syncHealth: "current",
  });
  // The stored flag stays 'current'; only the synchronization time ages.
  await sql.unsafe(`
    UPDATE external_work_items
    SET last_synchronized_at = now() - interval '100 hours'
    WHERE id = '${required.workItemId}'
  `);
  const staleBlocked = await expectCode(
    "RESOLUTION_BLOCKED",
    async () =>
      resolveRequest(reviewer, {
        requestId: dl1.requestId,
        outcome: "fulfilled_new",
        summary: "Delivered through new work.",
        expectedRowVersion: await requestRowVersion(dl1.requestId),
      }),
    "fulfillment on an expired freshness interval",
  );
  assert.match(staleBlocked.detail ?? "", /STALE_SOURCE/);
  let [dl1Row] = await enrichedRequests(defaultWaitThresholds, [dl1.requestId]);
  assert.equal(dl1Row.attention.blockedDelivery, true, "stale source surfaces");
  assert.equal(
    dl1Row.actionNeeded,
    "monitor_delivery",
    "record-outcome is withheld on expired data",
  );
  await updateWorkItemStatus(reviewer, {
    workItemId: required.workItemId,
    sourceStatus: "closed",
    closed: true,
    syncHealth: "current",
  });
  const resolved = await resolveRequest(reviewer, {
    requestId: dl1.requestId,
    outcome: "fulfilled_new",
    summary: "Delivered through new work.",
    expectedRowVersion: await requestRowVersion(dl1.requestId),
  });
  assert.equal(resolved.outcome, "fulfilled_new");
  [dl1Row] = await enrichedRequests(defaultWaitThresholds, [dl1.requestId]);
  assert.equal(dl1Row.phase, "resolved");

  // ── 4. A reset turns the prior generation's links into history ───────────
  const [fixture] = await sql.unsafe<
    {
      id: string;
      source_draft_id: string;
      fixture_generation: number;
    }[]
  >(`
    SELECT r.id, r.source_draft_id, r.fixture_generation
    FROM requests r
    WHERE r.fixture_key IS NOT NULL AND r.stage = 'under_review'
      AND NOT EXISTS (
        SELECT 1 FROM clarification_requests c
        WHERE c.request_id = r.id AND c.answered_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM request_work_item_links l
        WHERE l.request_id = r.id AND l.fixture_key IS NOT NULL
      )
    ORDER BY r.display_id LIMIT 1
  `);
  assert.ok(fixture, "a clean under-review fixture exists");
  await scaffoldAssessments(
    fixture.source_draft_id,
    null,
    fixture.fixture_generation,
  );
  await completeReview(fixture.id, [
    { title: "Provision the fixture environment", relationship: "required" },
  ]);
  const baselineRows = await sql.unsafe<{ work_item_id: string }[]>(`
    SELECT work_item_id FROM request_work_item_links
    WHERE request_id = '${fixture.id}' AND fixture_key IS NOT NULL
  `);
  const baselineIds = baselineRows.map((row) => row.work_item_id).sort();

  const fixtureHandoff = await executeHandoff(reviewer, {
    requestId: fixture.id,
  });
  assert.equal(fixtureHandoff.status, "confirmed");
  assert.equal(
    fixtureHandoff.links.length,
    baselineIds.length + 1,
    "current links: the created item plus the baseline links",
  );

  await resetFixtures(reviewer);
  const [postReset] = await sql.unsafe<{ g: number }[]>(
    `SELECT fixture_generation AS g FROM requests WHERE id = '${fixture.id}'`,
  );
  assert.equal(postReset.g, fixture.fixture_generation + 1);
  // The reset restores each fixture item's authored health, and some items
  // are authored stale on purpose. Normalize the picked baseline items to
  // healthy so only the link boundary is under test; the next reset restores
  // the authored values.
  await sql.unsafe(`
    UPDATE external_work_items
    SET last_synchronized_at = now(), sync_health = 'current'
    WHERE id IN (
      SELECT work_item_id FROM request_work_item_links
      WHERE request_id = '${fixture.id}' AND fixture_key IS NOT NULL
    )
  `);
  const fixtureDelivery = await getDeliveryState(fixture.id);
  for (const baselineId of baselineIds) {
    const view = await workItemView(baselineId);
    assert.ok(
      view.requests.some((request) => request.requestId === fixture.id),
    );
    assert.equal(view.item.derivedHealth, "current");
  }
  for (const link of fixtureDelivery.historicalLinks) {
    const view = await workItemView(link.workItemId);
    assert.ok(
      !view.requests.some((request) => request.requestId === fixture.id),
    );
    assert.ok(
      view.historicalRequests.some(
        (request) => request.requestId === fixture.id,
      ),
    );
  }
  assert.deepEqual(
    fixtureDelivery.links.map((link) => link.workItemId).sort(),
    baselineIds,
    "baseline fixture links stay current; participant links become history",
  );
  assert.ok(
    fixtureDelivery.historicalLinks.some(
      (link) =>
        link.handoffId === fixtureHandoff.handoffId &&
        link.requestGeneration === fixture.fixture_generation,
    ),
    "the old link survives as history with its lineage",
  );
  assert.ok(
    fixtureDelivery.historicalLinks.every(
      (link) => !baselineIds.includes(link.workItemId),
    ),
    "baseline links never appear as history",
  );
  const [fixtureRow] = await enrichedRequests(defaultWaitThresholds, [
    fixture.id,
  ]);
  assert.deepEqual(
    fixtureRow.workLinks.map((link) => link.workItemId).sort(),
    baselineIds,
    "the read model shows the baseline links only",
  );
  assert.equal(
    fixtureRow.attention.blockedDelivery,
    false,
    "current baseline links raise no delivery attention",
  );
  // Resolution reads the same boundary: the prior generation's open required
  // link does not block, and the baseline delivery_work link never does.
  const postResetBlocked = await expectCode(
    "RESOLUTION_BLOCKED",
    async () =>
      resolveRequest(reviewer, {
        requestId: fixture.id,
        outcome: "fulfilled_new",
        summary: "Probe: link boundary at resolution.",
        expectedRowVersion: await requestRowVersion(fixture.id),
      }),
    "fulfillment straight after a reset",
  );
  assert.match(postResetBlocked.detail ?? "", /NOT_COMPLETED/);
  assert.ok(
    !(postResetBlocked.detail ?? "").includes("REQUIRED_WORK_OPEN"),
    "the old generation's open required link does not block resolution",
  );

  // ── 5. A late result never alters a closed review's evidence ────────────────────
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded' WHERE status = 'queued'`,
  );
  const rl = await submitLive(alice, organization.id, "RL");
  const [rlRevision] = await sql.unsafe<{ id: string }[]>(
    `SELECT current_revision_id AS id FROM requests WHERE id = '${rl.requestId}'`,
  );
  const rlScaffold = await scaffoldAssessments(rl.draftId, rlRevision.id);
  const [reviewedItem] = await sql.unsafe<
    { id: string; current_version: number }[]
  >(
    `SELECT id, current_version FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     LIMIT 1`,
  );
  const rlCandidate = randomUUID();
  await sql.unsafe(`
    INSERT INTO asset_candidates
      (id, assessment_id, catalog_item_id, catalog_version, rank, fit_band,
       coverage, gaps, dependencies, rationale)
    VALUES ('${rlCandidate}', '${rlScaffold.assetId}', '${reviewedItem.id}',
       ${reviewedItem.current_version}, 1, 'strong', '{}', '{}', '{}',
       'the reviewed proposal')
  `);
  // The asset job is claimed and dispatched; while the provider "runs", the
  // review completes on the scaffolded evidence. The settlement then lands
  // after the review closed and must not become current.
  const provider: ModelProvider = {
    complete: async () => {
      const review0 = await getReviewState(rl.requestId);
      const accepted = await saveAssetDecision(reviewer, {
        requestId: rl.requestId,
        candidateId: rlCandidate,
        decision: "accepted",
        expectedRowVersion: review0.rowVersion,
      });
      const assetsDone = await recordAssetOutcome(reviewer, {
        requestId: rl.requestId,
        outcome: "accepted",
        expectedRowVersion: accepted.rowVersion,
      });
      const riskDone = await recordRiskOutcome(reviewer, {
        requestId: rl.requestId,
        expectedRowVersion: assetsDone.rowVersion,
      });
      const scored = await saveRiceScore(reviewer, {
        requestId: rl.requestId,
        ...riceFactors(persona.id),
        expectedRowVersion: riskDone.rowVersion,
      });
      const routed = await recordRouting(reviewer, {
        requestId: rl.requestId,
        nextOwner: "OIT Application Services",
        expectedRowVersion: scored.rowVersion,
      });
      await completeFirstReview(reviewer, {
        requestId: rl.requestId,
        rating: 4,
        idempotencyKey: randomUUID(),
        targetSystem: "servicenow",
        workPlan: [],
        expectedRowVersion: routed.rowVersion,
      });
      return {
        outputText: JSON.stringify({
          candidates: [
            {
              catalogItemId: reviewedItem.id,
              fitBand: "weak",
              coverage: ["A different late proposal"],
              gaps: [],
              dependencies: [],
              rationale: "the late unreviewed proposal",
            },
          ],
        }),
        inputTokens: 900,
        outputTokens: 400,
      };
    },
  };
  const lateRun = await runWorkerOnce({ provider });
  assert.equal(
    lateRun?.outcome,
    "superseded",
    "a result landing after closure never becomes current",
  );
  const state = await getReviewState(rl.requestId);
  assert.equal(state.stage, "first_review_completed", "review stays closed");
  for (const area of ["assets", "risk", "rice"] as const)
    assert.equal(
      state.tasks.find((task) => task.area === area)?.state,
      "completed",
      `the ${area} task keeps its completion`,
    );
  const [evidence] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM asset_assessments
     WHERE draft_id = '${rl.draftId}'`,
  );
  assert.equal(evidence.total, 1, "no new assessment materializes");
  const view = await requestView(alice, rl.requestId, true);
  assert.equal(
    view.assetAssessment?.id,
    rlScaffold.assetId,
    "the API still presents the reviewed assessment",
  );
  assert.equal(
    view.riskAssessment?.id,
    rlScaffold.riskId,
    "the reviewed risk assessment stays current",
  );
  assert.equal(view.candidates.length, 1, "the reviewed candidates remain");
  assert.equal(view.candidates[0].id, rlCandidate);
  assert.equal(view.candidates[0].decision, "accepted");
  const [receipt] = await sql.unsafe<
    { cost: string | null; output: string | null }[]
  >(`
    SELECT actual_cost_micros::text AS cost,
      (validated_output IS NOT NULL)::text AS output
    FROM model_calls
    WHERE id = (SELECT current_model_call_id FROM model_jobs
      WHERE id = '${lateRun?.jobId}')
  `);
  assert.ok(receipt.cost !== null, "the call's actual cost is recorded");
  assert.equal(receipt.output, "true", "the validated output stays a receipt");

  // The still-queued risk preparation never dispatches after closure.
  const [callsBeforeIdle] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM model_calls`,
  );
  const idleRun = await runWorkerOnce({
    provider: providerOf(() => {
      throw new Error("closed review must not dispatch preparation");
    }),
  });
  assert.equal(
    idleRun?.outcome,
    "superseded",
    "queued preparation settles superseded without dispatch",
  );
  const [callsAfterIdle] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM model_calls`,
  );
  assert.equal(
    callsAfterIdle.total,
    callsBeforeIdle.total,
    "no provider call and no ledger row for undispatched work",
  );
  const [riskEvidence] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM risk_assessments
     WHERE draft_id = '${rl.draftId}'`,
  );
  assert.equal(riskEvidence.total, 1, "no failed risk assessment appears");

  // ── 6. A confirmed handoff with zero required tickets records its outcome ──
  const zt = await submitLive(alice, organization.id, "ZT");
  const [ztRevision] = await sql.unsafe<{ id: string }[]>(
    `SELECT current_revision_id AS id FROM requests WHERE id = '${zt.requestId}'`,
  );
  await scaffoldAssessments(zt.draftId, ztRevision.id);
  await completeReview(zt.requestId, []);
  const ztHandoff = await executeHandoff(reviewer, { requestId: zt.requestId });
  assert.equal(ztHandoff.status, "confirmed");
  assert.equal(ztHandoff.links.length, 0, "the plan carries no tickets");
  let [ztRow] = await enrichedRequests(defaultWaitThresholds, [zt.requestId]);
  assert.equal(ztRow.phase, "delivery");
  assert.equal(
    ztRow.actionNeeded,
    "record_outcome",
    "fulfillment without a ticket is recordable, not monitored forever",
  );
  const ztResolved = await resolveRequest(reviewer, {
    requestId: zt.requestId,
    outcome: "fulfilled_new",
    summary: "Delivered without external tickets.",
    expectedRowVersion: await requestRowVersion(zt.requestId),
  });
  assert.equal(ztResolved.outcome, "fulfilled_new");
  [ztRow] = await enrichedRequests(defaultWaitThresholds, [zt.requestId]);
  assert.equal(ztRow.phase, "resolved");

  // ── 7. A scope change starts a linked follow-up; the parent never moves ──
  const [parentBefore] = await sql.unsafe<
    { row_version: number; stage: string; updated_at: string }[]
  >(
    `SELECT row_version, stage, updated_at FROM requests
     WHERE id = '${zt.requestId}'`,
  );
  const [parentSurveys] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM task_completions
     WHERE request_id = '${zt.requestId}'`,
  );

  const open = await submitLive(alice, organization.id, "FU-open");
  await expectCode(
    "INVALID_STATE",
    () =>
      saveDraft(alice, {
        organizationId: organization.id,
        rawNeed: "Follow-up on an unfinished parent.",
        parentRequestId: open.requestId,
      }),
    "a parent that is not past first review",
  );
  await expectCode(
    "NOT_FOUND",
    () =>
      saveDraft(alice, {
        organizationId: organization.id,
        rawNeed: "Follow-up on nothing.",
        parentRequestId: randomUUID(),
      }),
    "an unknown parent",
  );
  const stranger = await createVisitor();
  await expectCode(
    "NOT_OWNER",
    () =>
      saveDraft(stranger, {
        organizationId: organization.id,
        rawNeed: "Follow-up on someone else's work.",
        parentRequestId: zt.requestId,
      }),
    "another visitor's parent",
  );

  const followKey = `follow-${randomUUID()}`;
  const followCreation = {
    organizationId: organization.id,
    rawNeed: "The delivered change needs one more office added.",
    content: {
      title: `Follow-up scope ${randomUUID().slice(0, 8)}`,
      problem: "The delivered change must cover one more office.",
      affectedPeople: "Office staff",
      acceptanceCriteria: ["The added office is covered"],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready" as const,
    parentRequestId: zt.requestId,
    creationKey: followKey,
  };
  const followUp = await saveDraft(alice, followCreation);
  assert.equal(followUp.parentRequestId, zt.requestId);
  const followReplay = await saveDraft(alice, followCreation);
  assert.equal(followReplay.draftId, followUp.draftId, "creation replays");
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      saveDraft(alice, { ...followCreation, parentRequestId: dl1.requestId }),
    "the same creation key with a different parent",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      saveDraft(alice, {
        draftId: followUp.draftId,
        parentRequestId: dl1.requestId,
        expectedRowVersion: followUp.rowVersion,
      }),
    "changing the parent after creation",
  );

  let parentView = await requestView(alice, zt.requestId, true);
  assert.equal(
    parentView.followUps.length,
    0,
    "an unsubmitted follow-up draft is invisible on the parent",
  );

  const followSubmitted = await submitRequest(alice, {
    draftId: followUp.draftId,
    expectedRowVersion: followUp.rowVersion,
    rating: 4,
    idempotencyKey: randomUUID(),
  });
  parentView = await requestView(alice, zt.requestId, true);
  assert.deepEqual(
    parentView.followUps.map((row) => row.requestId),
    [followSubmitted.requestId],
    "the submitted follow-up appears on the parent",
  );
  const childView = await requestView(alice, followSubmitted.requestId, true);
  assert.equal(childView.parentRequest?.requestId, zt.requestId);
  assert.equal(childView.parentRequest?.stage, "first_review_completed");
  assert.equal(childView.status?.phase, "received", "the child starts fresh");
  assert.equal(parentView.status?.phase, "resolved", "the parent stays done");

  const [parentAfter] = await sql.unsafe<
    { row_version: number; stage: string; updated_at: string }[]
  >(
    `SELECT row_version, stage, updated_at FROM requests
     WHERE id = '${zt.requestId}'`,
  );
  assert.deepEqual(
    parentAfter,
    parentBefore,
    "the follow-up journey never writes the parent request",
  );
  const [parentSurveysAfter] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM task_completions
     WHERE request_id = '${zt.requestId}'`,
  );
  assert.equal(
    parentSurveysAfter.total,
    parentSurveys.total,
    "the parent's surveys are not repeated",
  );
  const [childSurvey] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM task_completions
     WHERE request_id = '${followSubmitted.requestId}'
       AND task_type = 'requester_submission'`,
  );
  assert.equal(childSurvey.total, 1, "the child carries its own survey");

  // ── 8. Fixture records recover through the local simulation path ─────────
  const [fixtureItem] = await sql.unsafe<
    { id: string; sync_health: string; source_status: string }[]
  >(`
    SELECT id, sync_health, source_status FROM external_work_items
    WHERE fixture_key = 'external-work-item:legal-hold-configuration'
  `);
  assert.ok(fixtureItem, "the authored-stale fixture item exists");
  const [auditBefore] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM audit_events
     WHERE subject_id = '${fixtureItem.id}'
       AND event_type = 'work_item_status_updated'`,
  );
  const recovered = await updateWorkItemStatus(reviewer, {
    workItemId: fixtureItem.id,
    sourceStatus: "In progress",
    syncHealth: "current",
  });
  assert.equal(recovered.workItemId, fixtureItem.id);
  const [afterUpdate] = await sql.unsafe<
    {
      sync_health: string;
      source_status: string;
      fresh: boolean;
      consistent: boolean;
    }[]
  >(`
    SELECT sync_health, source_status,
      (now() - last_synchronized_at) < interval '1 minute' AS fresh,
      source_updated_at = last_synchronized_at AS consistent
    FROM external_work_items WHERE id = '${fixtureItem.id}'
  `);
  assert.equal(afterUpdate.sync_health, "current", "health refreshed");
  assert.equal(afterUpdate.source_status, "In progress");
  assert.equal(afterUpdate.fresh, true, "synchronization time moves with it");
  assert.equal(afterUpdate.consistent, true, "status and sync metadata agree");
  const [auditRow] = await sql.unsafe<
    {
      subject_type: string;
      actor_id: string;
      payload: { sourceStatus?: string };
    }[]
  >(`
    SELECT subject_type, actor_id, payload FROM audit_events
    WHERE subject_id = '${fixtureItem.id}'
      AND event_type = 'work_item_status_updated'
    ORDER BY created_at DESC LIMIT 1
  `);
  assert.equal(auditRow.subject_type, "work_item", "audit names its subject");
  assert.equal(auditRow.actor_id, reviewer.actorId, "attribution recorded");
  assert.equal(auditRow.payload.sourceStatus, "In progress");

  const [closedFixture] = await sql.unsafe<
    { id: string; source_status: string; closed_at: string }[]
  >(`
    SELECT id, source_status, closed_at FROM external_work_items
    WHERE fixture_key IS NOT NULL AND id <> '${fixtureItem.id}' LIMIT 1
  `);
  assert.ok(closedFixture);
  await updateWorkItemStatus(reviewer, {
    workItemId: closedFixture.id,
    sourceStatus: "Closed",
    closed: true,
    syncHealth: "current",
  });
  const [firstClosure] = await sql.unsafe(
    `SELECT closed_at FROM external_work_items WHERE id='${closedFixture.id}'`,
  );
  await updateWorkItemStatus(reviewer, {
    workItemId: closedFixture.id,
    sourceStatus: closedFixture.source_status,
    closed: true,
    syncHealth: "current",
  });
  const [beforeFailure] = await sql.unsafe(
    `SELECT source_status, closed_at, source_updated_at, last_synchronized_at FROM external_work_items WHERE id='${closedFixture.id}'`,
  );
  assert.equal(
    Date.parse(beforeFailure.closed_at),
    Date.parse(firstClosure.closed_at),
    "a repeated closure preserves the original closure time",
  );
  await updateWorkItemStatus(reviewer, {
    workItemId: closedFixture.id,
    sourceStatus: "Unverified changed value",
    closed: false,
    syncHealth: "failed",
  });
  const [afterFailure] = await sql.unsafe(
    `SELECT source_status, closed_at, source_updated_at, last_synchronized_at FROM external_work_items WHERE id='${closedFixture.id}'`,
  );
  assert.deepEqual(
    afterFailure,
    beforeFailure,
    "a failed source check retains all last-known data and success timestamps",
  );

  // A record that models a real import stays refused; nothing leaves the
  // database — the whole path is these two tables, no network client.
  const importedId = randomUUID();
  await sql.unsafe(`
    INSERT INTO external_work_items
      (id, system, external_id, title, source_status, source_owner,
       source_url, source_updated_at, last_synchronized_at, sync_health)
    VALUES ('${importedId}', 'servicenow', 'EXT-${randomUUID().slice(0, 8)}',
      'Imported record', 'New', 'Real Office',
      'https://tenant.example/EXT', now(), now(), 'current')
  `);
  await expectCode(
    "INVALID_STATE",
    () =>
      updateWorkItemStatus(reviewer, {
        workItemId: importedId,
        sourceStatus: "In progress",
      }),
    "an imported record never accepts a simulated update",
  );

  // Reset restores the authored fixture state and keeps the live evidence.
  await resetFixtures(reviewer);
  const [restored] = await sql.unsafe<{ sync_health: string }[]>(
    `SELECT sync_health FROM external_work_items WHERE id = '${fixtureItem.id}'`,
  );
  // The authored definition (src/seed/work-items.ts) marks this item stale
  // on purpose; earlier sections may have normalized it, so compare against
  // the authored value, not the section-start snapshot.
  assert.equal(
    restored.sync_health,
    "stale",
    "reset restores the authored health",
  );
  const [auditAfterReset] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM audit_events
     WHERE subject_id = '${fixtureItem.id}'
       AND event_type = 'work_item_status_updated'`,
  );
  assert.equal(
    auditAfterReset.total,
    auditBefore.total + 1,
    "the recovery audit survives the reset",
  );

  // ── 9. Structured delivery owner and task ────────────────────────────────
  const [personaName] = await sql.unsafe<{ display_name: string }[]>(
    `SELECT display_name FROM actors WHERE id = '${persona.id}'`,
  );
  const longTask =
    "Coordinate the environment build-out and confirm every dependency " +
    "owner before launch. ".repeat(16).trim();
  assert.ok(longTask.length > 300, "the task exceeds the old free-text limit");
  const dl9 = await submitLive(alice, organization.id, "DL9");
  const [dl9Revision] = await sql.unsafe<{ id: string }[]>(
    `SELECT current_revision_id AS id FROM requests WHERE id = '${dl9.requestId}'`,
  );
  await scaffoldAssessments(dl9.draftId, dl9Revision.id);
  const outcome9 = await recordAssetOutcome(reviewer, {
    requestId: dl9.requestId,
    outcome: "no_match",
    expectedRowVersion: await requestRowVersion(dl9.requestId),
  });
  const risk9 = await recordRiskOutcome(reviewer, {
    requestId: dl9.requestId,
    expectedRowVersion: outcome9.rowVersion,
  });
  const scored9 = await saveRiceScore(reviewer, {
    requestId: dl9.requestId,
    ...riceFactors(persona.id),
    expectedRowVersion: risk9.rowVersion,
  });
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      recordRouting(reviewer, {
        requestId: dl9.requestId,
        nextOwner: "Legacy text",
        deliveryOwnerActorId: persona.id,
        nextTask: longTask,
        expectedRowVersion: scored9.rowVersion,
      }),
    "mixed legacy and structured input is contradictory",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      recordRouting(reviewer, {
        requestId: dl9.requestId,
        nextTask: longTask,
        expectedRowVersion: scored9.rowVersion,
      }),
    "half a pair is refused",
  );
  await expectCode(
    "NOT_FOUND",
    () =>
      recordRouting(reviewer, {
        requestId: dl9.requestId,
        deliveryOwnerActorId: randomUUID(),
        nextTask: longTask,
        expectedRowVersion: scored9.rowVersion,
      }),
    "an unknown owner actor is refused",
  );
  const [systemActor] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'system' LIMIT 1`,
  );
  assert.ok(systemActor, "a seeded system actor exists");
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      recordRouting(reviewer, {
        requestId: dl9.requestId,
        deliveryOwnerActorId: systemActor.id,
        nextTask: longTask,
        expectedRowVersion: scored9.rowVersion,
      }),
    "a system actor cannot own delivery",
  );
  const routed9 = await recordRouting(reviewer, {
    requestId: dl9.requestId,
    deliveryOwnerActorId: persona.id,
    nextTask: longTask,
    expectedRowVersion: scored9.rowVersion,
  });
  const [structured] = await sql.unsafe<
    { owner: string; task: string; legacy: string }[]
  >(
    `SELECT delivery_owner_actor_id AS owner, next_task AS task,
       next_owner AS legacy
     FROM requests WHERE id = '${dl9.requestId}'`,
  );
  assert.equal(structured.owner, persona.id);
  assert.equal(structured.task, longTask);
  assert.equal(
    structured.legacy,
    personaName.display_name + ": " + longTask,
    "the legacy string is composed with the full task",
  );
  const state9 = await getReviewState(dl9.requestId);
  assert.equal(state9.deliveryOwnerActorId, persona.id);
  assert.equal(state9.deliveryOwnerName, personaName.display_name);
  assert.equal(state9.nextTask, longTask);

  // Completion without owner input reuses the stored pair, and the handoff
  // snapshot carries the full task with no truncation.
  await completeFirstReview(reviewer, {
    requestId: dl9.requestId,
    rating: 4,
    idempotencyKey: randomUUID(),
    targetSystem: "servicenow",
    workPlan: [],
    expectedRowVersion: routed9.rowVersion,
  });
  const [handoff9] = await sql.unsafe<{ next_owner: string }[]>(
    `SELECT next_owner FROM delivery_handoffs
     WHERE request_id = '${dl9.requestId}'`,
  );
  assert.equal(
    handoff9.next_owner,
    personaName.display_name + ": " + longTask,
    "the handoff snapshot keeps the whole task",
  );

  // A legacy write clears the structured pair.
  const dl10 = await submitLive(alice, organization.id, "DL10");
  const [dl10Revision] = await sql.unsafe<{ id: string }[]>(
    `SELECT current_revision_id AS id FROM requests WHERE id = '${dl10.requestId}'`,
  );
  await scaffoldAssessments(dl10.draftId, dl10Revision.id);
  const routedPair = await recordRouting(reviewer, {
    requestId: dl10.requestId,
    deliveryOwnerActorId: persona.id,
    nextTask: "Confirm the initial owner.",
    expectedRowVersion: await requestRowVersion(dl10.requestId),
  });
  await recordRouting(reviewer, {
    requestId: dl10.requestId,
    nextOwner: "OIT Application Services",
    expectedRowVersion: routedPair.rowVersion,
  });
  const [cleared] = await sql.unsafe<
    { owner: string | null; task: string | null; legacy: string }[]
  >(
    `SELECT delivery_owner_actor_id AS owner, next_task AS task,
       next_owner AS legacy
     FROM requests WHERE id = '${dl10.requestId}'`,
  );
  assert.equal(cleared.owner, null, "legacy write clears the owner actor");
  assert.equal(cleared.task, null, "legacy write clears the task");
  assert.equal(cleared.legacy, "OIT Application Services");

  // The immutable audit trail keeps both plans: each routing write records
  // what it replaced and what it set, with the writer attributed.
  type OwnerSnapshot = {
    nextOwner: string | null;
    deliveryOwnerActorId: string | null;
    nextTask: string | null;
  };
  const routingAudits = await sql.unsafe<
    {
      actor_id: string;
      payload: {
        hasNextOwner: boolean;
        previous: OwnerSnapshot;
        recorded: OwnerSnapshot;
      };
    }[]
  >(
    `SELECT actor_id, payload FROM audit_events
     WHERE subject_id = '${dl10.requestId}'
       AND event_type = 'human_routing_recorded'`,
  );
  assert.equal(routingAudits.length, 2, "both routing writes leave events");
  for (const event of routingAudits) {
    assert.equal(event.actor_id, persona.id, "the writer is attributed");
    assert.equal(event.payload.hasNextOwner, true, "old shape survives");
  }
  const pairWrite = routingAudits.find(
    (event) => event.payload.previous.nextOwner === null,
  );
  const legacyWrite = routingAudits.find(
    (event) => event.payload.previous.nextOwner !== null,
  );
  assert.ok(pairWrite && legacyWrite, "one write of each kind is recorded");
  assert.deepEqual(pairWrite.payload.recorded, {
    nextOwner: personaName.display_name + ": Confirm the initial owner.",
    deliveryOwnerActorId: persona.id,
    nextTask: "Confirm the initial owner.",
  });
  assert.deepEqual(
    legacyWrite.payload.previous,
    pairWrite.payload.recorded,
    "the second write preserves the first recorded plan",
  );
  assert.deepEqual(legacyWrite.payload.recorded, {
    nextOwner: "OIT Application Services",
    deliveryOwnerActorId: null,
    nextTask: null,
  });

  // Completed-review fixtures carry a seeded structured pair; no other fixture
  // gains one until an explicit write, and the legacy write above left none.
  const [untouched] = await sql.unsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM requests
     WHERE fixture_key IS NOT NULL AND delivery_owner_actor_id IS NOT NULL
       AND stage <> 'first_review_completed'`,
  );
  assert.equal(untouched.count, 0, "no other fixture gained a structured pair");

  // ── 10. A reset restores all three owner fields and keeps the handoff ────
  const [fx10] = await sql.unsafe<
    {
      id: string;
      source_draft_id: string;
      fixture_generation: number;
      next_owner: string | null;
    }[]
  >(`
    SELECT r.id, r.source_draft_id, r.fixture_generation, r.next_owner
    FROM requests r
    WHERE r.fixture_key IS NOT NULL AND r.stage = 'under_review'
      AND NOT EXISTS (
        SELECT 1 FROM clarification_requests c
        WHERE c.request_id = r.id AND c.answered_at IS NULL
      )
    ORDER BY r.display_id DESC LIMIT 1
  `);
  assert.ok(fx10, "a clean under-review fixture exists");
  await scaffoldAssessments(
    fx10.source_draft_id,
    null,
    fx10.fixture_generation,
  );
  const outcome10 = await recordAssetOutcome(reviewer, {
    requestId: fx10.id,
    outcome: "no_match",
    expectedRowVersion: await requestRowVersion(fx10.id),
  });
  const risk10 = await recordRiskOutcome(reviewer, {
    requestId: fx10.id,
    expectedRowVersion: outcome10.rowVersion,
  });
  const scored10 = await saveRiceScore(reviewer, {
    requestId: fx10.id,
    ...riceFactors(persona.id),
    expectedRowVersion: risk10.rowVersion,
  });
  const routed10 = await recordRouting(reviewer, {
    requestId: fx10.id,
    deliveryOwnerActorId: persona.id,
    nextTask: "Stand up the fixture environment before the pilot.",
    expectedRowVersion: scored10.rowVersion,
  });
  await completeFirstReview(reviewer, {
    requestId: fx10.id,
    rating: 4,
    idempotencyKey: randomUUID(),
    targetSystem: "servicenow",
    workPlan: [],
    expectedRowVersion: routed10.rowVersion,
  });
  const confirmed10 = await executeHandoff(reviewer, { requestId: fx10.id });
  assert.equal(confirmed10.status, "confirmed");
  const [handoff10] = await sql.unsafe<{ id: string; next_owner: string }[]>(
    `SELECT id, next_owner FROM delivery_handoffs
     WHERE request_id = '${fx10.id}'
       AND request_generation = ${fx10.fixture_generation}`,
  );
  assert.equal(
    handoff10.next_owner,
    personaName.display_name +
      ": Stand up the fixture environment before the pilot.",
  );

  await resetFixtures(reviewer);
  const [restored10] = await sql.unsafe<
    {
      legacy: string | null;
      owner: string | null;
      task: string | null;
      g: number;
    }[]
  >(
    `SELECT next_owner AS legacy, delivery_owner_actor_id AS owner,
       next_task AS task, fixture_generation AS g
     FROM requests WHERE id = '${fx10.id}'`,
  );
  assert.equal(
    restored10.legacy,
    fx10.next_owner,
    "the legacy next owner returns to its seeded value",
  );
  assert.equal(restored10.owner, null, "the reset clears the owner actor");
  assert.equal(restored10.task, null, "the reset clears the next task");
  assert.equal(restored10.g, fx10.fixture_generation + 1);
  const [handoffAfter10] = await sql.unsafe<{ next_owner: string }[]>(
    `SELECT next_owner FROM delivery_handoffs WHERE id = '${handoff10.id}'`,
  );
  assert.equal(
    handoffAfter10.next_owner,
    handoff10.next_owner,
    "the prior generation's handoff snapshot survives the reset unchanged",
  );

  console.log(
    "delivery-lineage checks passed: full-retry-key identity with handoff " +
      "and generation on every link, link-not-create for existing items, " +
      "freshness-derived resolution gates, baseline links current and participant links historical after reset, " +
      "a late result that cannot alter a closed review's evidence, ticketless record_outcome, and a linked follow-up that never writes the parent, and local fixture recovery that refuses imported records.",
  );
} finally {
  await sql.end();
}
