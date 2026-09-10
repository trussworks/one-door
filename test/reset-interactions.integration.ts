// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { effectiveInput } from "../src/models/corpus.ts";
import {
  enqueueModelJob,
  getModelJob,
  runWorkerOnce,
  type ModelProvider,
} from "../src/models/index.ts";
import {
  askClarification,
  createVisitor,
  getRequestRecord,
  resetFixtures,
  saveDraft,
  submitRequest,
} from "../src/workflow/index.ts";
import { withDb, type ActorContext } from "../src/workflow/shared.ts";

const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at a fresh isolated database this check may write to.",
    );
  }
  return url;
}

async function runScript(name: string, url: string): Promise<void> {
  await run(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL(`scripts/${name}`, repoRoot)),
    ],
    {
      cwd: fileURLToPath(repoRoot),
      env: { ...process.env, DATABASE_URL: url },
    },
  );
}

const url = databaseUrl();
process.env.DATABASE_URL = url;
const sql = postgres(url, { max: 1, onnotice: () => {} });

const riskOutput = (policyRuleId: string) =>
  JSON.stringify({
    findings: [
      {
        policyRuleId,
        kind: "supported_risk",
        evidence: "The request names state identity integration.",
        missingInformation: null,
        proposedSeverity: "moderate",
        rationale: "Identity integration falls under the cited rule.",
      },
    ],
  });

const assetOutput = (catalogItemId: string) =>
  JSON.stringify({
    candidates: [
      {
        catalogItemId,
        fitBand: "possible",
        coverage: ["Tracks structured records"],
        gaps: ["No grants-specific workflow"],
        dependencies: [],
        rationale: "The governed asset covers the tracking core.",
      },
    ],
  });

function providerOf(text: () => string): ModelProvider {
  return {
    async complete() {
      return { outputText: text(), inputTokens: 900, outputTokens: 400 };
    },
  };
}

