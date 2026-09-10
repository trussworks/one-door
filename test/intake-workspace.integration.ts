// Use a fresh isolated DATABASE_URL: the cases exhaust per-draft call budgets.
// All dispatches use an injected provider; test records remain after the run.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { effectiveInput } from "../src/models/corpus.ts";
import { runWorkerOnce, type ModelProvider } from "../src/models/index.ts";
import { withDb } from "../src/workflow/shared.ts";
import { resultSchemas } from "../src/models/contracts.ts";
import { modelPrompts } from "../src/models/prompts.ts";
import {
  getIntakeWorkspace,
  prepareIntake,
  submitIntake,
} from "../src/workflow/intake-workspace.ts";
import {
  createVisitor,
  saveDraft,
  WorkflowError,
} from "../src/workflow/index.ts";
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

const providerOf = (text: () => string): ModelProvider => ({
  async complete() {
    return { outputText: text(), inputTokens: 900, outputTokens: 400 };
  },
});

const proposal = (label: string) => ({
  title: `Field photo capture ${label}`,
  problem: "Inspectors cannot attach field photos to inspection cases.",
  affectedPeople: "Forty inspectors and six coordinators",
  acceptanceCriteria: ["Photos reach the case the same day"],
  requirements: ["Mobile capture"],
  constraints: ["State-owned devices only"],
  unknowns: [],
});

interface CombinedShape {
  content: ReturnType<typeof proposal>;
  questions?: string[];
  serviceGaps?: string[];
  assetGaps?: string[];
  serviceBand?: "strong" | "possible" | "weak";
  assetBand?: "strong" | "possible" | "weak";
  assetDependencies?: string[];
  suggest?: "service" | "asset" | null;
}

const combined = (
  offeringId: string,
  catalogItemId: string,
  shape: CombinedShape,
) =>
  JSON.stringify({
    content: shape.content,
    questions: shape.questions ?? [],
    services: [
      {
        offeringId,
        fitBand: shape.serviceBand ?? "possible",
        coverage: ["Hosts the workflow"],
        gaps: shape.serviceGaps ?? [],
        relatedOfferingKeys: [],
        rationale: "The offering can host this request.",
      },
    ],
    assets: [
      {
        catalogItemId,
        fitBand: shape.assetBand ?? "strong",
        coverage: ["Captures field photos"],
        gaps: shape.assetGaps ?? [],
        dependencies: shape.assetDependencies ?? [],
        rationale: "The existing tool does this work.",
      },
    ],
    requesterSuggestion:
      shape.suggest === undefined || shape.suggest === null
        ? null
        : {
            kind: shape.suggest,
            id: shape.suggest === "service" ? offeringId : catalogItemId,
            summary: "The existing tool covers the whole need.",
            conditions: ["OIT provisions access"],
          },
  });

async function drainQueue(): Promise<void> {
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded' WHERE status = 'queued'`,
  );
}

/** Supersede every queued job except the one the next worker run must take. */
async function drainQueue2(keepJobId: string): Promise<void> {
  await sql.unsafe(
    `UPDATE model_jobs SET status = 'superseded'
     WHERE status = 'queued' AND id <> '${keepJobId}'`,
  );
}

