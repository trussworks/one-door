// Starts from the historical seed in an isolated one_door_fixup database.
// The baseline source fixture and test records remain available for inspection.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { createDatabase } from "../src/db/client.ts";
import { collectCorpus } from "../src/models/corpus.ts";
import { assignReview } from "../src/workflow/review.ts";
import { buildSeedData } from "../src/seed/build.ts";
import { upgradeFixtureState } from "../src/seed/fixture-upgrade.ts";
import {
  createVisitor,
  resetFixtures,
  saveDraft,
  submitRequest,
} from "../src/workflow/index.ts";
import { withReadSnapshot, type ActorContext } from "../src/workflow/shared.ts";
import { requestView } from "../src/server/request-views.ts";
import { baselineFixture } from "./fixture-baseline.ts";

const run = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const PRE_COORDINATOR_VARIETY_HASH =
  "6949e8409740b25126b167799d9324be92d786151a5e7b80a4ee991ba4f03fba";
const BASELINE_DIR = baselineFixture("189cf874fd03");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("An isolated DATABASE_URL is required");
if (!new URL(url).pathname.startsWith("/one_door_fixup"))
  throw new Error(
    "Fixture-upgrade checks require a new isolated one_door_fixup database",
  );
process.env.DATABASE_URL = url;
const sql = postgres(url, { max: 1, onnotice: () => {} });

const EVIDENCE_TABLES = [
  "draft_turns",
  "asset_assessments",
  "asset_candidates",
  "asset_candidate_decisions",
  "risk_assessments",
  "risk_findings",
  "risk_finding_decisions",
  "rice_scores",
  "model_calls",
  "task_completions",
];

async function baselineScript(name: string): Promise<void> {
  await run(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/" + name,
      "--confirm-fixture-reset",
    ],
    { cwd: BASELINE_DIR, env: { ...process.env, DATABASE_URL: url } },
  );
}

async function snapshotEvidence(): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  for (const table of EVIDENCE_TABLES) {
    const records = await sql.unsafe<{ id: string; row: string }[]>(
      `SELECT id, to_jsonb(t)::text AS row FROM ${table} t ORDER BY id`,
    );
    for (const record of records) rows.set(table + ":" + record.id, record.row);
  }
  return rows;
}

function assertRetained(
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  for (const [key, row] of before) {
    assert.equal(after.get(key), row, key + " changed across the upgrade");
  }
}

async function migrateCurrentSchema() {
  const before =
    await sql`SELECT id, to_jsonb(r)::text AS row FROM requests r ORDER BY id`;
  await run(
    process.execPath,
    ["--experimental-strip-types", "scripts/db-migrate.ts"],
    {
      cwd: workspaceRoot,
      env: { ...process.env, DATABASE_URL: url },
    },
  );
  const after = await sql`SELECT id,
    (to_jsonb(r) - 'delivery_owner_actor_id' - 'next_task')::text AS row
    FROM requests r ORDER BY id`;
  assert.deepEqual(
    [...after],
    [...before],
    "the additive migration leaves every existing request field unchanged",
  );
  const [populated] = await sql`SELECT count(*)::int AS count FROM requests
    WHERE delivery_owner_actor_id IS NOT NULL OR next_task IS NOT NULL`;
  assert.equal(populated.count, 0);
}