async function generationOf(requestId: string): Promise<number> {
  const [row] = await sql.unsafe<{ fixture_generation: number }[]>(
    `SELECT fixture_generation FROM requests WHERE id = '${requestId}'`,
  );
  return Number(row.fixture_generation);
}

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  const [priorGenerations] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM requests WHERE fixture_generation > 1`,
  );
  assert.equal(
    Number(priorGenerations.total),
    0,
    "fixture generations already advanced; supply a fresh database",
  );

  const [persona] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' LIMIT 1`,
  );
  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [catalogItem] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     LIMIT 1`,
  );
  const [rule] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`,
  );
  const visitor = await createVisitor();
  const reviewer: ActorContext = {
    actorId: persona.id,
    actingView: "contributor",
    visitorId: visitor.visitorId,
  };
  const cleanFixtures = await sql.unsafe<
    { id: string; source_draft_id: string }[]
  >(
    `SELECT r.id, r.source_draft_id FROM requests r
     WHERE r.fixture_key IS NOT NULL AND r.stage = 'under_review'
       AND NOT EXISTS (
         SELECT 1 FROM clarification_requests c WHERE c.request_id = r.id
       )
     ORDER BY r.display_id LIMIT 4`,
  );
  assert.equal(cleanFixtures.length, 4, "four clean under-review fixtures");
  const [fixtureAsk, fixtureAnswer, fixturePrepare, fixtureLease] =
    cleanFixtures;

  // ── 1. Ask → reset → ask again takes the next revision number ────────────
  await askClarification(reviewer, {
    requestId: fixtureAsk.id,
    question: "First question before the reset?",
    expectedRowVersion: await (async () =>
      (
        await sql.unsafe<{ v: number }[]>(
          `SELECT row_version AS v FROM requests WHERE id = '${fixtureAsk.id}'`,
        )
      )[0].v)(),
  });
  await resetFixtures(reviewer);
  assert.equal(await generationOf(fixtureAsk.id), 2, "open question bumps");
  const secondAsk = await askClarification(reviewer, {
    requestId: fixtureAsk.id,
    question: "Second question after the reset?",
    expectedRowVersion: await (async () =>
      (
        await sql.unsafe<{ v: number }[]>(
          `SELECT row_version AS v FROM requests WHERE id = '${fixtureAsk.id}'`,
        )
      )[0].v)(),
  });
  assert.ok(secondAsk.clarificationId, "asking again after reset works");
  const askRecord = await getRequestRecord(fixtureAsk.id);
  assert.deepEqual(
    askRecord.revisions.map((row) => row.revisionNumber),
    [1, 2],
    "the new snapshot takes the next free revision number",
  );
  assert.equal(
    askRecord.currentRevisionId,
    askRecord.revisions[1].id,
    "the pointer cites the new-generation snapshot",
  );

  // ── 2. Old-generation answers stay out of the effective input ────────────
  const scaffoldRevision = randomUUID();
  await sql.unsafe(`
    INSERT INTO request_content_revisions
      (id, request_id, revision_number, content, source, authored_by_actor_id)
    SELECT '${scaffoldRevision}', r.id, 1, '{"scaffold":true}', 'submission',
      r.requester_actor_id
    FROM requests r WHERE r.id = '${fixtureAnswer.id}'
  `);
  await sql.unsafe(`
    INSERT INTO clarification_requests
      (id, request_id, revision_id, question, asked_by_actor_id, answer,
       answered_at, answer_revision_id, request_generation, origin)
    VALUES ('${randomUUID()}', '${fixtureAnswer.id}', '${scaffoldRevision}',
      'Scaffolded question from generation one?', '${persona.id}',
      'Scaffolded answer that must not leak.', now(), '${scaffoldRevision}',
      1, 'live')
  `);
  await resetFixtures(reviewer);
  assert.equal(await generationOf(fixtureAnswer.id), 2, "exchange bumps");
  const restoredInput = await withDb((db) =>
    effectiveInput(
      db,
      "risk_assess",
      fixtureAnswer.source_draft_id,
      fixtureAnswer.id,
    ),
  );
  assert.deepEqual(
    restoredInput.payload.clarifications,
    [],
    "the old generation's answer never contaminates the restored input",
  );
  assert.equal(restoredInput.requestGeneration, 2);
  assert.equal(restoredInput.revisionId, null, "pointer restored to reference");

  // ── 3. Live results and jobs never leak across generations ──────────────
  const prepareJob = await enqueueModelJob(visitor, {
    purpose: "asset_match",
    draftId: fixturePrepare.source_draft_id,
    requestId: fixturePrepare.id,
  });
  const prepared = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(prepared?.jobId, prepareJob.jobId);
  assert.equal(prepared?.outcome, "succeeded");
  let prepareRecord = await getRequestRecord(fixturePrepare.id);
  const liveBefore = prepareRecord.assetAssessments.find(
    (row) => row.origin === "live",
  );
  assert.ok(liveBefore);
  assert.equal(
    liveBefore.needsReassessment,
    false,
    "the live preparation is current before the reset",
  );

  await resetFixtures(reviewer);
  assert.equal(
    await generationOf(fixturePrepare.id),
    2,
    "a live assessment at the current generation forces a bump",
  );
  prepareRecord = await getRequestRecord(fixturePrepare.id);
  const liveAfter = prepareRecord.assetAssessments.find(
    (row) => row.id === liveBefore.id,
  );
  assert.equal(
    liveAfter?.needsReassessment,
    true,
    "the old live result is historical after the reset",
  );
  for (const row of prepareRecord.assetAssessments) {
    if (row.origin === "fixture") {
      assert.equal(
        row.needsReassessment,
        false,
        "fixture-origin reference assessments are current again",
      );
    }
  }

  const freshJob = await enqueueModelJob(visitor, {
    purpose: "asset_match",
    draftId: fixturePrepare.source_draft_id,
    requestId: fixturePrepare.id,
  });
  assert.notEqual(
    freshJob.jobId,
    prepareJob.jobId,
    "a succeeded job is not reused across generations",
  );
  assert.equal(freshJob.status, "queued");
  const oldJob = await getModelJob(prepareJob.jobId);
  assert.equal(oldJob.status, "succeeded", "the old job remains evidence");
  const freshRun = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(freshRun?.jobId, freshJob.jobId);
  assert.equal(freshRun?.outcome, "succeeded", "new-generation prepare works");
  prepareRecord = await getRequestRecord(fixturePrepare.id);
  const currentNow = prepareRecord.assetAssessments.filter(
    (row) => row.origin === "live" && !row.needsReassessment,
  );
  assert.equal(currentNow.length, 1, "exactly one current live result");
  assert.notEqual(currentNow[0].id, liveBefore.id);

  // ── 4. Ordinary live draft → submission reuse stays intact ───────────────
  const liveDraft = await saveDraft(visitor, {
    organizationId: organization.id,
    rawNeed: "A live need whose intake asset result should be reused.",
    content: {
      title: "Reuse across submission",
      problem: "The live problem statement.",
      affectedPeople: "Live staff",
      acceptanceCriteria: ["The intake result attaches to the revision"],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready",
  });
  const draftJob = await enqueueModelJob(visitor, {
    purpose: "asset_match",
    draftId: liveDraft.draftId,
  });
  const draftRun = await runWorkerOnce({
    provider: providerOf(() => assetOutput(catalogItem.id)),
  });
  assert.equal(draftRun?.jobId, draftJob.jobId);
  const submitted = await submitRequest(visitor, {
    draftId: liveDraft.draftId,
    expectedRowVersion: liveDraft.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  const [callsBefore] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM model_calls WHERE origin = 'live'`,
  );
  const reuse = await enqueueModelJob(visitor, {
    purpose: "asset_match",
    draftId: liveDraft.draftId,
    requestId: submitted.requestId,
  });
  assert.equal(reuse.jobId, draftJob.jobId, "same logical job across submit");
  // The submission already attached the stored result inside its own
  // transaction; the later enqueue finds nothing left to do.
  assert.equal(reuse.reused, false, "the attach happened at submission");
  const [reusedAttach] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM asset_assessments a
     JOIN requests r ON r.current_revision_id = a.revision_id
     WHERE r.id = '${submitted.requestId}' AND a.status = 'succeeded'`,
  );
  assert.equal(Number(reusedAttach.total), 1);
  const [callsAfter] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM model_calls WHERE origin = 'live'`,
  );
  assert.equal(callsAfter.total, callsBefore.total);
  // Settle the submission's risk job so the lease race below claims its own.
  const settleRisk = await runWorkerOnce({
    provider: providerOf(() => riskOutput(rule.id)),
  });
  assert.equal(settleRisk?.outcome, "succeeded");

  // ── 5. Reset during a genuinely claimed lease ────────────────────────────
  const leaseJob = await enqueueModelJob(visitor, {
    purpose: "risk_assess",
    draftId: fixtureLease.source_draft_id,
    requestId: fixtureLease.id,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalCalled!: () => void;
  const called = new Promise<void>((resolve) => {
    signalCalled = resolve;
  });
  const blockingProvider: ModelProvider = {
    async complete() {
      signalCalled();
      await gate;
      return {
        outputText: riskOutput(rule.id),
        inputTokens: 800,
        outputTokens: 300,
      };
    },
  };
  const leasedRun = runWorkerOnce({
    provider: blockingProvider,
    workerId: "reset-race-worker",
  });
  await called;
  const [leasedRow] = await sql.unsafe<{ lease_token: string | null }[]>(
    `SELECT lease_token FROM model_jobs WHERE id = '${leaseJob.jobId}'`,
  );
  assert.ok(leasedRow.lease_token, "the job holds a real claimed lease token");
  const [riskCountBefore] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM risk_assessments
     WHERE draft_id = '${fixtureLease.source_draft_id}'`,
  );
  const resetDuringLease = await resetFixtures(reviewer);
  assert.ok(
    resetDuringLease.supersededModelJobs >= 1,
    "the reset superseded the claimed job without a constraint failure",
  );
  release();
  const staleOutcome = await leasedRun;
  assert.equal(staleOutcome?.jobId, leaseJob.jobId);
  assert.equal(
    staleOutcome?.outcome,
    "lease_lost",
    "the returning worker cannot settle the superseded job",
  );
  const [leaseJobRow] = await sql.unsafe<
    { status: string; lease_owner: string | null }[]
  >(
    `SELECT status, lease_owner FROM model_jobs WHERE id = '${leaseJob.jobId}'`,
  );
  assert.equal(leaseJobRow.status, "superseded");
  assert.equal(leaseJobRow.lease_owner, null);
  const [leaseCall] = await sql.unsafe<
    { status: string; sanitized_error: string; reserved_cost_micros: number }[]
  >(
    `SELECT c.status, c.sanitized_error, c.reserved_cost_micros
     FROM model_calls c
     JOIN model_jobs j ON j.current_model_call_id = c.id
     WHERE j.id = '${leaseJob.jobId}'`,
  );
  assert.equal(leaseCall.status, "failed", "reservation reconciled by reset");
  assert.equal(leaseCall.sanitized_error, "fixture_reset_superseded");
  assert.ok(Number(leaseCall.reserved_cost_micros) > 0, "spend stays charged");
  const [riskCountAfter] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM risk_assessments
     WHERE draft_id = '${fixtureLease.source_draft_id}'`,
  );
  assert.equal(
    riskCountAfter.total,
    riskCountBefore.total,
    "no proposals leak back from the stale worker",
  );

  console.log(
    [
      "Reset interaction checks passed:",
      "  ask → reset → ask again snapshots the next free revision number",
      "  old-generation answers never contaminate the restored effective input",
      "  live results read as historical after reset, reference assessments return, and jobs never reuse across generations",
      "  ordinary live draft → submission asset reuse stays intact",
      "  a reset during a genuinely claimed lease succeeds; the stale worker loses the lease and leaks nothing",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
