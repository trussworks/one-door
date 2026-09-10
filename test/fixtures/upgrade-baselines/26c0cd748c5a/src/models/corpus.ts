import { and, asc, eq, isNotNull } from "drizzle-orm";

import {
  catalogItems,
  clarificationRequests,
  drafts,
  draftTurns,
  policyRules,
  requests,
  serviceOfferings,
  serviceCandidates,
  modelJobs,
} from "../db/schema.ts";
import { WorkflowError } from "../workflow/errors.ts";
import {
  contentFromRequestRow,
  requestContentSchema,
  type Db,
  type Tx,
} from "../workflow/shared.ts";
import { canonicalJson, sha256Hex, type ModelPurpose } from "./contracts.ts";

type Reader = Db | Tx;

export interface CorpusSnapshot {
  /** Full records supplied to the model as data. */
  detail: unknown[];
  /** Identifiers a valid result may cite; anything else is a bad output. */
  eligibleIds: Set<string>;
  /** Secondary keys a valid result may cite (offering keys for intake). */
  eligibleKeys: Set<string>;
  /**
   * Catalog item ids a combined intake result may cite as assets. The
   * intake purpose carries both corpora; other purposes leave this empty.
   */
  eligibleAssetIds: Set<string>;
  /** Catalog item id → current version, for candidate source references. */
  versionsById: Map<string, number>;
  hash: string;
  /** Stored on the model call as provenance. */
  corpusVersions: Record<string, unknown>;
}

/** Exported so the seed computes fixture hashes with this exact formula. */
export function corpusHash(pairs: Array<[string, string | number]>): string {
  const lines = pairs
    .map(([id, version]) => `${id}:${version}`)
    .sort()
    .join("\n");
  return sha256Hex(lines);
}

/**
 * Collect the eligible corpus for a purpose. Deterministic: the hash covers
 * every member's identity and version, so any membership or version change
 * produces a different corpus.
 */
async function offeringCorpus(db: Reader): Promise<CorpusSnapshot> {
  const rows = await db
    .select()
    .from(serviceOfferings)
    .where(eq(serviceOfferings.lifecycle, "active"))
    .orderBy(asc(serviceOfferings.id));
  const hash = corpusHash(rows.map((row) => [row.id, row.contentHash]));
  return {
    detail: rows.map((row) => ({
      offeringId: row.id,
      offeringKey: row.offeringKey,
      name: row.name,
      description: row.description,
      capabilities: row.capabilities,
      prerequisites: row.prerequisites,
    })),
    eligibleIds: new Set(rows.map((row) => row.id)),
    eligibleKeys: new Set(rows.map((row) => row.offeringKey)),
    eligibleAssetIds: new Set(),
    versionsById: new Map(),
    hash,
    corpusVersions: { serviceOfferings: hash, count: rows.length },
  };
}

/** Published, approved catalog rows: the eligible existing-asset corpus. */
async function catalogRows(db: Reader) {
  return db
    .select()
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.publicationState, "published"),
        eq(catalogItems.approvalStatus, "approved"),
      ),
    )
    .orderBy(asc(catalogItems.id));
}

function catalogDetail(rows: Awaited<ReturnType<typeof catalogRows>>) {
  return rows.map((row) => ({
    catalogItemId: row.id,
    itemKey: row.itemKey,
    name: row.name,
    description: row.description,
    itemType: row.itemType,
    capabilities: row.capabilities,
    dataClassifications: row.dataClassifications,
    integrations: row.integrations,
    version: row.currentVersion,
  }));
}

/**
 * The combined intake corpus: active service offerings plus the eligible
 * catalog, because one intake call evaluates both. The hash covers every
 * member of both corpora, so a change in either invalidates the cache line.
 */