async function checkRetainedSummarySubmission(
  organizationId: string,
  offeringId: string,
  itemId: string,
) {
  const owner = await createVisitor();
  const draft = await saveDraft(owner, {
    organizationId,
    rawNeed: "A saved request whose prompt changes before submission.",
  });
  const prepared = await prepareIntake(owner, {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
  });
  await drainQueue2(prepared.jobId);
  const content = proposal("retained-submission");
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offeringId, itemId, { content, suggest: "asset" }),
    ),
  });
  const version = modelPrompts.intake_interpret.version;
  try {
    modelPrompts.intake_interpret.version = "intake-test-retained-submission";
    const view = await getIntakeWorkspace(owner, draft.draftId);
    assert.equal(view.earlierSummary, true);
    const input = {
      draftId: draft.draftId,
      expectedRowVersion: view.draft.rowVersion,
      content,
      rating: 4,
      idempotencyKey: randomUUID(),
    };
    await expectCode(
      "VALIDATION_FAILED",
      () =>
        submitIntake(owner, {
          ...input,
          suggestionJobId: prepared.jobId,
          suggestionDecision: "accepted",
        }),
      "retained text cannot authorize a stale suggestion",
    );
    await submitIntake(owner, input);
    const [saved] =
      await sql`SELECT confirmed_intake_job_id FROM drafts WHERE id = ${draft.draftId}`;
    assert.equal(saved.confirmed_intake_job_id, null);
    const jobs =
      await sql`SELECT purpose FROM model_jobs WHERE draft_id = ${draft.draftId} AND purpose IN ('asset_match', 'risk_assess') AND status = 'queued' ORDER BY purpose`;
    assert.deepEqual(
      jobs.map((job) => job.purpose),
      ["asset_match", "risk_assess"],
      "retained text gets fresh reviewer preparation, not stale reuse",
    );
  } finally {
    modelPrompts.intake_interpret.version = version;
  }
}

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);
  await drainQueue();

  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [offering] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM service_offerings WHERE lifecycle = 'active'
     ORDER BY id LIMIT 1`,
  );
  const [item] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
     ORDER BY item_key LIMIT 1`,
  );
  const alice = await createVisitor();

  // ── 1. Fresh workspace ────────────────────────────────────────────────────
  const d1 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "Inspectors need same-day field photo capture.",
  });
  let ws = await getIntakeWorkspace(alice, d1.draftId);
  assert.equal(ws.job, null);
  assert.equal(ws.callsUsed, 0);
  assert.equal(ws.callsRemaining, 2);
  assert.equal(ws.canPrepare, true);
  assert.equal(ws.suggestion, null);
  assert.equal(ws.submittedRequest, null);
  assert.equal(ws.contentComplete, false, "typed words are honestly partial");

  // ── 2. One combined call: proposal, questions, one suggestion ────────────
  const prepared = await prepareIntake(alice, {
    draftId: d1.draftId,
    expectedRowVersion: ws.draft.rowVersion,
  });
  assert.equal(prepared.status, "queued");
  await drainQueue2(prepared.jobId);
  const run1 = await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("A"),
        questions: ["Which counties are covered?"],
        suggest: "asset",
      }),
    ),
  });
  assert.equal(run1?.outcome, "succeeded");
  ws = await getIntakeWorkspace(alice, d1.draftId);
  assert.equal(ws.job?.jobId, prepared.jobId);
  assert.equal(ws.job?.current, true);
  assert.equal(ws.callsUsed, 1);
  assert.deepEqual(ws.content, proposal("A"), "the proposal is the summary");
  assert.equal(ws.contentComplete, true);
  assert.equal(ws.questions.length, 1);
  assert.equal(ws.questions[0].answer, null);
  assert.ok(ws.suggestion, "the strong whole-need suggestion renders");
  assert.equal(ws.suggestion?.kind, "asset");
  assert.ok(ws.suggestion?.name.length, "the suggestion names the record");
  const [reviewerRows] = await sql.unsafe<
    { services: number; assets: number }[]
  >(`
    SELECT
      (SELECT count(*)::int FROM service_candidates
        WHERE draft_id = '${d1.draftId}') AS services,
      (SELECT count(*)::int FROM asset_candidates c
        JOIN asset_assessments a ON a.id = c.assessment_id
        WHERE a.draft_id = '${d1.draftId}') AS assets
  `);
  assert.equal(reviewerRows.services, 1, "service candidates persist");
  assert.equal(reviewerRows.assets, 1, "asset candidates persist");
  const promptVersion = modelPrompts.intake_interpret.version;
  try {
    modelPrompts.intake_interpret.version = "intake-test-formatting-update";
    const retained = await getIntakeWorkspace(alice, d1.draftId);
    assert.equal(retained.job?.current, false);
    assert.deepEqual(
      retained.content,
      proposal("A"),
      "a prompt change does not discard unchanged draft text",
    );
    assert.equal(retained.earlierSummary, true);
    assert.equal(
      retained.suggestion,
      null,
      "old text is not current matching evidence",
    );
    assert.equal(retained.callsUsed, 1, "retaining text makes no new call");
  } finally {
    modelPrompts.intake_interpret.version = promptVersion;
  }

  // A gapped suggested candidate stays reviewer-only.
  const d2 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A second need whose match has gaps.",
  });
  const prepared2 = await prepareIntake(alice, {
    draftId: d2.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared2.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("B"),
        assetGaps: ["Offline capture is unverified"],
        suggest: "asset",
      }),
    ),
  });
  const ws2 = await getIntakeWorkspace(alice, d2.draftId);
  assert.equal(ws2.job?.jobId, prepared2.jobId);
  assert.equal(
    ws2.suggestion,
    null,
    "a candidate with gaps never reaches the requester",
  );
  await saveDraft(alice, {
    draftId: d2.draftId,
    organizationId: organization.id,
    expectedRowVersion: ws2.draft.rowVersion,
    rawNeed: "A changed business need with different requirements.",
  });
  const changedNeed = await getIntakeWorkspace(alice, d2.draftId);
  assert.equal(
    changedNeed.contentComplete,
    false,
    "an earlier summary cannot replace changed business input",
  );
  assert.notDeepEqual(changedNeed.content, proposal("B"));

  // ── 3. Refinement is the last call; the budget is central ────────────────
  const versionBeforeRefinement = ws.draft.rowVersion;
  const answered = await prepareIntake(alice, {
    draftId: d1.draftId,
    expectedRowVersion: ws.draft.rowVersion,
    content: { problem: "Clarified need alongside the answer." },
    answers: [{ questionIndex: 0, answer: "All eight mountain counties." }],
    jobId: prepared.jobId,
  });
  const [refinement] = await sql<
    { problem: string; version: number; answered: boolean }[]
  >`
    SELECT structured_content->>'problem' AS problem, row_version AS version,
      EXISTS (
        SELECT 1 FROM draft_turns
        WHERE draft_id = ${d1.draftId} AND reply_to_turn_id IS NOT NULL
          AND content = 'All eight mountain counties.'
      ) AS answered
    FROM drafts WHERE id = ${d1.draftId}
  `;
  assert.equal(refinement.problem, "Clarified need alongside the answer.");
  assert.equal(
    refinement.answered,
    true,
    "content changes must not skip answers",
  );
  assert.equal(refinement.version, versionBeforeRefinement + 1);
  assert.equal(answered.rowVersion, refinement.version);
  assert.notEqual(answered.jobId, prepared.jobId, "answers change identity");
  await drainQueue2(answered.jobId);
  const run2 = await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("A2"),
        suggest: "asset",
      }),
    ),
  });
  assert.equal(run2?.outcome, "succeeded");
  ws = await getIntakeWorkspace(alice, d1.draftId);
  assert.equal(ws.callsUsed, 2);
  assert.equal(ws.callsRemaining, 0);
  assert.equal(ws.canPrepare, false);
  assert.deepEqual(ws.content, proposal("A2"));

  // A job requeued past the enqueue guard (an old API hole simulated with
  // raw SQL) dies at the central reservation gate: no provider dispatch, a
  // durable denial receipt, and a terminal failed job.
  await sql.unsafe(`
    UPDATE model_jobs SET status = 'queued', lease_owner = NULL,
      lease_expires_at = NULL WHERE id = '${answered.jobId}'
  `);
  const gateRun = await runWorkerOnce({
    provider: providerOf(() => {
      throw new Error("provider must not be called");
    }),
  });
  assert.equal(gateRun?.jobId, answered.jobId);
  assert.equal(gateRun?.outcome, "capped");
  const [gatedJob] = await sql.unsafe<
    { status: string; sanitized_error: string }[]
  >(
    `SELECT status, sanitized_error FROM model_jobs
     WHERE id = '${answered.jobId}'`,
  );
  assert.equal(gatedJob.status, "failed");
  assert.equal(gatedJob.sanitized_error, "intake_call_budget");
  const [deniedReceipt] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM model_calls
     WHERE draft_id = '${d1.draftId}' AND status = 'denied'
       AND sanitized_error = 'intake_call_budget'`,
  );
  assert.equal(deniedReceipt.total, 1, "the denial is a durable receipt");
  ws = await getIntakeWorkspace(alice, d1.draftId);
  assert.equal(ws.callsUsed, 2, "denials never count as attempts");

  // The third prepare is refused — and the refusal keeps the saved words.
  await expectCode(
    "INVALID_STATE",
    () =>
      prepareIntake(alice, {
        draftId: d1.draftId,
        expectedRowVersion: ws.draft.rowVersion,
        content: { problem: "An edited problem statement after the budget." },
      }),
    "a third intake attempt",
  );
  const [savedAnyway] = await sql.unsafe<{ problem: string }[]>(
    `SELECT structured_content->>'problem' AS problem FROM drafts
     WHERE id = '${d1.draftId}'`,
  );
  assert.equal(
    savedAnyway.problem,
    "An edited problem statement after the budget.",
    "the refused prepare never rolls back the requester's words",
  );
  ws = await getIntakeWorkspace(alice, d1.draftId);

  // ── 4. Manual OIT-routed submission after exhaustion ─────────────────────
  const manualContent = {
    ...proposal("A2"),
    problem: "An edited problem statement after the budget.",
  };
  const submitted = await submitIntake(alice, {
    draftId: d1.draftId,
    expectedRowVersion: ws.draft.rowVersion,
    content: manualContent,
    rating: 4,
    idempotencyKey: randomUUID(),
  });
  assert.ok(submitted.displayId.startsWith("OD-"));
  const [routing] = await sql.unsafe<
    { routing_state: string; selected: string | null }[]
  >(
    `SELECT routing_state, selected_service_candidate_id AS selected
     FROM requests WHERE id = '${submitted.requestId}'`,
  );
  assert.equal(routing.routing_state, "routing_requested");
  assert.equal(routing.selected, null, "no auto-chosen service, ever");
  const [prep] = await sql.unsafe<{ risk: number; asset: number }[]>(`
    SELECT
      (SELECT count(*)::int FROM model_jobs WHERE draft_id = '${d1.draftId}'
        AND purpose = 'risk_assess' AND status = 'queued') AS risk,
      (SELECT count(*)::int FROM model_jobs WHERE draft_id = '${d1.draftId}'
        AND purpose = 'asset_match' AND status = 'queued') AS asset
  `);
  assert.equal(prep.risk, 1, "risk preparation queues for the reviewer");
  assert.equal(
    prep.asset,
    1,
    "an edited submission queues a real asset refresh",
  );
  ws = await getIntakeWorkspace(alice, d1.draftId);
  assert.equal(ws.submittedRequest?.requestId, submitted.requestId);

  // ── 5. Unchanged proposal reuses the combined result; edits refuse ───────
  const d3 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A third need with a strong whole-need match.",
  });
  const prepared3 = await prepareIntake(alice, {
    draftId: d3.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared3.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("C"),
        suggest: "asset",
      }),
    ),
  });
  const ws3 = await getIntakeWorkspace(alice, d3.draftId);
  assert.ok(ws3.suggestion);

  // An edited submission may not carry the suggestion decision.
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      submitIntake(alice, {
        draftId: d3.draftId,
        expectedRowVersion: ws3.draft.rowVersion,
        content: { ...proposal("C"), problem: "Edited before submit." },
        rating: 5,
        idempotencyKey: randomUUID(),
        suggestionJobId: ws3.suggestion?.jobId,
        suggestionDecision: "accepted",
      }),
    "a decision on an edited submission",
  );

  const submitted3 = await submitIntake(alice, {
    draftId: d3.draftId,
    expectedRowVersion: ws3.draft.rowVersion,
    content: proposal("C"),
    rating: 5,
    idempotencyKey: randomUUID(),
    suggestionJobId: ws3.suggestion?.jobId,
    suggestionDecision: "accepted",
  });
  const [reuse] = await sql.unsafe<
    { assessments: number; asset_jobs: number; fits: number }[]
  >(`
    SELECT
      (SELECT count(*)::int FROM asset_assessments
        WHERE draft_id = '${d3.draftId}') AS assessments,
      (SELECT count(*)::int FROM model_jobs WHERE draft_id = '${d3.draftId}'
        AND purpose = 'asset_match') AS asset_jobs,
      (SELECT count(*)::int FROM asset_fit_decisions
        WHERE draft_id = '${d3.draftId}'
          AND decision = 'accepted') AS fits
  `);
  assert.equal(reuse.asset_jobs, 0, "no asset job for an unchanged proposal");
  assert.equal(
    reuse.assessments,
    2,
    "the combined evaluation is cloned onto the submission revision",
  );
  assert.equal(reuse.fits, 1, "the accepted suggestion is recorded evidence");
  const [routing3] = await sql.unsafe<{ routing_state: string }[]>(
    `SELECT routing_state FROM requests WHERE id = '${submitted3.requestId}'`,
  );
  assert.equal(
    routing3.routing_state,
    "routing_requested",
    "acceptance is evidence, not routing",
  );
  const view3 = await requestView(alice, submitted3.requestId, true);
  assert.ok(
    view3.assetAssessment,
    "the reviewer sees the reused combined evaluation",
  );
  assert.equal(view3.candidates.length, 1);

  // ── 6. Legacy over-budget drafts keep receipts ───────────────────────────
  const d4 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A legacy draft that already spent three calls.",
  });
  for (let i = 0; i < 3; i++) {
    await sql.unsafe(`
      INSERT INTO model_calls (id, draft_id, visitor_id, purpose, provider,
        model, prompt_version, input_hash, corpus_versions, status,
        attempt_count, reserved_cost_micros, actual_cost_micros,
        sanitized_error, idempotency_key, origin, completed_at)
      VALUES ('${randomUUID()}', '${d4.draftId}', '${alice.visitorId}',
        'intake_interpret', 'anthropic', 'claude-sonnet-5', 'intake-v2',
        'legacy-${i}', '{}', 'failed', 1, 1000, 900,
        'invalid_model_output_json', '${randomUUID()}', 'live', now())
    `);
  }
  const ws4 = await getIntakeWorkspace(alice, d4.draftId);
  assert.equal(ws4.callsUsed, 3, "legacy receipts stand untouched");
  assert.equal(ws4.callsRemaining, 0);
  assert.equal(ws4.canPrepare, false);

  // ── 7. Contract corrections: ownership, late answers, bounds ────────────
  // The idempotent replay never leaks across visitors.
  const mallory = await createVisitor();
  await expectCode(
    "NOT_OWNER",
    () =>
      submitIntake(mallory, {
        draftId: d3.draftId,
        expectedRowVersion: 1,
        content: proposal("C"),
        rating: 3,
        idempotencyKey: randomUUID(),
      }),
    "another visitor cannot replay a submitted draft",
  );

  // Late answers persist as the requester's words with no call, and they
  // make a prior suggestion stale for the same submission.
  const d5 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A fifth need answered late.",
  });
  const prepared5 = await prepareIntake(alice, {
    draftId: d5.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared5.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("E"),
        questions: ["Which offices are in scope?"],
        suggest: "asset",
      }),
    ),
  });
  const ws5 = await getIntakeWorkspace(alice, d5.draftId);
  assert.ok(ws5.suggestion);
  const [callsBeforeLate] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total FROM model_calls WHERE origin = 'live'`,
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      submitIntake(alice, {
        draftId: d5.draftId,
        expectedRowVersion: ws5.draft.rowVersion,
        content: proposal("E"),
        rating: 4,
        idempotencyKey: randomUUID(),
        answers: [{ questionIndex: 0, answer: "All eight field offices." }],
        jobId: prepared5.jobId,
        suggestionJobId: ws5.suggestion?.jobId,
        suggestionDecision: "accepted",
      }),
    "late answers make the suggestion stale for the same submission",
  );
  const late5 = await submitIntake(alice, {
    draftId: d5.draftId,
    expectedRowVersion: ws5.draft.rowVersion,
    content: proposal("E"),
    rating: 4,
    idempotencyKey: randomUUID(),
    answers: [{ questionIndex: 0, answer: "All eight field offices." }],
    jobId: prepared5.jobId,
  });
  assert.ok(late5.requestId);
  const [lateFacts] = await sql.unsafe<
    { answers: number; calls: number; refresh: number }[]
  >(`
    SELECT
      (SELECT count(*)::int FROM draft_turns
        WHERE draft_id = '${d5.draftId}' AND reply_to_turn_id IS NOT NULL) AS answers,
      (SELECT count(*)::int FROM model_calls WHERE origin = 'live') AS calls,
      (SELECT count(*)::int FROM model_jobs WHERE draft_id = '${d5.draftId}'
        AND purpose = 'asset_match') AS refresh
  `);
  assert.equal(lateFacts.answers, 1, "the exact words persist as an answer");
  assert.equal(
    lateFacts.calls,
    callsBeforeLate.total,
    "late answers never buy a call",
  );
  assert.equal(
    lateFacts.refresh,
    1,
    "the stale combined result yields a post-submission refresh",
  );

  // The tightened suggestion bounds gate new outputs at validation.
  const overlong = JSON.parse(
    combined(offering.id, item.id, {
      content: proposal("F"),
      suggest: "asset",
    }),
  );
  overlong.requesterSuggestion.summary = "x".repeat(301);
  const boundsCheck = resultSchemas.intake_interpret.safeParse(overlong);
  assert.equal(boundsCheck.success, false, "a 301-char summary is rejected");

  // ── 8. Only a strong, dependency-free fit reaches the requester ──────────
  const d6 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A sixth need whose match is merely possible.",
  });
  const prepared6 = await prepareIntake(alice, {
    draftId: d6.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared6.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("G"),
        assetBand: "possible",
        suggest: "asset",
      }),
    ),
  });
  const ws6 = await getIntakeWorkspace(alice, d6.draftId);
  assert.equal(
    ws6.suggestion,
    null,
    "a possible-band zero-gap suggestion is withheld",
  );
  assert.equal(ws6.job?.status, "succeeded", "the useful result stands");
  const [d6Rows] = await sql.unsafe<{ assets: number }[]>(`
    SELECT count(*)::int AS assets FROM asset_candidates c
    JOIN asset_assessments a ON a.id = c.assessment_id
    WHERE a.draft_id = '${d6.draftId}'
  `);
  assert.equal(d6Rows.assets, 1, "the partial candidate stays for review");
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      submitIntake(alice, {
        draftId: d6.draftId,
        expectedRowVersion: ws6.draft.rowVersion,
        content: proposal("G"),
        rating: 4,
        idempotencyKey: randomUUID(),
        suggestionJobId: prepared6.jobId,
        suggestionDecision: "accepted",
      }),
    "a withheld suggestion is not confirmable either",
  );

  const d7 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A seventh need with an unverified dependency.",
  });
  const prepared7 = await prepareIntake(alice, {
    draftId: d7.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared7.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("H"),
        assetDependencies: ["Identity Gateway integration"],
        suggest: "asset",
      }),
    ),
  });
  const ws7 = await getIntakeWorkspace(alice, d7.draftId);
  assert.equal(
    ws7.suggestion,
    null,
    "an unmet dependency withholds a strong zero-gap suggestion",
  );

  // ── 9. An accepted service suggestion reaches the reviewer distinctly ────
  const d8 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "An eighth need with a strong service path.",
  });
  const prepared8 = await prepareIntake(alice, {
    draftId: d8.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared8.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("I"),
        serviceBand: "strong",
        suggest: "service",
      }),
    ),
  });
  const ws8 = await getIntakeWorkspace(alice, d8.draftId);
  assert.equal(ws8.suggestion?.kind, "service");
  const submitted8 = await submitIntake(alice, {
    draftId: d8.draftId,
    expectedRowVersion: ws8.draft.rowVersion,
    content: proposal("I"),
    rating: 5,
    idempotencyKey: randomUUID(),
    suggestionJobId: ws8.suggestion?.jobId,
    suggestionDecision: "accepted",
  });
  const view8 = await requestView(alice, submitted8.requestId, true);
  const choice = view8.serviceChoices.find(
    (row) => row.requesterDecision === "accepted",
  );
  assert.ok(choice, "the accepted suggestion reaches the reviewer DTO");
  assert.equal(choice?.selected, false, "acceptance is not selection");
  assert.equal(choice?.decision, "accepted", "the old field stays compatible");
  const [routing8] = await sql.unsafe<{ routing_state: string }[]>(
    `SELECT routing_state FROM requests WHERE id = '${submitted8.requestId}'`,
  );
  assert.equal(routing8.routing_state, "routing_requested");

  // ── 10. A rejected service suggestion is feedback, never a silent reuse ──
  const d9 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A ninth need whose service path is declined.",
  });
  const prepared9 = await prepareIntake(alice, {
    draftId: d9.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared9.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("J"),
        serviceBand: "strong",
        suggest: "service",
      }),
    ),
  });
  const ws9 = await getIntakeWorkspace(alice, d9.draftId);
  assert.equal(ws9.suggestion?.kind, "service");
  const submitted9 = await submitIntake(alice, {
    draftId: d9.draftId,
    expectedRowVersion: ws9.draft.rowVersion,
    content: proposal("J"),
    rating: 4,
    idempotencyKey: randomUUID(),
    suggestionJobId: ws9.suggestion?.jobId,
    suggestionDecision: "rejected",
    suggestionReason: "The office cannot adopt a hosted path this year.",
  });
  const [rejectedFacts] = await sql.unsafe<
    { assessments: number; refresh_jobs: number }[]
  >(`
    SELECT
      (SELECT count(*)::int FROM asset_assessments
        WHERE draft_id = '${d9.draftId}') AS assessments,
      (SELECT count(*)::int FROM model_jobs WHERE draft_id = '${d9.draftId}'
        AND purpose = 'asset_match' AND status = 'queued') AS refresh_jobs
  `);
  assert.equal(
    rejectedFacts.assessments,
    1,
    "no clone rides a rejected service suggestion",
  );
  assert.equal(
    rejectedFacts.refresh_jobs,
    1,
    "the reviewer gets a refresh instead",
  );
  const [refreshInput] = await sql.unsafe<{ snapshot: string }[]>(
    `SELECT input_snapshot::text AS snapshot FROM model_jobs
     WHERE draft_id = '${d9.draftId}' AND purpose = 'asset_match'`,
  );
  assert.ok(
    refreshInput.snapshot.includes(
      "The office cannot adopt a hosted path this year.",
    ),
    "the rejection reason joins the refreshed asset input",
  );
  const view9 = await requestView(alice, submitted9.requestId, true);
  assert.equal(
    view9.serviceChoices.find((row) => row.requesterDecision === "rejected")
      ?.reason,
    "The office cannot adopt a hosted path this year.",
    "the declined service verdict reaches the reviewer with its reason",
  );

  // A rejected asset suggestion changes no input: the evaluation clones and
  // the verdict rides alongside as evidence.
  const d10 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A tenth need whose asset match is declined.",
  });
  const prepared10 = await prepareIntake(alice, {
    draftId: d10.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared10.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("K"),
        suggest: "asset",
      }),
    ),
  });
  const ws10 = await getIntakeWorkspace(alice, d10.draftId);
  assert.equal(ws10.suggestion?.kind, "asset");
  const submitted10 = await submitIntake(alice, {
    draftId: d10.draftId,
    expectedRowVersion: ws10.draft.rowVersion,
    content: proposal("K"),
    rating: 4,
    idempotencyKey: randomUUID(),
    suggestionJobId: ws10.suggestion?.jobId,
    suggestionDecision: "rejected",
    suggestionReason: "The tool does not fit our records process.",
  });
  const [assetRejectFacts] = await sql.unsafe<
    { assessments: number; fits: number }[]
  >(`
    SELECT
      (SELECT count(*)::int FROM asset_assessments
        WHERE draft_id = '${d10.draftId}') AS assessments,
      (SELECT count(*)::int FROM asset_fit_decisions
        WHERE draft_id = '${d10.draftId}' AND decision = 'rejected') AS fits
  `);
  assert.equal(
    assetRejectFacts.assessments,
    2,
    "the unchanged evaluation still clones for the reviewer",
  );
  assert.equal(assetRejectFacts.fits, 1, "the asset verdict is evidence");
  const view10 = await requestView(alice, submitted10.requestId, true);
  assert.equal(
    view10.assetFitDecisions.find((row) => row.decision === "rejected")?.reason,
    "The tool does not fit our records process.",
    "the declined asset verdict reaches the reviewer with its reason",
  );

  // ── 11. Model whitespace never costs a verbatim adoption its evidence ──
  const d11 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "An eleventh need whose proposal arrives messy.",
  });
  const prepared11 = await prepareIntake(alice, {
    draftId: d11.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared11.jobId);
  const messy = {
    ...proposal("L"),
    requirements: ["  Mobile capture  ", "Offline mode\nPhoto upload", " "],
  };
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: messy,
        serviceBand: "strong",
        suggest: "service",
      }),
    ),
  });
  const ws11 = await getIntakeWorkspace(alice, d11.draftId);
  assert.deepEqual(
    (ws11.content as { requirements: string[] }).requirements,
    ["Mobile capture", "Offline mode", "Photo upload"],
    "served list items are split on newlines, trimmed, and emptied of blanks",
  );
  assert.equal(ws11.suggestion?.kind, "service");
  const submitted11 = await submitIntake(alice, {
    draftId: d11.draftId,
    expectedRowVersion: ws11.draft.rowVersion,
    content: ws11.content,
    rating: 5,
    idempotencyKey: randomUUID(),
    suggestionJobId: ws11.suggestion?.jobId,
    suggestionDecision: "accepted",
  });
  const [messyFacts] = await sql.unsafe<
    { assessments: number; refresh_jobs: number }[]
  >(`
    SELECT
      (SELECT count(*)::int FROM asset_assessments
        WHERE draft_id = '${d11.draftId}') AS assessments,
      (SELECT count(*)::int FROM model_jobs WHERE draft_id = '${d11.draftId}'
        AND purpose = 'asset_match' AND status = 'queued') AS refresh_jobs
  `);
  assert.equal(
    messyFacts.assessments,
    2,
    "the verbatim adoption keeps its evidence and clones",
  );
  assert.equal(messyFacts.refresh_jobs, 0, "no refresh rides a clean reuse");

  // An unchanged save is a no-op: same job, same version, no stale page.
  const d12 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A twelfth need saved twice without changes.",
  });
  const typed12 = proposal("M");
  const prepared12 = await prepareIntake(alice, {
    draftId: d12.draftId,
    expectedRowVersion: 1,
    content: typed12,
  });
  await drainQueue2(prepared12.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, { content: proposal("M") }),
    ),
  });
  const ws12 = await getIntakeWorkspace(alice, d12.draftId);
  const again = await prepareIntake(alice, {
    draftId: d12.draftId,
    expectedRowVersion: ws12.draft.rowVersion,
    content: typed12,
  });
  assert.equal(again.jobId, prepared12.jobId, "unchanged input reuses the job");
  assert.equal(
    again.rowVersion,
    ws12.draft.rowVersion,
    "an unchanged save does not bump the draft version",
  );

  // ── 12. The reviewer sees every evaluated service candidate and the ──
  // ── intake dialogue, with honest currency labels ──
  const view11 = await requestView(alice, submitted11.requestId, true);
  const eval11 = view11.serviceEvaluation;
  assert.ok(eval11, "an adopted submission carries its service evaluation");
  assert.equal(
    eval11?.matchesSubmission,
    true,
    "the anchored call evaluated the submitted words",
  );
  assert.equal(eval11?.corpusCurrent, true, "the offering corpus is unchanged");
  assert.equal(eval11?.candidates.length, 1);
  assert.equal(eval11?.candidates[0].fitBand, "strong");
  assert.equal(eval11?.candidates[0].requesterDecision, "accepted");
  assert.ok(eval11?.candidates[0].coverage.length, "coverage reaches the view");
  assert.ok(eval11?.candidates[0].rationale, "rationale reaches the view");
  assert.deepEqual(view11.intakeDialogue, [], "no questions were asked");

  // An edited submission keeps the evaluation as labeled history, and the
  // undecided possible-band candidate still reaches the reviewer.
  const d13 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A thirteenth need submitted with edits and a late answer.",
  });
  const prepared13 = await prepareIntake(alice, {
    draftId: d13.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared13.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("N"),
        questions: ["Which records law applies to these files?"],
      }),
    ),
  });
  const ws13 = await getIntakeWorkspace(alice, d13.draftId);
  const submitted13 = await submitIntake(alice, {
    draftId: d13.draftId,
    expectedRowVersion: ws13.draft.rowVersion,
    content: { ...proposal("N"), title: "A changed records title" },
    rating: 3,
    idempotencyKey: randomUUID(),
    answers: [{ questionIndex: 0, answer: "Ten years." }],
    jobId: ws13.job?.jobId,
  });
  const view13 = await requestView(alice, submitted13.requestId, true);
  assert.equal(
    view13.serviceEvaluation?.matchesSubmission,
    false,
    "an edited submission never labels the old evaluation current",
  );
  assert.equal(view13.serviceEvaluation?.candidates.length, 1);
  assert.equal(view13.serviceEvaluation?.candidates[0].fitBand, "possible");
  assert.equal(
    view13.serviceEvaluation?.candidates[0].requesterDecision,
    null,
    "an undecided possibility still reaches the reviewer",
  );
  assert.deepEqual(
    view13.intakeDialogue.map((turn) => ({
      question: turn.question,
      answer: turn.answer,
    })),
    [
      {
        question: "Which records law applies to these files?",
        answer: "Ten years.",
      },
    ],
    "the reviewer sees the questions with the requester's answers",
  );

  // Offering-corpus drift demotes currency without hiding the evaluation.
  // Offering rows are immutable, so drift comes from a new active member.
  await sql.unsafe(`
    INSERT INTO service_offerings
      (id, offering_key, version, lifecycle, name, description,
       owner_organization_id, capabilities, prerequisites, review_date,
       content_hash)
    VALUES ('${randomUUID()}', 'drift-offering-${randomUUID().slice(0, 8)}', 1,
      'active', 'Drift Offering', 'An offering that changes the corpus.',
      '${organization.id}', '{}', '{}', '2026-09-01', 'drift-hash')
  `);
  const drifted = await requestView(alice, submitted11.requestId, true);
  assert.equal(
    drifted.serviceEvaluation?.corpusCurrent,
    false,
    "corpus drift is visible to the reviewer",
  );
  assert.equal(
    drifted.serviceEvaluation?.matchesSubmission,
    true,
    "drift does not un-anchor the submitted words",
  );

  // ── 13. Stale anchors and failed attempts never mislabel the ──
  // ── evaluation the reviewer sees ──
  // A legacy pre-submission adoption left an anchor; the new-flow edited
  // submission must clear it rather than label that evaluation current.
  const d14 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A fourteenth need adopted long ago, then rewritten.",
  });
  const prepared14 = await prepareIntake(alice, {
    draftId: d14.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared14.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, { content: proposal("P") }),
    ),
  });
  await sql.unsafe(
    `UPDATE drafts SET confirmed_intake_job_id = '${prepared14.jobId}'
     WHERE id = '${d14.draftId}'`,
  );
  const ws14 = await getIntakeWorkspace(alice, d14.draftId);
  const submitted14 = await submitIntake(alice, {
    draftId: d14.draftId,
    expectedRowVersion: ws14.draft.rowVersion,
    content: { ...proposal("P"), title: "Different words entirely" },
    rating: 3,
    idempotencyKey: randomUUID(),
  });
  const view14 = await requestView(alice, submitted14.requestId, true);
  assert.equal(
    view14.serviceEvaluation?.matchesSubmission,
    false,
    "an unadopted legacy anchor never labels the evaluation current",
  );
  assert.equal(view14.serviceEvaluation?.candidates.length, 1);
  const [anchor14] = await sql.unsafe<{ confirmed: string | null }[]>(
    `SELECT confirmed_intake_job_id AS confirmed FROM drafts
     WHERE id = '${d14.draftId}'`,
  );
  assert.equal(anchor14.confirmed, null, "the stale anchor is cleared");

  // A failed second attempt must not shadow the successful evaluation.
  const d15 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A fifteenth need whose second attempt fails.",
  });
  const prepared15 = await prepareIntake(alice, {
    draftId: d15.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared15.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, { content: proposal("Q") }),
    ),
  });
  const ws15a = await getIntakeWorkspace(alice, d15.draftId);
  const prepared15b = await prepareIntake(alice, {
    draftId: d15.draftId,
    expectedRowVersion: ws15a.draft.rowVersion,
    content: { ...proposal("Q"), title: "A reworded fifteenth title" },
  });
  await drainQueue2(prepared15b.jobId);
  await runWorkerOnce({
    provider: providerOf(() => {
      throw new Error("provider_timeout");
    }),
  });
  const ws15b = await getIntakeWorkspace(alice, d15.draftId);
  const submitted15 = await submitIntake(alice, {
    draftId: d15.draftId,
    expectedRowVersion: ws15b.draft.rowVersion,
    content: { ...proposal("Q"), title: "A reworded fifteenth title" },
    rating: 2,
    idempotencyKey: randomUUID(),
  });
  const view15 = await requestView(alice, submitted15.requestId, true);
  assert.equal(
    view15.serviceEvaluation?.candidates.length,
    1,
    "the failed attempt does not shadow the evaluated candidates",
  );
  assert.equal(
    view15.serviceEvaluation?.matchesSubmission,
    false,
    "the surviving evaluation reads as history, not adoption",
  );

  // ── 14. Answered intake questions reach asset and risk preparation ──
  const d16 = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A sixteenth need answered at the last moment.",
  });
  const prepared16 = await prepareIntake(alice, {
    draftId: d16.draftId,
    expectedRowVersion: 1,
  });
  await drainQueue2(prepared16.jobId);
  await runWorkerOnce({
    provider: providerOf(() =>
      combined(offering.id, item.id, {
        content: proposal("R"),
        questions: ["What retention period applies to these records?"],
      }),
    ),
  });
  const ws16 = await getIntakeWorkspace(alice, d16.draftId);
  await submitIntake(alice, {
    draftId: d16.draftId,
    expectedRowVersion: ws16.draft.rowVersion,
    content: ws16.content,
    rating: 4,
    idempotencyKey: randomUUID(),
    answers: [{ questionIndex: 0, answer: "Seven years." }],
    jobId: ws16.job?.jobId,
  });
  const lateJobs = await sql.unsafe<
    { purpose: string; snapshot: string }[]
  >(`SELECT purpose, input_snapshot::text AS snapshot FROM model_jobs
     WHERE draft_id = '${d16.draftId}'
       AND purpose IN ('asset_match', 'risk_assess')`);
  assert.equal(lateJobs.length, 2, "late answers force both preparations");
  for (const job of lateJobs) {
    assert.ok(
      job.snapshot.includes("What retention period applies to these records?"),
      job.purpose + " input carries the question",
    );
    assert.ok(
      job.snapshot.includes("Seven years."),
      job.purpose + " input carries the requester's late answer",
    );
  }
  // An answerless request keeps its input shape: no turns key, no churn.
  const [answerless] = await sql.unsafe<{ snapshot: string }[]>(
    `SELECT input_snapshot::text AS snapshot FROM model_jobs
     WHERE draft_id = '${d11.draftId}' AND purpose = 'risk_assess'`,
  );
  assert.ok(
    !answerless.snapshot.includes('"turns"'),
    "an answerless submission adds no turns key to its input",
  );

  // The pre-submission (draft-branch) asset input carries the same facts.
  const draftAsset = await withDb((db) =>
    effectiveInput(db, "asset_match", d16.draftId),
  );
  assert.ok(
    JSON.stringify(draftAsset.payload.turns).includes("Seven years."),
    "the pre-submission asset input carries the answer",
  );
  const draftAssetBare = await withDb((db) =>
    effectiveInput(db, "asset_match", d11.draftId),
  );
  assert.ok(
    !("turns" in draftAssetBare.payload),
    "an answerless draft adds no turns to the pre-submission asset input",
  );

  // The only route that attaches a live answer to a fixture draft is
  // ownership-gated, so a reset can never inherit obsolete live turns.
  const [fixtureDraft] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM drafts WHERE fixture_key IS NOT NULL LIMIT 1`,
  );
  assert.ok(fixtureDraft, "the seed supplies a fixture draft");
  await expectCode(
    "NOT_OWNER",
    () =>
      prepareIntake(alice, {
        draftId: fixtureDraft.id,
        expectedRowVersion: 1,
        answers: [{ questionIndex: 0, answer: "A leaked answer." }],
        jobId: randomUUID(),
      }),
    "a live visitor cannot answer a fixture draft",
  );

  await checkRetainedSummarySubmission(organization.id, offering.id, item.id);
  console.log(
    "intake-workspace checks passed: one-page budgeted intake with a " +
      "single evolving summary, gap-gated single suggestion, central " +
      "two-attempt enforcement with durable saves and denial receipts, " +
      "manual OIT-routed submission after exhaustion, exact-adoption reuse " +
      "of the combined asset evaluation, preserved legacy receipts, " +
      "owner-gated replays, late answers that persist without a call, " +
      "a strong-band dependency-free gate on the one suggestion, " +
      "requester service verdicts visible to the reviewer apart from " +
      "routing, rejection feedback that refreshes rather than reuses, " +
      "round-trip-stable served proposals, and no-op saves that keep " +
      "the page current.",
  );
} finally {
  await sql.end();
}