try {
  await baselineScript("db-migrate.ts");
  await baselineScript("db-seed.ts");
  // New application code needs the new schema; the reference fixture stays old.
  await migrateCurrentSchema();

  // ── 1. The installed manifest is the pre-correction build's ─────────────
  const baseline = await import(
    pathToFileURL(BASELINE_DIR + "/src/seed/build.ts").href
  );
  const baselineStable = await import(
    pathToFileURL(BASELINE_DIR + "/src/seed/stable.ts").href
  );
  const oldHash = baselineStable.contentHash(baseline.buildSeedData());
  const [manifest] = await sql.unsafe<{ content_hash: string }[]>(
    `SELECT content_hash FROM _one_door_fixture_seed WHERE name = 'reference'`,
  );
  assert.equal(manifest.content_hash, oldHash, "old build wrote its manifest");

  // ── 2. Live evidence linked to fixture subjects ──────────────────────────
  const seed = buildSeedData();
  const alice = await createVisitor();
  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const draft = await saveDraft(alice, {
    organizationId: organization.id,
    rawNeed: "A live request that must survive the fixture upgrade.",
    content: {
      title: "Live upgrade survivor " + randomUUID().slice(0, 8),
      problem: "The live rows must remain untouched.",
      affectedPeople: "Live visitors",
      acceptanceCriteria: [],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready",
  });
  const liveRequest = await submitRequest(alice, {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating: 4,
    idempotencyKey: randomUUID(),
  });
  const completedFixture = seed.requests.find(
    (row) => row.stage === "first_review_completed",
  );
  // A live first-review completion is only possible where none exists for
  // the current generation, so the probes attach to an under-review example.
  const probeFixture = seed.requests.find(
    (row) => row.stage === "under_review",
  );
  assert.ok(completedFixture && probeFixture);
  const [persona] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' LIMIT 1`,
  );
  assert.ok(persona);
  const liveCompletionId = randomUUID();
  await sql.unsafe(`
    INSERT INTO task_completions
      (id, request_id, actor_id, visitor_id, task_type, acting_view, rating,
       origin, idempotency_key, request_generation)
    VALUES ('${liveCompletionId}', '${probeFixture.id}', '${persona.id}',
      '${alice.visitorId}', 'contributor_first_review', 'contributor', 5,
      'live', 'live-upgrade-probe-${randomUUID().slice(0, 8)}', 1)
  `);
  const currentAsset = await withReadSnapshot(
    async (tx) => (await collectCorpus(tx, "asset_match")).hash,
  );
  const liveAssessmentId = randomUUID();
  await sql.unsafe(`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin, request_generation)
    VALUES ('${liveAssessmentId}', '${probeFixture.sourceDraftId}',
      'succeeded', '${currentAsset}', 'live', 1)
  `);

  // A live human RICE score and a live evidence pin recorded on the old
  // build must survive the upgrade untouched.
  const unscoredCompleted = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM requests
     WHERE stage = 'first_review_completed' AND current_rice_score_id IS NULL
     ORDER BY display_id`,
  );
  assert.ok(unscoredCompleted.length >= 2, "old seed has unscored completions");
  const liveRiceFixtureId = unscoredCompleted[0].id;
  const seedPinFixtureId = unscoredCompleted[1].id;
  const livePinnedAssessmentId = randomUUID();
  await sql`INSERT INTO asset_assessments (id, draft_id, status, catalog_corpus_hash, origin, request_generation)
    SELECT ${livePinnedAssessmentId}, source_draft_id, 'succeeded', ${currentAsset}, 'live', fixture_generation
    FROM requests WHERE id = ${liveRiceFixtureId}`;
  const liveRiceId = randomUUID();
  await sql.unsafe(`
    INSERT INTO rice_scores
      (id, request_id, version, reach, reach_unit, reach_period,
       reach_rationale, reach_actor_id, impact, impact_rationale,
       impact_actor_id, confidence, confidence_rationale, confidence_actor_id,
       effort, effort_rationale, effort_actor_id, score, rubric_version,
       formula_version, created_by_actor_id, origin, request_generation)
    VALUES ('${liveRiceId}', '${liveRiceFixtureId}', 9, 10, 'staff', 'probe',
      'live probe', '${persona.id}', 1, 'live probe', '${persona.id}',
      0.5, 'live probe', '${persona.id}', 2, 'live probe', '${persona.id}',
      2.5, 'probe', 'probe', '${persona.id}', 'live', 1)
  `);
  await sql.unsafe(`
    UPDATE requests SET current_rice_score_id = '${liveRiceId}'
    WHERE id = '${liveRiceFixtureId}'
  `);
  await sql.unsafe(`
    UPDATE review_tasks SET completed_assessment_id = '${livePinnedAssessmentId}'
    WHERE request_id = '${liveRiceFixtureId}' AND area = 'assets'
  `);

  // One seeded question receives a live reply before the upgrade; the
  // upgrade must keep it and append nothing for that question.
  const seedReplies = seed.draftTurns.filter(
    (turn) => (turn as { replyToTurnId?: string | null }).replyToTurnId,
  );
  assert.ok(seedReplies.length > 0, "the corrected seed pairs answers");
  const liveReplySeed = seedReplies[0];
  const liveReplyQuestion = (liveReplySeed as { replyToTurnId?: string | null })
    .replyToTurnId as string;
  const liveReplyId = randomUUID();
  await sql.unsafe(`
    INSERT INTO draft_turns
      (id, draft_id, ordinal, actor, actor_id, content, reply_to_turn_id)
    SELECT '${liveReplyId}', d.draft_id, max(d.ordinal) + 1, 'customer',
      '${persona.id}', $liveq$${liveReplySeed.content}$liveq$,
      '${liveReplyQuestion}'
    FROM draft_turns d WHERE d.draft_id = '${liveReplySeed.draftId}'
    GROUP BY d.draft_id
  `);

  const before = await snapshotEvidence();

  // A revision intentionally clears an old score. Null is not permission
  // to restore a template score onto a human-revised request.
  const [revisedFixture] =
    await sql`SELECT id FROM requests WHERE fixture_key IS NOT NULL AND stage = 'under_review' AND current_rice_score_id IS NOT NULL LIMIT 1`;
  assert.ok(revisedFixture);
  const revisedContentId = randomUUID();
  await sql`INSERT INTO request_content_revisions (id, request_id, revision_number, content, source, authored_by_actor_id, visitor_id)
    SELECT ${revisedContentId}, id, 1, jsonb_build_object('title', title, 'problem', problem, 'affectedPeople', affected_people, 'acceptanceCriteria', acceptance_criteria, 'requirements', requirements, 'constraints', constraints, 'unknowns', unknowns), 'clarification_answer', ${persona.id}, ${alice.visitorId}
    FROM requests WHERE id = ${revisedFixture.id}`;
  await sql`UPDATE requests SET current_revision_id = ${revisedContentId}, current_rice_score_id = NULL WHERE id = ${revisedFixture.id}`;

  // ── 3. Upgrade appends, repoints, and advances the manifest ──────────────
  const { db, sql: client } = createDatabase();
  const outcome = await upgradeFixtureState(db);
  assert.equal(outcome.status, "upgraded");
  assert.ok(outcome.insertedRows > 0, "the upgrade appended evidence rows");
  const [revisedAfterUpgrade] =
    await sql`SELECT current_rice_score_id FROM requests WHERE id = ${revisedFixture.id}`;
  assert.equal(
    revisedAfterUpgrade.current_rice_score_id,
    null,
    "a human-revised request stays unscored until a person reassesses it",
  );

  const after = await snapshotEvidence();
  assertRetained(before, after);
  const added = [...after.keys()].filter((key) => !before.has(key));
  for (const key of added) {
    const row = JSON.parse(after.get(key) as string) as {
      fixture_key?: string | null;
    };
    const fixtureKey = row.fixture_key ?? "";
    assert.ok(
      fixtureKey.endsWith(":u2") ||
        key.startsWith("rice_scores:") ||
        fixtureKey.includes("lifecycle-"),
      key +
        " is neither a superseding row, a new RICE row, nor a lifecycle example",
    );
  }
  // The upgrade also inserts lifecycle-example rows in tables outside this
  // evidence snapshot (the received request, its revision, clarifications,
  // handoffs, and resolutions), so the evidence adds are a subset of the count.
  assert.ok(
    outcome.insertedRows >= added.length && added.length > 0,
    "the upgrade counts at least the evidence adds",
  );

  // The live human pointers recorded before the upgrade are preserved; a
  // fixture without live pointers received the seed pointers.
  const [livePointers] = await sql.unsafe<
    { rice: string; pin: string | null }[]
  >(`
    SELECT r.current_rice_score_id AS rice, t.completed_assessment_id AS pin
    FROM requests r
    JOIN review_tasks t ON t.request_id = r.id AND t.area = 'assets'
    WHERE r.id = '${liveRiceFixtureId}'
  `);
  assert.equal(livePointers.rice, liveRiceId, "live RICE pointer preserved");
  assert.equal(livePointers.pin, livePinnedAssessmentId, "live pin preserved");
  const [seedPointers] = await sql.unsafe<
    { rice: string | null; pin: string | null }[]
  >(`
    SELECT r.current_rice_score_id AS rice, t.completed_assessment_id AS pin
    FROM requests r
    JOIN review_tasks t ON t.request_id = r.id AND t.area = 'assets'
    WHERE r.id = '${seedPinFixtureId}'
  `);
  assert.ok(seedPointers.rice, "the unscored fixture gained its seed score");
  assert.ok(seedPointers.pin, "the unpinned area gained its seed pin");

  // The dialogue read model pairs every seeded answer exactly once, keeps
  // unanswered questions honest, and keeps the pre-existing live reply.
  const turnsById = new Map(seed.draftTurns.map((turn) => [turn.id, turn]));
  async function expectPairedDialogue() {
    for (const request of seed.requests) {
      const draftRows = seed.draftTurns.filter(
        (turn) => turn.draftId === request.sourceDraftId,
      );
      const questions = draftRows.filter((turn) => turn.actor === "assistant");
      if (questions.length === 0) continue;
      const view = await requestView(alice, request.id, false);
      assert.equal(
        view.intakeDialogue.length,
        questions.length,
        request.displayId + " shows each question exactly once",
      );
      for (const entry of view.intakeDialogue) {
        const seedReply = seedReplies.find(
          (turn) =>
            (turn as { replyToTurnId?: string | null }).replyToTurnId ===
            entry.turnId,
        );
        const expected =
          entry.turnId === liveReplyQuestion
            ? liveReplySeed.content
            : (seedReply?.content ?? null);
        assert.equal(
          entry.answer,
          expected,
          request.displayId +
            " question '" +
            entry.question.slice(0, 40) +
            "' pairing",
        );
        assert.equal(
          entry.question,
          turnsById.get(entry.turnId)?.content,
          request.displayId + " question text matches the transcript",
        );
      }
    }
  }
  await expectPairedDialogue();
  const [liveReplyKept] = await sql.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM draft_turns
     WHERE reply_to_turn_id = '${liveReplyQuestion}'`,
  );
  assert.equal(liveReplyKept.n, 1, "the live reply stays the only answer");

  const [newManifest] = await sql.unsafe<{ content_hash: string }[]>(
    `SELECT content_hash FROM _one_door_fixture_seed WHERE name = 'reference'`,
  );
  assert.notEqual(newManifest.content_hash, oldHash, "manifest advanced");

  // ── 4. The read model is coherent after the upgrade ──────────────────────
  const currentRisk = await withReadSnapshot(
    async (tx) => (await collectCorpus(tx, "risk_assess")).hash,
  );
  const staleKeys: string[] = [];
  for (const request of seed.requests) {
    const view = await requestView(alice, request.id, false);
    if (view.assetAssessment?.status === "succeeded") {
      const current = view.assetAssessment.catalogCorpusHash === currentAsset;
      if (!current) staleKeys.push(request.fixtureKey as string);
    }
    if (view.riskAssessment?.status === "succeeded")
      assert.equal(
        view.riskAssessment.policyCorpusHash,
        currentRisk,
        request.displayId + " risk assessment reads current",
      );
    if (request.stage === "first_review_completed")
      assert.ok(
        request.currentRiceScoreId,
        request.displayId + " completed review is scored",
      );
  }
  assert.deepEqual(
    staleKeys,
    ["request:levee-settlement-imagery"],
    "only the deliberate example reads stale after the upgrade",
  );
  const [unscored] = await sql.unsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM requests
     WHERE stage = 'first_review_completed' AND current_rice_score_id IS NULL`,
  );
  assert.equal(unscored.count, 0, "every completed review is scored");

  // ── 5. Repeat upgrade is a no-op; reset accepts and stays repeatable ─────
  const again = await upgradeFixtureState(db);
  assert.equal(again.status, "already-current");
  assertRetained(after, await snapshotEvidence());

  // A live decision on CURRENT (corrected) evidence must be owned by
  // reset: the seed pointer comes back because the corrected rows are
  // seed members.
  const [currentCandidate] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM asset_candidates
     WHERE fixture_key LIKE '%:u2' AND current_decision_id IS NULL LIMIT 1`,
  );
  assert.ok(currentCandidate, "an undecided corrected candidate exists");
  const liveDecisionId = randomUUID();
  await sql.unsafe(`
    INSERT INTO asset_candidate_decisions
      (id, candidate_id, decision, actor_id, origin)
    VALUES ('${liveDecisionId}', '${currentCandidate.id}', 'accepted',
      '${persona.id}', 'live');
    UPDATE asset_candidates SET current_decision_id = '${liveDecisionId}'
    WHERE id = '${currentCandidate.id}'
  `);

  const reviewer: ActorContext = {
    actorId: persona.id,
    actingView: "contributor",
    visitorId: alice.visitorId,
  };
  await resetFixtures(reviewer);
  await resetFixtures(reviewer);
  const [resetPin] =
    await sql`SELECT completed_assessment_id FROM review_tasks WHERE request_id = ${liveRiceFixtureId} AND area = 'assets'`;
  assert.equal(
    resetPin.completed_assessment_id,
    seed.reviewTasks.find(
      (task) => task.requestId === liveRiceFixtureId && task.area === "assets",
    )?.completedAssessmentId,
    "reset restores the fixture assessment reference, not the previous run's live reference",
  );
  const [restored] = await sql.unsafe<{ current: string | null }[]>(
    `SELECT current_decision_id AS current FROM asset_candidates
     WHERE id = '${currentCandidate.id}'`,
  );
  assert.equal(
    restored.current,
    null,
    "reset restores the seed state of corrected current evidence",
  );
  const postReset = await snapshotEvidence();
  assertRetained(after, postReset);
  const [liveRows] = await sql.unsafe<{ completions: number; live: number }[]>(`
    SELECT
      (SELECT count(*)::int FROM task_completions
        WHERE id = '${liveCompletionId}') AS completions,
      (SELECT count(*)::int FROM asset_assessments
        WHERE id = '${liveAssessmentId}') AS live
  `);
  assert.equal(liveRows.completions, 1, "live completion survives reset");
  assert.equal(liveRows.live, 1, "live assessment survives reset");
  await expectPairedDialogue();
  const viewAfterReset = await requestView(alice, completedFixture.id, false);
  assert.equal(
    viewAfterReset.assetAssessment?.catalogCorpusHash,
    currentAsset,
    "reset keeps pointing at the corrected evidence",
  );
  const [liveView] = await sql.unsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM requests
     WHERE id = '${liveRequest.requestId}'`,
  );
  assert.equal(
    liveView.count,
    1,
    "the live request survives upgrade and reset",
  );
  // Coordinator variety. The seed writes no review_assigned event, so one
  // present means a person chose that coordinator; the upgrade leaves every
  // such row alone, including a person who chose the coordinator the seed
  // itself used to name.
  const seedNow = buildSeedData();
  const personaRow = seedNow.actors.find(
    (actor) => actor.fixtureKey === "actor:elena-castellanos",
  );
  const otherRow = seedNow.actors.find(
    (actor) => actor.fixtureKey === "actor:jordan-lee",
  );
  // Rows the current seed schedules to MOVE, so no assertion below is
  // satisfied by a row the step skips anyway.
  const movesToOther = seedNow.requests.filter(
    (request) =>
      request.coordinatingActorId &&
      request.coordinatingActorId !== personaRow?.id,
  );
  assert.ok(
    personaRow && otherRow && movesToOther.length >= 3,
    "the seed schedules several examples for another coordinator",
  );
  const resolved = new Set(
    seedNow.requestResolutions.map((row) => row.requestId),
  );
  const choices = movesToOther.filter((request) => !resolved.has(request.id));
  assert.ok(choices.length >= 4);
  const [untouched, keepsManualOther, keepsManualPersona, keepsNonBaseline] =
    choices;
  // Recreate the old coordinator values before testing the upgrade, rather
  // than testing rows a reset already brought to the new seed.
  for (const request of movesToOther)
    await sql`UPDATE requests SET coordinating_actor_id = ${personaRow.id}
      WHERE id = ${request.id}`;
  for (const [request, chosen] of [
    [keepsManualOther, otherRow],
    [keepsManualPersona, personaRow],
  ] as const) {
    const [beforeAssignment] = await sql<{ row_version: number }[]>`
      SELECT row_version FROM requests WHERE id = ${request.id}`;
    await assignReview(
      { actorId: personaRow.id, actingView: "contributor" },
      {
        requestId: request.id,
        coordinatorActorId: chosen.id,
        expectedRowVersion: beforeAssignment.row_version,
      },
    );
  }
  await sql`UPDATE requests SET coordinating_actor_id = ${otherRow.id},
    row_version = row_version + 1 WHERE id = ${keepsNonBaseline.id}`;
  const beforeCoordinatorUpgrade = await snapshotEvidence();
  const [liveBefore] = await sql.unsafe<
    { coordinating_actor_id: string | null }[]
  >(
    `SELECT coordinating_actor_id FROM requests WHERE id = '${liveRequest.requestId}'`,
  );
  await sql.unsafe(
    `UPDATE _one_door_fixture_seed SET content_hash =
     '${PRE_COORDINATOR_VARIETY_HASH}' WHERE name = 'reference'`,
  );
  const upgradeCommand = [
    "--experimental-strip-types",
    "scripts/db-upgrade-fixtures.ts",
  ];
  const upgradeOptions = {
    cwd: workspaceRoot,
    env: { ...process.env, DATABASE_URL: url },
  };
  await assert.rejects(run(process.execPath, upgradeCommand, upgradeOptions), {
    code: 1,
    stderr: /Fixture upgrade requires --confirm-fixture-upgrade/,
  });
  const [unconfirmedManifest] =
    await sql`SELECT content_hash FROM _one_door_fixture_seed WHERE name = 'reference'`;
  assert.equal(unconfirmedManifest.content_hash, PRE_COORDINATOR_VARIETY_HASH);
  upgradeCommand.push("--confirm-fixture-upgrade");
  const upgraded = await run(process.execPath, upgradeCommand, upgradeOptions);
  assert.match(upgraded.stdout, /Reference fixtures upgraded:/);
  assertRetained(beforeCoordinatorUpgrade, await snapshotEvidence());

  const coordinatorOf = async (id: string) =>
    (
      await sql.unsafe<{ coordinating_actor_id: string | null }[]>(
        `SELECT coordinating_actor_id FROM requests WHERE id = '${id}'`,
      )
    )[0].coordinating_actor_id;
  assert.equal(
    await coordinatorOf(untouched.id),
    untouched.coordinatingActorId,
    "an example nobody assigned moves to its current coordinator",
  );
  assert.equal(
    await coordinatorOf(keepsManualOther.id),
    otherRow.id,
    "a coordinator someone set by hand survives the upgrade",
  );
  assert.equal(
    await coordinatorOf(keepsManualPersona.id),
    personaRow.id,
    "a hand-chosen coordinator survives even when the seed names the same one",
  );
  assert.equal(
    await coordinatorOf(keepsNonBaseline.id),
    otherRow.id,
    "an assignment outside the known baseline survives even without an audit event",
  );
  assert.equal(
    await coordinatorOf(liveRequest.requestId),
    liveBefore.coordinating_actor_id,
    "a live request keeps its coordinator",
  );
  const spread = await sql.unsafe<{ coordinating_actor_id: string }[]>(
    `SELECT DISTINCT coordinating_actor_id FROM requests
     WHERE fixture_key IS NOT NULL AND coordinating_actor_id IS NOT NULL`,
  );
  assert.ok(
    spread.length > 1,
    "seeded examples name more than one coordinator after upgrade",
  );
  const repeated = await run(process.execPath, upgradeCommand, upgradeOptions);
  assert.match(repeated.stdout, /already match this build; nothing to do/);
  const [currentManifest] =
    await sql`SELECT content_hash FROM _one_door_fixture_seed WHERE name = 'reference'`;
  await sql`UPDATE _one_door_fixture_seed SET content_hash = ${"0".repeat(64)} WHERE name = 'reference'`;
  await assert.rejects(run(process.execPath, upgradeCommand, upgradeOptions), {
    code: 1,
    stderr: /installed reference fixture is not a known prior build/,
  });
  assertRetained(beforeCoordinatorUpgrade, await snapshotEvidence());
  await sql`UPDATE _one_door_fixture_seed SET content_hash = ${currentManifest.content_hash} WHERE name = 'reference'`;
  await sql`UPDATE _one_door_fixture_seed SET name = 'missing-reference-test' WHERE name = 'reference'`;
  try {
    await assert.rejects(
      run(process.execPath, upgradeCommand, upgradeOptions),
      {
        code: 1,
        stderr: /no reference fixture is installed/,
      },
    );
  } finally {
    await sql`UPDATE _one_door_fixture_seed SET name = 'reference' WHERE name = 'missing-reference-test'`;
  }

  await client.end();

  console.log(
    "fixture-upgrade checks passed: the pre-correction database gains " +
      "corrected evidence by append only, live and immutable rows survive " +
      "byte for byte, repeats are no-ops, and reset stays repeatable " +
      "against the corrected fixtures.",
  );
} finally {
  await sql.end();
}
