import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import {
  actors,
  auditEvents,
  requestContentRevisions,
  taskCompletions,
  modelCalls,
  assetAssessments,
  assetCandidates,
  assetCandidateDecisions,
  catalogItems,
  riskAssessments,
  riskFindings,
  riskFindingDecisions,
  policyRules,
} from "../db/schema.ts";
import { administratorNoteEvent } from "../domain/constants.ts";
import type { AdministratorNote } from "../workflow/admin.ts";
import type { Tx } from "../workflow/shared.ts";

export async function recordEvidence(
  tx: Tx,
  requestId: string,
  draftId: string,
) {
  const [events, revisions, ratings, calls, assetDecisions, riskDecisions] =
    await Promise.all([
      tx
        .select({ event: auditEvents, actorName: actors.displayName })
        .from(auditEvents)
        .leftJoin(actors, eq(actors.id, auditEvents.actorId))
        .where(
          and(
            or(
              and(
                eq(auditEvents.subjectType, "request"),
                eq(auditEvents.subjectId, requestId),
              ),
              and(
                eq(auditEvents.subjectType, "draft"),
                eq(auditEvents.subjectId, draftId),
              ),
            ),
            // Administrator notes surface only through administratorNotes(),
            // which the reviewer view gates to internal viewers.
            ne(auditEvents.eventType, administratorNoteEvent),
          ),
        )
        .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id)),
      tx
        .select({
          revision: requestContentRevisions,
          actorName: actors.displayName,
        })
        .from(requestContentRevisions)
        .innerJoin(
          actors,
          eq(actors.id, requestContentRevisions.authoredByActorId),
        )
        .where(eq(requestContentRevisions.requestId, requestId))
        .orderBy(asc(requestContentRevisions.revisionNumber)),
      tx
        .select({ completion: taskCompletions, actorName: actors.displayName })
        .from(taskCompletions)
        .innerJoin(actors, eq(actors.id, taskCompletions.actorId))
        .where(eq(taskCompletions.requestId, requestId))
        .orderBy(asc(taskCompletions.completedAt)),
      tx
        .select()
        .from(modelCalls)
        .where(eq(modelCalls.draftId, draftId))
        .orderBy(asc(modelCalls.createdAt), asc(modelCalls.id)),
      assetEvidence(tx, draftId),
      riskEvidence(tx, draftId),
    ]);
  return { events, revisions, ratings, calls, assetDecisions, riskDecisions };
}

function assetEvidence(tx: Tx, draftId: string) {
  return tx
    .select({
      decision: assetCandidateDecisions,
      proposal: assetCandidates,
      name: sql<string>`coalesce(${assetCandidates.name}, ${catalogItems.name})`,
      actorName: actors.displayName,
      revisionId: assetAssessments.revisionId,
    })
    .from(assetCandidateDecisions)
    .innerJoin(
      assetCandidates,
      eq(assetCandidates.id, assetCandidateDecisions.candidateId),
    )
    .innerJoin(
      assetAssessments,
      eq(assetAssessments.id, assetCandidates.assessmentId),
    )
    .innerJoin(catalogItems, eq(catalogItems.id, assetCandidates.catalogItemId))
    .innerJoin(actors, eq(actors.id, assetCandidateDecisions.actorId))
    .where(eq(assetAssessments.draftId, draftId))
    .orderBy(
      asc(assetCandidateDecisions.createdAt),
      asc(assetCandidateDecisions.id),
    );
}

function riskEvidence(tx: Tx, draftId: string) {
  return tx
    .select({
      decision: riskFindingDecisions,
      finding: riskFindings,
      rule: policyRules,
      actorName: actors.displayName,
      revisionId: riskAssessments.revisionId,
    })
    .from(riskFindingDecisions)
    .innerJoin(
      riskFindings,
      eq(riskFindings.id, riskFindingDecisions.findingId),
    )
    .innerJoin(
      riskAssessments,
      eq(riskAssessments.id, riskFindings.assessmentId),
    )
    .innerJoin(policyRules, eq(policyRules.id, riskFindings.policyRuleId))
    .innerJoin(actors, eq(actors.id, riskFindingDecisions.actorId))
    .where(eq(riskAssessments.draftId, draftId))
    .orderBy(asc(riskFindingDecisions.createdAt), asc(riskFindingDecisions.id));
}

export type RecordEvidence = Awaited<ReturnType<typeof recordEvidence>>;

/**
 * Administrator notes for a request, oldest first. The reviewer request view
 * includes these for internal viewers only; the requester's own view never
 * receives them.
 */
export async function administratorNotes(
  tx: Tx,
  requestId: string,
): Promise<AdministratorNote[]> {
  const rows = await tx
    .select({
      id: auditEvents.id,
      body: sql<string>`${auditEvents.payload} ->> 'body'`,
      authorName: actors.displayName,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .leftJoin(actors, eq(actors.id, auditEvents.actorId))
    .where(
      and(
        eq(auditEvents.subjectType, "request"),
        eq(auditEvents.subjectId, requestId),
        eq(auditEvents.eventType, administratorNoteEvent),
      ),
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
  return rows.map((row) => ({
    id: row.id,
    authorName: row.authorName ?? "",
    body: row.body ?? "",
    createdAt: row.createdAt,
  }));
}