async function intakeCorpus(db: Reader): Promise<CorpusSnapshot> {
  const offerings = await offeringCorpus(db);
  const catalog = await catalogRows(db);
  const catalogHash = corpusHash(
    catalog.map((row) => [row.id, row.currentVersion]),
  );
  return {
    detail: [...offerings.detail, ...catalogDetail(catalog)],
    eligibleIds: offerings.eligibleIds,
    eligibleKeys: offerings.eligibleKeys,
    eligibleAssetIds: new Set(catalog.map((row) => row.id)),
    versionsById: new Map(catalog.map((row) => [row.id, row.currentVersion])),
    hash: sha256Hex(offerings.hash + catalogHash),
    corpusVersions: {
      serviceOfferings: offerings.hash,
      catalogItems: catalogHash,
      count: offerings.detail.length + catalog.length,
    },
  };
}

export async function collectCorpus(
  db: Reader,
  purpose: ModelPurpose,
): Promise<CorpusSnapshot> {
  if (purpose === "intake_interpret") return intakeCorpus(db);
  if (purpose === "asset_match") {
    const rows = await catalogRows(db);
    const hash = corpusHash(rows.map((row) => [row.id, row.currentVersion]));
    return {
      detail: catalogDetail(rows),
      eligibleIds: new Set(rows.map((row) => row.id)),
      eligibleKeys: new Set(),
      eligibleAssetIds: new Set(),
      versionsById: new Map(rows.map((row) => [row.id, row.currentVersion])),
      hash,
      corpusVersions: { catalogItems: hash, count: rows.length },
    };
  }
  const rows = await db
    .select()
    .from(policyRules)
    .where(eq(policyRules.lifecycle, "active"))
    .orderBy(asc(policyRules.id));
  const hash = corpusHash(rows.map((row) => [row.id, row.contentHash]));
  return {
    detail: rows.map((row) => ({
      policyRuleId: row.id,
      code: row.code,
      domain: row.domain,
      title: row.title,
      rule: row.rule,
      triggerTerms: row.triggerTerms,
      defaultSeverity: row.defaultSeverity,
      citation: row.citation,
    })),
    eligibleIds: new Set(rows.map((row) => row.id)),
    eligibleKeys: new Set(),
    eligibleAssetIds: new Set(),
    versionsById: new Map(),
    hash,
    corpusVersions: { policyRules: hash, count: rows.length },
  };
}

/**
 * Both corpus hashes in one batched read: the single freshness rule is a
 * plain equality against the stored assessment hash, and every consumer
 * (approval blockers, read models) compares against the same pair.
 */
export async function currentCorpusHashes(
  db: Reader,
): Promise<{ asset: string; risk: string }> {
  const [asset, risk] = await Promise.all([
    collectCorpus(db, "asset_match"),
    collectCorpus(db, "risk_assess"),
  ]);
  return { asset: asset.hash, risk: risk.hash };
}

export interface EffectiveInput {
  payload: Record<string, unknown>;
  hash: string;
  revisionId: string | null;
  visitorId: string | null;
  requestId: string | null;
  /** The fixture generation the input belongs to; 1 for draft-only input. */
  requestGeneration: number;
}

/** Draft content normalized so an unchanged submission hashes identically. */
function normalizedContent(structured: Record<string, unknown>): unknown {
  const parsed = requestContentSchema.safeParse(structured);
  return parsed.success ? parsed.data : structured;
}

/**
 * The content a model job answers about. For a submitted request this is the
 * current revision's content, answered intake questions, and current-generation
 * reviewer clarifications. Answers belong in the input even when no structured
 * field changed. Draft assessments also receive answered intake questions;
 * the intake purpose additionally receives the requester's original words.
 */
