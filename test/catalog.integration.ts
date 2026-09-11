// This suite commits test records to DATABASE_URL; use a fresh isolated database.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";

import { collectCorpus } from "../src/models/corpus.ts";
import {
  addCatalogItem,
  getCatalogItemRecord,
  askClarification,
  completeFirstReview,
  confirmCatalogItemAccurate,
  createVisitor,
  executeHandoff,
  getConflictComparison,
  getDeliveryState,
  getRequestRecord,
  getReviewState,
  getSourceHistory,
  importFixture,
  publishCatalogItem,
  recordAssetOutcome,
  recordRiskOutcome,
  recordRouting,
  registerSource,
  resetFixtures,
  resolveConflict,
  resolveRequest,
  retireCatalogItem,
  retireSource,
  reviseCatalogItem,
  saveDraft,
  saveRiceScore,
  submitRequest,
  updateSource,
  WorkflowError,
} from "../src/workflow/index.ts";
import { withDb, type ActorContext } from "../src/workflow/shared.ts";

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

async function runScript(
  name: string,
  url: string,
  args: string[] = [],
): Promise<{ code: number }> {
  const script = fileURLToPath(new URL(`scripts/${name}`, repoRoot));
  try {
    await run(
      process.execPath,
      ["--experimental-strip-types", script, ...args],
      {
        cwd: fileURLToPath(repoRoot),
        env: { ...process.env, DATABASE_URL: url },
      },
    );
    return { code: 0 };
  } catch (error) {
    return { code: (error as { code?: number }).code ?? 1 };
  }
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

// Approval compares stored corpus hashes with current collectCorpus hashes,
// so scaffolds record the real hash at insert time.
async function currentCorpusHash(
  purpose: "asset_match" | "risk_assess",
): Promise<string> {
  return withDb(async (db) => (await collectCorpus(db, purpose)).hash);
}

const riceFactors = (personaId: string) => ({
  reach: 150,
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

try {
  await runScript("db-migrate.ts", url);
  await runScript("db-seed.ts", url);

  // The one-shot architecture import and the reset lifecycle consume this
  // database's fixture history; a rerun needs a fresh database.
  const [priorImport] = await sql.unsafe<{ total: string }[]>(
    `SELECT count(*)::text AS total FROM inventory_sync_runs
     WHERE source_version = '2026-09-10'`,
  );
  assert.equal(
    Number(priorImport.total),
    0,
    "fixture import already applied; supply a fresh database",
  );

  const [organization] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM organizations WHERE kind = 'office' LIMIT 1`,
  );
  const [persona] = await sql.unsafe<{ id: string }[]>(
    `SELECT id FROM actors WHERE kind = 'persona' LIMIT 1`,
  );
  const stewardVisitor = await createVisitor();
  const steward: ActorContext = {
    actorId: persona.id,
    actingView: "administrator",
    visitorId: stewardVisitor.visitorId,
  };
  const reviewer: ActorContext = {
    actorId: persona.id,
    actingView: "contributor",
    visitorId: stewardVisitor.visitorId,
  };

  // ── 1. Source governance ─────────────────────────────────────────────────
  const source = await registerSource(steward, {
    name: `Grants Registry ${randomUUID().slice(0, 8)}`,
    adapterKind: "csv-upload",
    ownerOrganizationId: organization.id,
    expectedFreshnessHours: 168,
  });
  await expectCode(
    "VERSION_CONFLICT",
    () =>
      updateSource(steward, {
        sourceId: source.sourceId,
        expectedRowVersion: 99,
        expectedFreshnessHours: 72,
      }),
    "stale source edit",
  );
  const updatedSource = await updateSource(steward, {
    sourceId: source.sourceId,
    expectedRowVersion: 1,
    expectedFreshnessHours: 72,
  });
  const history = await getSourceHistory(source.sourceId);
  assert.equal(history.runs.length, 0, "a new source has no import history");
  await retireSource(steward, {
    sourceId: source.sourceId,
    expectedRowVersion: updatedSource.rowVersion,
  });
  await expectCode(
    "INVALID_STATE",
    () =>
      updateSource(steward, {
        sourceId: source.sourceId,
        expectedRowVersion: 3,
        expectedFreshnessHours: 24,
      }),
    "edit after retirement",
  );

  const authoredProvenance = () => [
    { fieldName: "name", rationale: "Steward-entered product name" },
    { fieldName: "description", rationale: "Steward-entered summary" },
    { fieldName: "itemType", rationale: "Steward-classified type" },
    { fieldName: "ownerOrganizationId", rationale: "Owning office confirmed" },
    { fieldName: "capabilities", rationale: "Capabilities as authored" },
    {
      fieldName: "dataClassifications",
      rationale: "Classifications as authored",
    },
  ];

  // ── 2. Canonical item governance and eligibility ─────────────────────────
  const added = await addCatalogItem(steward, {
    itemKey: `grants-tracker-${randomUUID().slice(0, 8)}`,
    name: "Grants Tracker",
    description: "Tracks grant awards across programs.",
    itemType: "software",
    ownerOrganizationId: organization.id,
    reviewDate: "2026-09-01",
    provenance: authoredProvenance(),
  });
  // The recorded field decisions and the persisted row must describe one
  // object, for supplied fields and applied defaults alike.
  const [addedRow] = await sql<Record<string, unknown>[]>`
    SELECT name, description, item_type AS "itemType",
           owner_organization_id AS "ownerOrganizationId",
           capabilities, data_classifications AS "dataClassifications",
           approval_status AS "approvalStatus", vendor
    FROM catalog_items WHERE id = ${added.catalogItemId}`;
  const addedDecisions = await sql<{ field_name: string; value: string }[]>`
    SELECT field_name, value::text AS value FROM catalog_field_decisions
    WHERE catalog_item_id = ${added.catalogItemId}`;
  assert.equal(addedDecisions.length, 6, "one decision per provenance entry");
  for (const decision of addedDecisions)
    assert.deepEqual(
      JSON.parse(decision.value),
      addedRow[decision.field_name],
      `decision value matches the persisted ${decision.field_name}`,
    );
  assert.deepEqual(addedRow.capabilities, [], "list default persisted");
  assert.equal(addedRow.vendor, null, "absent vendor stored as null");
  assert.equal(
    addedRow.approvalStatus,
    "review_required",
    "status default persisted",
  );

  await expectCode(
    "VALIDATION_FAILED",
    () =>
      addCatalogItem(steward, {
        itemKey: "missing-provenance-" + randomUUID().slice(0, 8),
        name: "Missing Provenance",
        description: "Lacks itemType provenance.",
        itemType: "software",
        ownerOrganizationId: organization.id,
        reviewDate: "2026-09-01",
        provenance: authoredProvenance().filter(
          (entry) => entry.fieldName !== "itemType",
        ),
      }),
    "add without provenance for every authored material field",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      addCatalogItem(steward, {
        itemKey: "absent-field-" + randomUUID().slice(0, 8),
        name: "Absent Field Evidence",
        description: "Cites a field with no stored value.",
        itemType: "software",
        ownerOrganizationId: organization.id,
        reviewDate: "2026-09-01",
        provenance: [
          ...authoredProvenance(),
          { fieldName: "vendor", rationale: "no vendor was supplied" },
        ],
      }),
    "provenance for a field with no stored value",
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      addCatalogItem(steward, {
        itemKey: "bad-date-" + randomUUID().slice(0, 8),
        name: "Bad Date",
        description: "February has no thirty-first day.",
        itemType: "software",
        ownerOrganizationId: organization.id,
        reviewDate: "2026-02-31",
        provenance: authoredProvenance(),
      }),
    "an impossible calendar date",
  );
  const statusEvidenced = await addCatalogItem(steward, {
    itemKey: "status-evidence-" + randomUUID().slice(0, 8),
    name: "Status Evidence",
    description: "Records the stored default status, not null.",
    itemType: "software",
    ownerOrganizationId: organization.id,
    reviewDate: "2026-09-01",
    provenance: [
      ...authoredProvenance(),
      { fieldName: "approvalStatus", rationale: "initial status recorded" },
    ],
  });
  const [statusDecision] = await sql.unsafe<{ value: string }[]>(
    `SELECT value::text AS value FROM catalog_field_decisions
     WHERE catalog_item_id = '${statusEvidenced.catalogItemId}'
       AND field_name = 'approvalStatus'`,
  );
  assert.equal(
    JSON.parse(statusDecision.value),
    "review_required",
    "the decision records the stored default, never null",
  );

  // Extended seed evidence lets a retired reference item publish again.
  const [seedItem] = await sql.unsafe<{ id: string; row_version: number }[]>(
    `SELECT id, row_version FROM catalog_items
     WHERE publication_state = 'published' AND approval_status = 'approved'
       AND fixture_key IS NOT NULL
     ORDER BY item_key LIMIT 1`,
  );
  const seedRetired = await retireCatalogItem(steward, {
    catalogItemId: seedItem.id,
    expectedRowVersion: Number(seedItem.row_version),
  });
  const seedRepublished = await publishCatalogItem(steward, {
    catalogItemId: seedItem.id,
    expectedRowVersion: seedRetired.rowVersion,
  });
  assert.equal(
    seedRepublished.publicationState,
    "published",
    "seed material evidence satisfies the publication gate",
  );
  await expectCode(
    "INVALID_STATE",
    () =>
      publishCatalogItem(steward, {
        catalogItemId: added.catalogItemId,
        expectedRowVersion: added.rowVersion,
      }),
    "publish without approval",
  );
  const approvedRevision = await reviseCatalogItem(steward, {
    catalogItemId: added.catalogItemId,
    expectedRowVersion: added.rowVersion,
    changes: { approvalStatus: "approved" },
    provenance: [
      { fieldName: "approvalStatus", rationale: "Security review sign-off" },
    ],
  });
  assert.equal(approvedRevision.currentVersion, 2);
  let published = await publishCatalogItem(steward, {
    catalogItemId: added.catalogItemId,
    expectedRowVersion: approvedRevision.rowVersion,
  });
  const tamperTarget = await addCatalogItem(steward, {
    itemKey: "tamper-probe-" + randomUUID().slice(0, 8),
    name: "Tamper Probe",
    description: "Publication must match recorded provenance.",
    itemType: "software",
    ownerOrganizationId: organization.id,
    reviewDate: "2026-09-01",
    provenance: authoredProvenance(),
  });
  const tamperApproved = await reviseCatalogItem(steward, {
    catalogItemId: tamperTarget.catalogItemId,
    expectedRowVersion: tamperTarget.rowVersion,
    changes: { approvalStatus: "approved" },
    provenance: [{ fieldName: "approvalStatus", rationale: "review sign-off" }],
  });
  await sql.unsafe(
    `UPDATE catalog_items SET name = 'Tampered Without Provenance'
     WHERE id = '${tamperTarget.catalogItemId}'`,
  );
  const gateError = await expectCode(
    "INVALID_STATE",
    () =>
      publishCatalogItem(steward, {
        catalogItemId: tamperTarget.catalogItemId,
        expectedRowVersion: tamperApproved.rowVersion,
      }),
    "publish when a stored material value has no matching provenance",
  );
  assert.match(gateError.detail ?? "", /provenance_missing_or_stale:name/);

  const corpusWithItem = await withDb((db) => collectCorpus(db, "asset_match"));
  assert.ok(
    corpusWithItem.catalogItemIds.has(added.catalogItemId),
    "published approved item is eligible for matching",
  );
  const revisedDraft = await reviseCatalogItem(steward, {
    catalogItemId: added.catalogItemId,
    expectedRowVersion: published.rowVersion,
    changes: { description: "Tracks verified grant awards across programs." },
    provenance: [
      {
        fieldName: "description",
        rationale: "Owner verified the revised description.",
      },
    ],
  });
  assert.equal(
    (await getCatalogItemRecord(added.catalogItemId)).item.publicationState,
    "draft",
  );
  assert.equal(
    (await withDb((db) => collectCorpus(db, "asset_match"))).catalogItemIds.has(
      added.catalogItemId,
    ),
    false,
    "a revision is not silently published into live matching",
  );
  published = await publishCatalogItem(steward, {
    catalogItemId: added.catalogItemId,
    expectedRowVersion: revisedDraft.rowVersion,
  });
  assert.equal(
    (await withDb((db) => collectCorpus(db, "asset_match"))).catalogItemIds.has(
      added.catalogItemId,
    ),
    true,
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      reviseCatalogItem(steward, {
        catalogItemId: added.catalogItemId,
        expectedRowVersion: published.rowVersion,
        changes: { name: "Renamed Without Provenance" },
        provenance: [{ fieldName: "description", rationale: "wrong field" }],
      }),
    "changed field without provenance",
  );
  const [recordsBefore] = await sql.unsafe<{ total: string; hashes: string }[]>(
    `SELECT count(*)::text AS total,
            coalesce(string_agg(content_hash, ',' ORDER BY id), '')::text AS hashes
     FROM inventory_source_records`,
  );
  const retired = await retireCatalogItem(steward, {
    catalogItemId: added.catalogItemId,
    expectedRowVersion: published.rowVersion,
  });
  const corpusWithout = await withDb((db) => collectCorpus(db, "asset_match"));
  assert.ok(
    !corpusWithout.catalogItemIds.has(added.catalogItemId),
    "retirement removes the item from future recommendations",
  );
  assert.notEqual(corpusWithItem.hash, corpusWithout.hash);
  const [recordsAfter] = await sql.unsafe<{ total: string; hashes: string }[]>(
    `SELECT count(*)::text AS total,
            coalesce(string_agg(content_hash, ',' ORDER BY id), '')::text AS hashes
     FROM inventory_source_records`,
  );
  assert.deepEqual(
    recordsAfter,
    recordsBefore,
    "catalog changes never overwrite imported source records",
  );
  await confirmCatalogItemAccurate(steward, {
    catalogItemId: added.catalogItemId,
    expectedRowVersion: retired.rowVersion,
    reviewDate: "2026-09-04",
  });

  // ── 3. Conflict comparison and resolution with provenance ────────────────
  const referenceConflicts = await sql.unsafe<
    { id: string; state: string; current_evidence_version: number }[]
  >(`SELECT id, state, current_evidence_version FROM inventory_conflicts`);
  const imported = await importFixture(steward);
  assert.equal(imported.imported, true, "architecture fixture imported");
  const [reopened] = await sql.unsafe<
    { id: string; row_version: number; catalog_item_id: string }[]
  >(
    `SELECT id, row_version, catalog_item_id FROM inventory_conflicts
     WHERE state = 'reopened' LIMIT 1`,
  );
  assert.ok(reopened, "the import reopened a conflict");
  const comparison = await getConflictComparison(reopened.id);
  assert.ok(
    comparison.members.length >= 2,
    "conflict shows candidate records side by side",
  );
  assert.ok(
    comparison.members.every((member) => member.sourceName.length > 0),
    "each candidate carries its source",
  );
  const newestMember = comparison.members.at(-1);
  assert.ok(newestMember);
  const [itemRow] = await sql.unsafe<{ row_version: number }[]>(
    `SELECT row_version FROM catalog_items WHERE id = '${reopened.catalog_item_id}'`,
  );
  const resolved = await resolveConflict(steward, {
    conflictId: reopened.id,
    expectedRowVersion: Number(reopened.row_version),
    itemExpectedRowVersion: Number(itemRow.row_version),
    changes: {
      name: (newestMember.normalizedFields as { name?: string }).name ?? "kept",
    },
    provenance: [
      { fieldName: "name", sourceRecordId: newestMember.sourceRecordId },
    ],
  });
  assert.equal(resolved.state, "resolved");
  const [provenanceRow] = await sql.unsafe<{ source_record_id: string }[]>(
    `SELECT source_record_id FROM catalog_field_decisions
     WHERE catalog_item_id = '${reopened.catalog_item_id}'
       AND canonical_version = ${resolved.resolutionVersion}
       AND field_name = 'name'`,
  );
  assert.equal(
    provenanceRow.source_record_id,
    newestMember.sourceRecordId,
    "the canonical field cites the selected source record",
  );
  const [resolvedItemRow] = await sql.unsafe<{ row_version: number }[]>(
    `SELECT row_version FROM catalog_items
     WHERE id = '${reopened.catalog_item_id}'`,
  );
  await expectCode(
    "VALIDATION_FAILED",
    () =>
      reviseCatalogItem(steward, {
        catalogItemId: reopened.catalog_item_id,
        expectedRowVersion: Number(resolvedItemRow.row_version),
        changes: { name: "A Name The Source Never Showed" },
        provenance: [
          {
            fieldName: "name",
            sourceRecordId: newestMember.sourceRecordId,
          },
        ],
      }),
    "source evidence that does not show the stored value, without rationale",
  );
  const aliasRevise = await reviseCatalogItem(steward, {
    catalogItemId: reopened.catalog_item_id,
    expectedRowVersion: Number(resolvedItemRow.row_version),
    changes: { name: "An Alias The Source Never Showed" },
    provenance: [
      {
        fieldName: "name",
        sourceRecordId: newestMember.sourceRecordId,
        rationale: "the source lists this product under an alias",
      },
    ],
  });
  assert.ok(
    aliasRevise.currentVersion > resolved.resolutionVersion,
    "diverging source evidence is usable with a human rationale",
  );
  const branchAbandoned = await reviseCatalogItem(steward, {
    catalogItemId: reopened.catalog_item_id,
    expectedRowVersion: aliasRevise.rowVersion,
    changes: { description: "A description the reset will abandon." },
    provenance: [
      { fieldName: "description", rationale: "pre-reset probe change" },
    ],
  });

  // ── 4. Reset lifecycle ───────────────────────────────────────────────────
  const fixtures = await sql.unsafe<
    { id: string; source_draft_id: string; row_version: number }[]
  >(
    `SELECT r.id, r.source_draft_id, r.row_version FROM requests r
     WHERE r.fixture_key IS NOT NULL AND r.stage = 'under_review'
       AND NOT EXISTS (
         SELECT 1 FROM clarification_requests c
         WHERE c.request_id = r.id AND c.answered_at IS NULL
       )
     ORDER BY r.display_id LIMIT 2`,
  );
  assert.equal(fixtures.length, 2, "two clean under-review fixtures exist");
  const [fixtureOne, fixtureTwo] = fixtures;

  // Approvable evidence for fixtureOne: succeeded assessments against the
  // fixture-era content (no revision), matching the restored reference state.
  await sql.unsafe(`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin)
    VALUES ('${randomUUID()}', '${fixtureOne.source_draft_id}', 'succeeded',
      '${await currentCorpusHash("asset_match")}', 'live')
  `);
  await sql.unsafe(`
    INSERT INTO risk_assessments
      (id, draft_id, status, policy_corpus_hash, origin)
    VALUES ('${randomUUID()}', '${fixtureOne.source_draft_id}', 'succeeded',
      '${await currentCorpusHash("risk_assess")}', 'live')
  `);

  async function driveToResolution(requestId: string): Promise<void> {
    let state = await getReviewState(requestId);
    const outcome = await recordAssetOutcome(reviewer, {
      requestId,
      outcome: "no_match",
      expectedRowVersion: state.rowVersion,
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
    const completed = await completeFirstReview(reviewer, {
      requestId,
      rating: 4,
      idempotencyKey: randomUUID(),
      targetSystem: "servicenow",
      workPlan: [],
      expectedRowVersion: routed.rowVersion,
    });
    await executeHandoff(reviewer, { requestId });
    await resolveRequest(reviewer, {
      requestId,
      outcome: "fulfilled_reuse",
      summary: "Fulfilled with the existing shared service.",
      expectedRowVersion: completed.rowVersion,
    });
    state = await getReviewState(requestId);
    assert.equal(state.stage, "first_review_completed");
  }
  await driveToResolution(fixtureOne.id);

  const askedOnTwo = await askClarification(reviewer, {
    requestId: fixtureTwo.id,
    expectedRowVersion: await (async () =>
      (
        await sql.unsafe<{ v: number }[]>(
          `SELECT row_version AS v FROM requests WHERE id = '${fixtureTwo.id}'`,
        )
      )[0].v)(),
    question: "Which office owns the upstream data feed?",
  });
  assert.ok(askedOnTwo.clarificationId);

  // Live visitor work that reset must preserve untouched.
  const livVisitor = await createVisitor();
  const liveDraft = await saveDraft(livVisitor, {
    organizationId: organization.id,
    rawNeed: "A live request that reset must never touch.",
    content: {
      title: "Live request untouched by reset",
      problem: "The live problem statement.",
      affectedPeople: "Live staff",
      acceptanceCriteria: ["Reset preserves this request"],
      requirements: [],
      constraints: [],
      unknowns: [],
    },
    state: "ready",
  });
  const liveSubmitted = await submitRequest(livVisitor, {
    draftId: liveDraft.draftId,
    expectedRowVersion: liveDraft.rowVersion,
    rating: 5,
    idempotencyKey: randomUUID(),
  });
  await sql.unsafe(`
    INSERT INTO wip (id, visitor_id, acting_view, page_key, subject_key, payload)
    SELECT '${randomUUID()}', v.id, 'requester', 'reset-probe', 'subject', '{"kept":true}'
    FROM visitors v WHERE v.id = '${livVisitor.visitorId}'
  `);

  // A leased model job on a fixture subject, as a crashed worker leaves it.
  const fixtureJobId = randomUUID();
  const fixtureCallId = randomUUID();
  await sql.unsafe(`
    INSERT INTO model_jobs
      (id, purpose, draft_id, request_id, visitor_id, input_hash, corpus_hash,
       prompt_version, status, attempt_count, lease_owner, lease_token,
       lease_expires_at, current_model_call_id)
    VALUES ('${fixtureJobId}', 'risk_assess', '${fixtureTwo.source_draft_id}',
      '${fixtureTwo.id}', '${livVisitor.visitorId}', repeat('a', 64),
      repeat('b', 64), 'risk-v1', 'leased', 1, 'crashed-worker',
      '${randomUUID()}', now() + interval '2 minutes', NULL)
  `);
  await sql.unsafe(`
    INSERT INTO model_calls
      (id, draft_id, visitor_id, purpose, provider, model, prompt_version,
       input_hash, corpus_versions, status, attempt_count,
       reserved_cost_micros, idempotency_key, origin)
    VALUES ('${fixtureCallId}', '${fixtureTwo.source_draft_id}',
      '${livVisitor.visitorId}', 'risk_assess', 'anthropic', 'claude-sonnet-5',
      'risk-v1', repeat('a', 64), '{}', 'reserved', 1, 2500,
      '${randomUUID()}', 'live')
  `);
  await sql.unsafe(
    `UPDATE model_jobs SET current_model_call_id = '${fixtureCallId}'
     WHERE id = '${fixtureJobId}'`,
  );

  const preserved = async () =>
    (
      await sql.unsafe<Record<string, string>[]>(`
        SELECT
          (SELECT count(*) FROM task_completions)::text AS completions,
          (SELECT count(*) FROM request_resolutions)::text AS resolutions,
          (SELECT count(*) FROM delivery_handoffs)::text AS handoffs,
          (SELECT count(*) FROM clarification_requests)::text AS clarifications,
          (SELECT count(*) FROM model_calls)::text AS calls,
          (SELECT count(*) FROM wip)::text AS wip,
          (SELECT count(*) FROM inventory_source_records)::text AS records,
          (SELECT count(*) FROM requests WHERE fixture_key IS NULL)::text AS live_requests
      `)
    )[0];
  const beforeReset = await preserved();

  const refusal = await runScript("db-reset-fixtures.ts", url);
  assert.notEqual(refusal.code, 0, "reset without the confirm flag refuses");
  const firstReset = await runScript("db-reset-fixtures.ts", url, [
    "--confirm-fixture-reset",
  ]);
  assert.equal(firstReset.code, 0, "first reset succeeds");

  const afterReset = await preserved();
  assert.deepEqual(
    afterReset,
    beforeReset,
    "reset deletes nothing: completions, resolutions, spend, WIP, evidence stay",
  );

  const [fixtureOneRow] = await sql.unsafe<
    { stage: string; fixture_generation: number; next_owner: string | null }[]
  >(
    `SELECT stage, fixture_generation, next_owner FROM requests
     WHERE id = '${fixtureOne.id}'`,
  );
  assert.equal(fixtureOneRow.stage, "under_review", "stage restored");
  assert.equal(Number(fixtureOneRow.fixture_generation), 2, "generation moved");
  assert.equal(fixtureOneRow.next_owner, null, "routing restored");
  const deliveryAfterReset = await getDeliveryState(fixtureOne.id);
  assert.equal(
    deliveryAfterReset.handoff,
    null,
    "the preserved old handoff no longer binds the restored scenario",
  );
  assert.equal(deliveryAfterReset.resolution, null);

  const recordTwo = await getRequestRecord(fixtureTwo.id);
  assert.equal(
    recordTwo.waitingOnRequester,
    false,
    "the preserved open question no longer blocks the restored fixture",
  );
  const [jobRow] = await sql.unsafe<
    { status: string; lease_owner: string | null }[]
  >(`SELECT status, lease_owner FROM model_jobs WHERE id = '${fixtureJobId}'`);
  assert.equal(jobRow.status, "superseded", "fixture-linked job superseded");
  assert.equal(jobRow.lease_owner, null);
  const [callRow] = await sql.unsafe<
    {
      status: string;
      sanitized_error: string;
      reserved_cost_micros: number;
      actual_cost_micros: number | null;
    }[]
  >(`SELECT status, sanitized_error, reserved_cost_micros, actual_cost_micros
     FROM model_calls WHERE id = '${fixtureCallId}'`);
  assert.equal(callRow.status, "failed", "interrupted reservation reconciled");
  assert.equal(callRow.sanitized_error, "fixture_reset_superseded");
  assert.equal(Number(callRow.reserved_cost_micros), 2500);
  assert.equal(callRow.actual_cost_micros, null, "spend stays charged");

  const [liveAfter] = await sql.unsafe<{ stage: string; total: string }[]>(
    `SELECT (SELECT stage FROM requests WHERE id = '${liveSubmitted.requestId}') AS stage,
            (SELECT count(*) FROM wip)::text AS total`,
  );
  assert.equal(liveAfter.stage, "submitted", "live request untouched");

  const [restoredItem] = await sql.unsafe<
    { current_version: number; state: string }[]
  >(
    `SELECT current_version, publication_state AS state FROM catalog_items
     WHERE id = '${reopened.catalog_item_id}'`,
  );
  const [conflictAfter] = await sql.unsafe<
    { state: string; current_evidence_version: number }[]
  >(
    `SELECT state, current_evidence_version FROM inventory_conflicts
     WHERE id = '${reopened.id}'`,
  );
  const conflictReference = referenceConflicts.find(
    (row) => row.id === reopened.id,
  );
  assert.ok(conflictReference);
  assert.equal(
    conflictAfter.state,
    conflictReference.state,
    "conflict state restored to the reference value",
  );
  assert.equal(
    Number(conflictAfter.current_evidence_version),
    Number(conflictReference.current_evidence_version),
    "conflict evidence pointer restored while imported records remain",
  );
  assert.ok(restoredItem, "fixture catalog item restored to reference");
  const [liveItemAfter] = await sql.unsafe<{ state: string }[]>(
    `SELECT publication_state AS state FROM catalog_items
     WHERE id = '${added.catalogItemId}'`,
  );
  assert.equal(
    liveItemAfter.state,
    "retired",
    "the steward's live item is not a fixture and stays as they left it",
  );

  // Version numbering survives the reset: the restored item can revise the
  // same field again, continuing past the preserved immutable decisions, and
  // current provenance follows the restored value, not the abandoned version.
  const [restoredItemRow] = await sql.unsafe<
    { current_version: number; row_version: number }[]
  >(
    `SELECT current_version, row_version FROM catalog_items
     WHERE id = '${reopened.catalog_item_id}'`,
  );
  const restoredRecord = await getCatalogItemRecord(reopened.catalog_item_id);
  assert.ok(
    restoredRecord.currentDecisions.every(
      (decision) =>
        decision.canonicalVersion <= Number(restoredItemRow.current_version),
    ),
    "current provenance never cites a version the reset abandoned",
  );
  const revisedAgain = await reviseCatalogItem(steward, {
    catalogItemId: reopened.catalog_item_id,
    expectedRowVersion: Number(restoredItemRow.row_version),
    changes: { name: "Renamed After Reset" },
    provenance: [
      { fieldName: "name", rationale: "Steward correction after reset" },
    ],
  });
  assert.ok(
    revisedAgain.currentVersion > resolved.resolutionVersion,
    "the new version continues past every preserved decision",
  );
  const lineageRecord = await getCatalogItemRecord(reopened.catalog_item_id);
  const currentName = lineageRecord.currentDecisions.find(
    (decision) => decision.fieldName === "name",
  );
  assert.equal(
    currentName?.canonicalVersion,
    revisedAgain.currentVersion,
    "current provenance follows the newly stored value",
  );

  // The exact branch: v-description changed pre-reset, reset restored the
  // reference, then a name-only revision. The untouched description's
  // current evidence must be the carried reference decision, not the
  // abandoned one, with its original author and time preserved.
  const currentDescription = lineageRecord.currentDecisions.find(
    (decision) => decision.fieldName === "description",
  );
  assert.ok(currentDescription, "description keeps current evidence");
  const [storedBranchItem] = await sql.unsafe<
    { description: string; approval_status: string }[]
  >(
    `SELECT description, approval_status FROM catalog_items
     WHERE id = '${reopened.catalog_item_id}'`,
  );
  assert.equal(
    currentDescription.value,
    storedBranchItem.description,
    "current evidence shows the restored stored value",
  );
  assert.notEqual(
    currentDescription.value,
    "A description the reset will abandon.",
    "the abandoned revision is not the current evidence",
  );
  assert.equal(
    currentDescription.canonicalVersion,
    revisedAgain.currentVersion,
    "unchanged evidence is carried into the new snapshot",
  );
  const [referenceDescription] = await sql.unsafe<
    { id: string; decided_by_actor_id: string; created_at: string }[]
  >(
    `SELECT id, decided_by_actor_id, created_at FROM catalog_field_decisions
     WHERE catalog_item_id = '${reopened.catalog_item_id}'
       AND field_name = 'description' AND canonical_version = 1`,
  );
  assert.equal(
    currentDescription.supersedesId,
    referenceDescription.id,
    "the carried copy chains to the reference decision",
  );
  assert.equal(
    currentDescription.decidedByActorId,
    referenceDescription.decided_by_actor_id,
    "original author preserved on carried evidence",
  );
  assert.equal(
    Date.parse(currentDescription.createdAt),
    Date.parse(referenceDescription.created_at),
    "original decision time preserved on carried evidence",
  );
  assert.ok(
    lineageRecord.decisions.some(
      (decision) =>
        decision.fieldName === "description" &&
        decision.canonicalVersion === branchAbandoned.currentVersion,
    ),
    "the abandoned decision stays in the immutable history",
  );

  // Publication reads the carried lineage, so the abandoned branch cannot
  // falsely fail the gate.
  let branchRowVersion = revisedAgain.rowVersion;
  if (storedBranchItem.approval_status !== "approved") {
    const branchApproved = await reviseCatalogItem(steward, {
      catalogItemId: reopened.catalog_item_id,
      expectedRowVersion: branchRowVersion,
      changes: { approvalStatus: "approved" },
      provenance: [
        { fieldName: "approvalStatus", rationale: "review sign-off" },
      ],
    });
    branchRowVersion = branchApproved.rowVersion;
  }
  const branchPublished = await publishCatalogItem(steward, {
    catalogItemId: reopened.catalog_item_id,
    expectedRowVersion: branchRowVersion,
  });
  assert.equal(branchPublished.publicationState, "published");

  // The restored fixture replays: preparation happens anew in the current
  // generation, the same journey completes again, and no evidence from the
  // first pass was lost.
  const [generationNow] = await sql.unsafe<{ fixture_generation: number }[]>(
    `SELECT fixture_generation FROM requests WHERE id = '${fixtureOne.id}'`,
  );
  await sql.unsafe(`
    INSERT INTO asset_assessments
      (id, draft_id, status, catalog_corpus_hash, origin, request_generation)
    VALUES ('${randomUUID()}', '${fixtureOne.source_draft_id}', 'succeeded',
      '${await currentCorpusHash("asset_match")}', 'live', ${Number(generationNow.fixture_generation)})
  `);
  await sql.unsafe(`
    INSERT INTO risk_assessments
      (id, draft_id, status, policy_corpus_hash, origin, request_generation)
    VALUES ('${randomUUID()}', '${fixtureOne.source_draft_id}', 'succeeded',
      '${await currentCorpusHash("risk_assess")}', 'live', ${Number(generationNow.fixture_generation)})
  `);
  await driveToResolution(fixtureOne.id);
  const [generationRows] = await sql.unsafe<
    { completions: string; resolutions: string }[]
  >(`
    SELECT
      (SELECT count(*) FROM task_completions
        WHERE request_id = '${fixtureOne.id}'
          AND task_type = 'contributor_first_review')::text AS completions,
      (SELECT count(*) FROM request_resolutions
        WHERE request_id = '${fixtureOne.id}')::text AS resolutions
  `);
  assert.deepEqual(
    generationRows,
    { completions: "2", resolutions: "2" },
    "both generations' milestones and outcomes remain",
  );

  // Import evidence replays as a no-op after reset.
  const replay = await importFixture(steward);
  assert.equal(replay.imported, false, "matching import replays as a no-op");

  // Second reset through the domain action; third reset advances nothing.
  const second = await resetFixtures(reviewer);
  assert.ok(second.advancedGenerations >= 1, "second reset frees fixtureOne");
  const generationsBeforeThird = await sql.unsafe<
    { id: string; fixture_generation: number }[]
  >(
    `SELECT id, fixture_generation FROM requests
     WHERE fixture_key IS NOT NULL ORDER BY id`,
  );
  const third = await resetFixtures(reviewer);
  assert.equal(
    third.advancedGenerations,
    0,
    "a reset without new live activity advances no generation",
  );
  const generationsAfterThird = await sql.unsafe<
    { id: string; fixture_generation: number }[]
  >(
    `SELECT id, fixture_generation FROM requests
     WHERE fixture_key IS NOT NULL ORDER BY id`,
  );
  assert.deepEqual(generationsAfterThird, generationsBeforeThird);

  console.log(
    [
      "Catalog and reset checks passed:",
      "  sources register, edit, retire; history reads; versions enforced",
      "  items author with complete material provenance recording stored values; impossible dates rejected",
      "  publishing requires approval and current provenance matching every stored material value",
      "  cited source evidence must show the stored value unless a human rationale explains it",
      "  version numbering and current lineage survive reset; unchanged evidence carries forward with its original author and time while abandoned versions stay history",
      "  retirement removes eligibility without touching source records",
      "  conflicts compare candidates side by side and resolve into a new provenanced canonical version",
      "  reset preserves every live row, frees stranded fixtures by generation, supersedes fixture model jobs with reservations reconciled, and replays imports as no-ops",
      "  reset twice restores the same reference; a third reset advances nothing",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