export async function effectiveInput(
  db: Reader,
  purpose: ModelPurpose,
  draftId: string,
  requestId?: string,
): Promise<EffectiveInput> {
  const [draft] = await db
    .select()
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .limit(1);
  if (!draft) throw new WorkflowError("NOT_FOUND", "draft");
  const feedback =
    purpose === "intake_interpret" ? [] : await serviceFeedback(db, draftId);
  const feedbackFields = feedback.length ? { serviceFeedback: feedback } : {};

  if (!requestId) {
    const payload: Record<string, unknown> = {
      content: normalizedContent(draft.structuredContent),
      clarifications: [],
      ...feedbackFields,
    };
    Object.assign(
      payload,
      intakeFacts(purpose, draft.rawNeed, await intakeTurns(db, draftId)),
    );
    return {
      payload,
      hash: sha256Hex(canonicalJson(payload)),
      revisionId: null,
      visitorId: draft.visitorId,
      requestId: null,
      requestGeneration: 1,
    };
  }

  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);
  if (!request) throw new WorkflowError("NOT_FOUND", "request");
  if (request.sourceDraftId !== draftId)
    throw new WorkflowError("VALIDATION_FAILED", "request not from this draft");

  // Answers from an earlier fixture generation are preserved evidence, not
  // part of the restored scenario's effective input.
  const answered = await db
    .select({
      question: clarificationRequests.question,
      answer: clarificationRequests.answer,
    })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.requestId, requestId),
        eq(clarificationRequests.requestGeneration, request.fixtureGeneration),
        isNotNull(clarificationRequests.answeredAt),
      ),
    )
    .orderBy(asc(clarificationRequests.askedAt), asc(clarificationRequests.id));
  const payload: Record<string, unknown> = {
    content: contentFromRequestRow(request),
    clarifications: answered,
    ...feedbackFields,
  };
  Object.assign(
    payload,
    intakeFacts(purpose, draft.rawNeed, await intakeTurns(db, draftId)),
  );
  return {
    payload,
    hash: sha256Hex(canonicalJson(payload)),
    revisionId: request.currentRevisionId,
    visitorId: draft.visitorId ?? request.ownerVisitorId,
    requestId,
    requestGeneration: request.fixtureGeneration,
  };
}

async function serviceFeedback(db: Reader, draftId: string) {
  return db
    .select({
      service: serviceOfferings.name,
      reason: serviceCandidates.decisionReason,
    })
    .from(drafts)
    .innerJoin(modelJobs, eq(modelJobs.id, drafts.confirmedIntakeJobId))
    .innerJoin(
      serviceCandidates,
      and(
        eq(serviceCandidates.draftId, drafts.id),
        eq(serviceCandidates.modelCallId, modelJobs.currentModelCallId),
      ),
    )
    .innerJoin(
      serviceOfferings,
      eq(serviceOfferings.id, serviceCandidates.offeringId),
    )
    .where(
      and(
        eq(drafts.id, draftId),
        eq(serviceCandidates.decision, "rejected"),
        isNotNull(serviceCandidates.decisionReason),
      ),
    )
    .orderBy(asc(serviceCandidates.id));
}

/**
 * Intake sees the raw words and the whole conversation. Asset and risk
 * preparation see the conversation only when an answer exists — answered
 * intake questions are the requester's facts, and a late answer is exactly
 * what invalidates the reuse evidence. The key is omitted when no answer
 * exists, so an answerless request keeps its input hash and cached results.
 */
function intakeFacts(
  purpose: ModelPurpose,
  rawNeed: string,
  turns: Array<{ question: string; answer: string }>,
): Record<string, unknown> {
  if (purpose === "intake_interpret") return { rawNeed, turns };
  return turns.length ? { turns } : {};
}

/**
 * The cumulative intake conversation as answered exchanges only. Unanswered
 * generated questions stay out of the effective input, so persisting a
 * question does not invalidate the job that produced it; an answer is what
 * changes the input.
 */
async function intakeTurns(
  db: Reader,
  draftId: string,
): Promise<Array<{ question: string; answer: string }>> {
  const turns = await db
    .select({
      id: draftTurns.id,
      content: draftTurns.content,
      replyToTurnId: draftTurns.replyToTurnId,
    })
    .from(draftTurns)
    .where(eq(draftTurns.draftId, draftId))
    .orderBy(asc(draftTurns.ordinal));
  const byId = new Map(turns.map((turn) => [turn.id, turn.content]));
  return turns
    .filter((turn) => turn.replyToTurnId !== null)
    .map((turn) => ({
      question: byId.get(turn.replyToTurnId as string) ?? "",
      answer: turn.content,
    }));
}

/** The single user-turn text sent to the provider: need plus corpus, as data. */
export function buildProviderInput(
  payload: Record<string, unknown>,
  corpus: CorpusSnapshot,
): string {
  return canonicalJson({ need: payload, records: corpus.detail });
}
