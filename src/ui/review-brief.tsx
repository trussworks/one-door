"use client";

import styles from "./review-brief.module.css";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Button, Label, Select } from "@trussworks/react-uswds";
import type { RequestView } from "../server/request-views";
import type { ApprovalBlocker } from "../workflow/review";
import type { RecordProps } from "./record-form";
import { firstReviewOpen, useRecordForm } from "./record-form";
import { useApp } from "./shell";
import { Field, Problem, SavedWorkFieldset } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { useSavedWork } from "./use-saved-work";
import { RequestSummary } from "./request-summary";
import { formatScore } from "./status-labels";
import {
  Preparation,
  RequesterConcerns,
  ReviewAssignments,
  EvidenceList,
} from "./review-decisions";
import { HandoffFields, deliveryPlanValues, workPlan } from "./review-delivery";
import { TaskRating, RatingErrorSummary } from "./rating-presentation";
import { CatalogueView } from "./review-catalogue";
import {
  AskForInput,
  EarlierPriorityForm,
  InputRequests,
  PriorityFactors,
  SavedWorkProblem,
  priorityDecisionsFromDrafts,
} from "./priority-contributions";
import {
  SUBMIT_ASSESSMENT_ACTION,
  inputRequestsOf,
  priorityOf,
  type ReviewInputRow,
} from "./review-input-contracts";
import type { PriorityDecisionInput, PriorityView } from "../domain/priority";

export type ClaimTone =
  "proposed" | "draft" | "waiting" | "confirmed" | "ruled_out";

const toneClass: Record<ClaimTone, string> = {
  proposed: styles.stProposed,
  draft: styles.stDraft,
  waiting: styles.stWaiting,
  confirmed: styles.stConfirmed,
  ruled_out: styles.stRuledOut,
};

type DraftValues = Record<string, string>;

/** Minimal shapes of the recorded rows the drafts compare against. */
export type FitRecord = {
  id: string;
  decision: string | null;
  reason: string | null;
};
export type RiskRecord = {
  id: string;
  decision: string | null;
  finalSeverity: string | null;
  decisionRationale: string | null;
};

/** A draft counts as changed when any meaningful field differs from the
 * recorded row — decision, reason, or an override's severity — so a
 * same-decision edit is never silently dropped. Clearing a recorded choice
 * counts as an incomplete change, never as no change. */
export function fitDraftChanged(
  draft: DraftValues,
  recorded: FitRecord,
): boolean {
  const decision = draft.decision ?? "";
  if (decision !== (recorded.decision ?? "")) return true;
  if (!decision) return false;
  return (draft.reason ?? "").trim() !== (recorded.reason ?? "").trim();
}

export function riskDraftChanged(
  draft: DraftValues,
  recorded: RiskRecord,
): boolean {
  const decision = draft.decision ?? "";
  if (decision !== (recorded.decision ?? "")) return true;
  if (!decision) return false;
  if (severityChanged(decision, draft, recorded)) return true;
  return (
    (draft.rationale ?? "").trim() !== (recorded.decisionRationale ?? "").trim()
  );
}

function severityChanged(
  decision: string,
  draft: DraftValues,
  recorded: RiskRecord,
): boolean {
  if (decision !== "overridden") return false;
  return (draft.severity ?? "") !== (recorded.finalSeverity ?? "");
}

export function fitDraftMissing(draft: DraftValues): string | null {
  if (!draft.decision) return "Draft: choose a decision";
  if (draft.decision === "rejected" && !draft.reason?.trim())
    return "Draft: give a reason for rejection";
  return null;
}

export function riskDraftMissing(draft: DraftValues): string | null {
  if (!draft.decision) return "Draft: choose a decision";
  if (draft.decision === "overridden" && !draft.severity)
    return "Draft: choose a severity";
  if (draft.decision !== "confirmed" && !draft.rationale?.trim())
    return "Draft: give a reason";
  return null;
}

/** The marker names the object's fate, and a draft names the outcome it
 * would record — "draft — ruled out", never a bare "saved". A recorded
 * rejection is as final as a recorded acceptance. */
export function fitClaimStatus(
  recorded: FitRecord,
  draft: DraftValues | null,
): { label: string; tone: ClaimTone } {
  if (draft && fitDraftChanged(draft, recorded)) {
    const missing = fitDraftMissing(draft);
    if (missing) return { label: missing, tone: "draft" };
    /* A complete draft scans in its outcome's colour; the word "draft"
     * keeps it distinct from a recorded judgment. */
    return draft.decision === "accepted"
      ? { label: "Draft: accepted", tone: "confirmed" }
      : { label: "Draft: rejected", tone: "ruled_out" };
  }
  if (recorded.decision === "accepted")
    return { label: "Accepted", tone: "confirmed" };
  if (recorded.decision === "rejected")
    return { label: "Rejected", tone: "ruled_out" };
  return { label: "Awaiting decision", tone: "proposed" };
}

function riskOutcomeWords(decision: string): string {
  if (decision === "confirmed") return "confirmed";
  if (decision === "overridden") return "severity changed";
  if (decision === "cleared") return "does not apply";
  return "information needed";
}

const riskOutcomeTones: Record<string, ClaimTone> = {
  confirmed: "confirmed",
  overridden: "confirmed",
  cleared: "ruled_out",
  follow_up_required: "waiting",
};

/* A complete draft scans in its outcome's colour; the word "draft" keeps
 * it distinct from a recorded judgment. */
function riskDraftStatus(draft: DraftValues): {
  label: string;
  tone: ClaimTone;
} {
  const missing = riskDraftMissing(draft);
  if (missing) return { label: missing, tone: "draft" };
  return {
    label: "Draft: " + riskOutcomeWords(draft.decision),
    tone: riskOutcomeTones[draft.decision] ?? "draft",
  };
}

export function riskClaimStatus(
  finding: RiskRecord,
  draft: DraftValues | null,
): { label: string; tone: ClaimTone } {
  if (draft && riskDraftChanged(draft, finding)) return riskDraftStatus(draft);
  if (finding.decision) {
    return {
      label: capitalize(riskOutcomeWords(finding.decision)),
      tone: riskOutcomeTones[finding.decision] ?? "proposed",
    };
  }
  return { label: "Awaiting decision", tone: "proposed" };
}

/* The exact filler sentences legacy assessments stored when the model had
 * nothing specific to say. Only these yield to coverage or title: a
 * substantive rationale — a condition, a negative conclusion — must reach
 * the inline claim verbatim, never be replaced by a positive summary. */
const fillerFitRationale =
  "The catalog capability covers a material part of the confirmed request.";
const fillerRiskRationale =
  "The rule applies to a material requirement or constraint in the confirmed request.";

/** The inline claim keeps the assessment's own rationale. When the stored
 * rationale is the known filler (or missing), the coverage list — the
 * request-specific requirements — stands in. */
export function fitClaimSummary(candidate: {
  rationale: string;
  coverage: string[];
}): string {
  const rationale = candidate.rationale?.trim();
  if (rationale && rationale !== fillerFitRationale) return candidate.rationale;
  const shown = candidate.coverage.slice(0, 2);
  if (shown.length === 0) return candidate.rationale;
  const more = candidate.coverage.length - shown.length;
  const tail =
    more === 1
      ? "; and one more requirement in the details"
      : "; and " + more + " more requirements in the details";
  return (
    "Coverage reported in preparation: " +
    shown.join("; ") +
    (more > 0 ? tail : "")
  );
}

/** The inline condition keeps the assessment's own rationale; the policy
 * title stands in only for the known filler or a missing rationale. The
 * title is the rule's name, never a fresh conclusion about this request. */
export function riskClaimText(
  finding: { rationale: string } & Partial<{ ruleTitle: string | null }>,
): string {
  const rationale = finding.rationale?.trim();
  if (rationale && rationale !== fillerRiskRationale) return finding.rationale;
  return finding.ruleTitle || finding.rationale;
}

/** A claim's question state comes from the live rows that target it. A
 * provided reply demands a fresh judgment; an unknown or unanswered
 * question keeps the claim waiting — never an automatic clear. */
export function claimQuestionState(
  rows: ReviewInputRow[],
  target: { candidateId?: string; findingId?: string },
): "review_again" | "waiting" | null {
  const targeted = rows.filter(
    (row) =>
      row.current &&
      row.state !== "resolved" &&
      ((target.candidateId && row.candidateId === target.candidateId) ||
        (target.findingId && row.findingId === target.findingId)),
  );
  if (targeted.length === 0) return null;
  return targeted.some((row) => row.latestResponse?.outcome === "provided")
    ? "review_again"
    : "waiting";
}

/** A live draft outranks the question state — the fresh judgment is under
 * way; otherwise an answered question calls the claim back for review. */
export function fitMarker(
  candidate: FitRecord,
  draft: DraftValues | null,
  rows: ReviewInputRow[],
): { label: string; tone: ClaimTone } {
  if (draft && fitDraftChanged(draft, candidate))
    return fitClaimStatus(candidate, draft);
  const question = claimQuestionState(rows, { candidateId: candidate.id });
  if (question === "review_again")
    return { label: "Answer available for review", tone: "waiting" };
  if (question === "waiting")
    return { label: "Information needed", tone: "waiting" };
  return fitClaimStatus(candidate, draft);
}

export function riskMarker(
  finding: RiskRecord,
  draft: DraftValues | null,
  rows: ReviewInputRow[],
): { label: string; tone: ClaimTone } {
  if (draft && riskDraftChanged(draft, finding))
    return riskClaimStatus(finding, draft);
  const question = claimQuestionState(rows, { findingId: finding.id });
  if (question === "review_again")
    return { label: "Answer available for review", tone: "waiting" };
  if (question === "waiting")
    return { label: "Information needed", tone: "waiting" };
  return riskClaimStatus(finding, draft);
}

/** Every changed, complete draft in one payload. Incomplete changed drafts
 * are counted so completion can refuse to drop them silently. */
export function assembleReviewSubmission(
  candidates: FitRecord[],
  findings: RiskRecord[],
  draftFor: (kind: "asset" | "risk", id: string) => DraftValues | null,
) {
  let incomplete = 0;
  const assetDecisions = candidates.flatMap((candidate) => {
    const draft = draftFor("asset", candidate.id);
    if (!draft || !fitDraftChanged(draft, candidate)) return [];
    if (fitDraftMissing(draft)) {
      incomplete++;
      return [];
    }
    return [
      {
        candidateId: candidate.id,
        decision: draft.decision,
        ...(draft.reason?.trim() && { reason: draft.reason.trim() }),
      },
    ];
  });
  const riskDecisions = findings.flatMap((finding) => {
    const draft = draftFor("risk", finding.id);
    if (!draft || !riskDraftChanged(draft, finding)) return [];
    if (riskDraftMissing(draft)) {
      incomplete++;
      return [];
    }
    return [
      {
        findingId: finding.id,
        decision: draft.decision,
        ...(draft.decision === "overridden" && {
          finalSeverity: draft.severity,
        }),
        ...(draft.rationale?.trim() && { rationale: draft.rationale.trim() }),
      },
    ];
  });
  return { assetDecisions, riskDecisions, incomplete };
}

/** Sentence builders for the prose enumeration. */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
export function fitLead(count: number): string {
  return (
    "This review includes " +
    count +
    " existing " +
    (count === 1 ? "option." : "options.")
  );
}
export function riskLead(count: number): string {
  if (count === 1) return "The assessment lists one policy finding.";
  return "The assessment lists " + count + " policy findings.";
}

type DraftHooks = { reset?: () => void; flush?: () => Promise<void> };
type DraftEntry = {
  values: DraftValues;
  ready: boolean;
  failed?: boolean;
} & DraftHooks;
type DraftRegistry = Map<string, DraftEntry>;
type DraftKind = "asset" | "risk" | "priority" | "outcome";
const draftKey = (kind: DraftKind, id: string) => kind + ":" + id;

type DraftOwner = { ready: boolean; failed?: boolean } & DraftHooks;
type Register = (
  kind: DraftKind,
  id: string,
  values: DraftValues,
  owner: DraftOwner,
) => void;

/** Claim editors report their live values here on every change, so the one
 * submission reads current drafts synchronously. The Actions section
 * subscribes: a changed draft or a readiness transition re-derives the
 * completion hold. An owner whose saved work has not loaded still shows
 * its initial values, so the submission boundary must wait for every
 * registered owner's readiness — otherwise a pending saved draft would be
 * silently omitted. Notification is deferred to a microtask because
 * register runs during a child render. */
type DraftStore = {
  registry: DraftRegistry;
  register: Register;
  retain: (keys: ReadonlySet<string>) => void;
  subscribe: (listener: () => void) => () => void;
  version: () => number;
};

export function createDraftStore(): DraftStore {
  const registry: DraftRegistry = new Map();
  const listeners = new Set<() => void>();
  let version = 0;
  let queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const listener of listeners) listener();
    });
  };
  return {
    registry,
    register(kind, id, values, owner) {
      const key = draftKey(kind, id);
      const prior = registry.get(key);
      registry.set(key, { values, ...owner });
      if (
        !prior ||
        prior.ready !== owner.ready ||
        prior.failed !== owner.failed ||
        JSON.stringify(prior.values) !== JSON.stringify(values)
      ) {
        version++;
        notify();
      }
    },
    /* A refreshed assessment can replace candidates and findings while the
     * brief stays mounted; a retired owner's entry must not hold the
     * boundary forever. Only the keys the current data names survive. */
    retain(keys) {
      let pruned = false;
      for (const key of registry.keys())
        if (!keys.has(key)) {
          registry.delete(key);
          pruned = true;
        }
      if (pruned) {
        version++;
        notify();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

function useDraftStore(): DraftStore {
  const [store] = useState(createDraftStore);
  return store;
}

/** How many registered draft owners have not finished loading their saved
 * work. A submission that runs before the count reaches zero would read
 * initial values in place of the person's pending saved draft. */
export function pendingDrafts(
  registry: ReadonlyMap<string, { ready: boolean }>,
): number {
  let pending = 0;
  for (const entry of registry.values()) if (!entry.ready) pending++;
  return pending;
}

export function failedDrafts(
  registry: ReadonlyMap<string, { failed?: boolean }>,
): number {
  let failed = 0;
  for (const entry of registry.values()) if (entry.failed) failed++;
  return failed;
}

/** The draft owners the current data names. Everything else in the
 * registry is a retired owner from an earlier assessment. */
export function currentDraftKeys(
  data: RequestView,
  priority: PriorityView | null,
): Set<string> {
  if (data.delivery.resolution) return new Set();
  const factors = (priority?.factors ?? []).map(
    (view) => "priority:" + view.factor,
  );
  if (!firstReviewOpen(data)) return new Set(priority?.complete ? [] : factors);
  return new Set([
    ...assessmentDraftKeys(
      "asset",
      data.assetAssessment?.status === "succeeded",
      data.candidates,
    ),
    ...assessmentDraftKeys(
      "risk",
      data.riskAssessment?.status === "succeeded",
      data.findings,
    ),
    ...factors,
  ]);
}

function assessmentDraftKeys(
  area: "asset" | "risk",
  active: boolean,
  entries: Array<{ id: string }>,
): string[] {
  if (!active) return [];
  return entries.length
    ? entries.map((entry) => area + ":" + entry.id)
    : ["outcome:" + area];
}

function useCatalogueNavigation(change: (open: boolean) => void) {
  const catalogueOrigin = useRef<{
    element: HTMLButtonElement;
    top: number;
  } | null>(null);
  function openCatalogue(element: HTMLButtonElement) {
    catalogueOrigin.current = { element, top: window.scrollY };
    change(true);
    requestAnimationFrame(() => {
      if (!element.isConnected) return;
      document
        .getElementById("catalogue-query")
        ?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    });
  }
  function closeCatalogue() {
    change(false);
    requestAnimationFrame(() => {
      const origin = catalogueOrigin.current;
      if (!origin?.element.isConnected) return;
      window.scrollTo({ top: origin.top });
      origin.element.focus();
    });
  }
  return { openCatalogue, closeCatalogue };
}

export function ReviewBrief(
  props: RecordProps & {
    administrative: boolean;
    catalogue: boolean;
    onCatalogueChange: (open: boolean) => void;
    needSlot?: React.ReactNode;
    fitSlot?: React.ReactNode;
  },
) {
  const { data, catalogue } = props;
  const store = useDraftStore();
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const { openCatalogue, closeCatalogue } = useCatalogueNavigation(
    props.onCatalogueChange,
  );
  const priority = priorityOf(data);
  const rows = inputRequestsOf(data);
  useEffect(() => {
    store.retain(currentDraftKeys(data, priority ?? null));
  }, [store, data, priority]);
  const claimProps = {
    data,
    changed: props.changed,
    administrative: props.administrative,
    register: store.register,
    open: openClaim,
    setOpen: setOpenClaim,
  };
  return (
    <div className={styles.brief}>
      {catalogue && (
        <CatalogueView
          data={data}
          changed={props.changed}
          onBack={closeCatalogue}
        />
      )}
      {/* The brief hides rather than unmounts while the catalogue shows, so
       * every claim's draft hook and its registry entry stay live. */}
      <div hidden={catalogue}>
        {(priority === undefined || rows === undefined) && (
          <Problem>
            Only part of the request loaded. Refresh the request to try again;
            ask an operator for help if the problem continues.
          </Problem>
        )}
        <p className={styles.context}>
          Select a highlighted existing option or policy finding to review its
          evidence and make a decision.
        </p>
        <NeedSummary data={data}>{props.needSlot}</NeedSummary>
        <FitProse
          {...claimProps}
          rows={(rows ?? []).filter((row) => row.area === "assets")}
          onSearch={openCatalogue}
        />
        {props.fitSlot}
        <RiskProse
          {...claimProps}
          rows={(rows ?? []).filter((row) => row.area === "risk")}
        />
        <PriorityPanel
          data={data}
          changed={props.changed}
          administrative={props.administrative}
          priority={priority ?? null}
          inputRows={(rows ?? []).filter((row) => row.area === "rice")}
          register={store.register}
        />
        <ActionsSection {...props} store={store} priority={priority ?? null} />
      </div>
    </div>
  );
}

/** The confirmed request reads in flow — problem, who it serves, and the
 * supplied success criteria, requirements, constraints, and unknowns
 * (empty facts are omitted). The raw description and intake transcript
 * live in History; a judgment does not need the transcript. */
function NeedSummary({
  data,
  children,
}: {
  data: RequestView;
  children?: React.ReactNode;
}) {
  return (
    <section className={styles.needSummary} id="need">
      <h2 id="need-heading" tabIndex={-1}>
        {completionSections.need}
      </h2>
      <RequestSummary content={data.record.content} singleColumn />
      {children}
    </section>
  );
}

type ClaimSectionProps = RecordProps & {
  administrative: boolean;
  register: Register;
  rows: ReviewInputRow[];
  open: string | null;
  setOpen: (id: string | null) => void;
};

function FitProse(
  props: ClaimSectionProps & {
    onSearch: (element: HTMLButtonElement) => void;
  },
) {
  const { data, changed, rows } = props;
  const current = data.assetAssessment?.status === "succeeded";
  const mutable = firstReviewOpen(data);
  return (
    <section id="fit">
      <h2 id="fit-heading" tabIndex={-1}>
        {completionSections.fit}
      </h2>
      <RequesterConcerns data={data} />
      {mutable && (
        <Preparation
          data={data}
          changed={changed}
          purpose="asset_match"
          available={current}
        />
      )}
      {current && data.candidates.length === 0 && (
        <EmptyOutcomeAffirmation
          data={data}
          register={props.register}
          kind="asset"
          statement="Matching found no existing options. Check the result and confirm whether no option fits."
          label="I checked and found no existing option that meets the need."
        />
      )}
      {current && data.candidates.length > 0 && (
        <>
          <p className={styles.para}>{fitLead(data.candidates.length)}</p>
          <ul className={styles.claimList} role="list">
            {data.candidates.map((candidate) => (
              <FitClaim key={candidate.id} {...props} candidate={candidate} />
            ))}
          </ul>
        </>
      )}
      {mutable && (
        <p>
          <Button
            type="button"
            outline
            onClick={(event) => props.onSearch(event.currentTarget)}
          >
            Search the catalog
          </Button>
        </p>
      )}
      <InputRequests
        data={data}
        changed={changed}
        administrative={props.administrative}
        rows={rows.filter((row) => !row.candidateId)}
      />
    </section>
  );
}

/** An empty proposal list never settles itself: the reviewer states the
 * outcome explicitly, and the statement travels with the final save. */
function EmptyOutcomeAffirmation({
  data,
  register,
  kind,
  statement,
  label,
}: {
  data: RequestView;
  register: Register;
  kind: "asset" | "risk";
  statement: string;
  label: string;
}) {
  const { metadata } = useApp();
  const mutable = firstReviewOpen(data);
  const work = useSavedWork(
    {
      visitorId: metadata.visitor.visitorId,
      actingView: "contributor",
      pageKey: kind + "-empty-outcome",
      subjectKey: data.record.requestId,
    },
    { affirmed: "" },
  );
  if (mutable)
    register("outcome", kind, work.values, {
      ready: work.ready,
      failed: work.status.kind === "loadFailed",
    });
  return (
    <div>
      <p>{statement}</p>
      {mutable && <SavedWorkProblem work={work} />}
      {mutable && (
        <label className={styles.affirm}>
          <input
            type="checkbox"
            checked={work.values.affirmed === "yes"}
            disabled={!work.ready}
            onChange={(event) =>
              work.change("affirmed", event.target.checked ? "yes" : "")
            }
          />{" "}
          {label}
        </label>
      )}
    </div>
  );
}

type Candidate = RequestView["candidates"][number];

function FitClaim(
  props: ClaimSectionProps & {
    candidate: Candidate;
  },
) {
  const { data, candidate, rows } = props;
  const { metadata } = useApp();
  const mutable = firstReviewOpen(data);
  const work = useSavedWork(
    {
      visitorId: metadata.visitor.visitorId,
      actingView: "contributor",
      pageKey: "asset-" + candidate.id,
      subjectKey: data.record.requestId,
    },
    {
      decision: candidate.decision ?? "",
      reason: candidate.reason ?? "",
    },
  );
  if (mutable)
    props.register("asset", candidate.id, work.values, {
      ready: work.ready,
      failed: work.status.kind === "loadFailed",
    });
  const marker = fitMarker(candidate, mutable ? work.values : null, rows);
  const open = props.open === candidate.id;
  return (
    <li className={styles.claimRow}>
      <button
        type="button"
        className={styles.claimControl}
        data-claim={candidate.id}
        aria-expanded={open}
        onClick={() => props.setOpen(open ? null : candidate.id)}
      >
        <span className={styles.claimtxt + " " + styles.claimText}>
          <strong>{candidate.name}</strong> — {fitClaimSummary(candidate)}
        </span>{" "}
        <span className={styles.status + " " + toneClass[marker.tone]}>
          ({marker.label})
        </span>
      </button>
      {open && <FitClaimPanel {...props} work={work} mutable={mutable} />}
    </li>
  );
}

function FitClaimPanel(
  props: ClaimSectionProps & {
    candidate: Candidate;
    work: ReturnType<typeof useSavedWork>;
    mutable: boolean;
  },
) {
  const { data, changed, candidate, work, mutable, rows } = props;
  return (
    <div className={styles.claimpanel} data-claimpanel={candidate.id}>
      <FitEvidence candidate={candidate} />
      <FitRecorded candidate={candidate} />
      {mutable && <SavedWorkProblem work={work} />}
      {mutable && <FitJudgment candidate={candidate} work={work} />}
      <InputRequests
        data={data}
        changed={changed}
        administrative={props.administrative}
        rows={rows.filter((row) => row.candidateId === candidate.id)}
      />
      {mutable && (
        <AskForInput
          data={data}
          changed={changed}
          area="assets"
          target={{ candidateId: candidate.id }}
          summary="Ask about this option"
        />
      )}
    </div>
  );
}

/** A manually added candidate carries the adder's actor id and no model
 * match rationale; no match score is invented for it. */
export function candidateProvenance(
  candidate: { id: string; proposedByActorId?: string | null },
  nameFor: (id: string) => string,
): string {
  return candidate.proposedByActorId
    ? "Added for review by " + nameFor(candidate.proposedByActorId)
    : "From prepared matching results";
}

/** Recorded-decision attribution once the view exposes it. */
export function decisionByline(
  entry: {
    id: string;
    decisionActorId?: string | null;
    decidedAt?: string | null;
  },
  nameFor: (id: string) => string,
): string | null {
  if (!entry.decisionActorId) return null;
  return (
    "Decided by " +
    nameFor(entry.decisionActorId) +
    (entry.decidedAt ? " · " + new Date(entry.decidedAt).toLocaleString() : "")
  );
}

function FitEvidence({ candidate }: { candidate: Candidate }) {
  const { metadata } = useApp();
  const nameFor = (id: string) =>
    metadata.actors.find((actor) => actor.id === id)?.displayName ??
    "Unknown person";
  return (
    <>
      <div className={styles.excerpt}>
        <p>
          {candidate.description ||
            "The description used in this assessment was not kept. Check the current catalog entry before relying on the match."}
        </p>
        <EvidenceList
          heading="h3"
          label="Requirements reported as covered"
          values={candidate.coverage}
          empty="No requirement coverage recorded."
        />
        <EvidenceList
          heading="h3"
          label="Requirements reported as unmet"
          values={candidate.gaps}
          empty="No gaps recorded."
        />
        <EvidenceList
          heading="h3"
          label="Prerequisites"
          values={candidate.dependencies}
        />
        <p>
          <strong>Reasoning in the matching result:</strong>{" "}
          {candidate.rationale}
        </p>
      </div>
      <p className={styles.provenance}>
        {candidateProvenance(candidate, nameFor)} · Catalog version used:{" "}
        {candidate.catalogVersion}
        {!candidate.catalogTextCurrent &&
          " (catalog changed; current version: " +
            candidate.currentVersion +
            ")"}
      </p>
    </>
  );
}

function FitJudgment({
  candidate,
  work,
}: {
  candidate: Candidate;
  work: ReturnType<typeof useSavedWork>;
}) {
  const decision = work.values.decision;
  const changed = fitDraftChanged(work.values, candidate);
  return (
    <SavedWorkFieldset ready={work.ready}>
      <div className={styles.verbs}>
        <Button
          type="button"
          outline={decision !== "accepted"}
          aria-pressed={decision === "accepted"}
          onClick={() => work.change("decision", "accepted")}
        >
          Accept option
        </Button>
        <Button
          type="button"
          outline={decision !== "rejected"}
          aria-pressed={decision === "rejected"}
          onClick={() => work.change("decision", "rejected")}
        >
          Reject option
        </Button>
        {changed && (
          <button
            type="button"
            className={styles.linkish}
            onClick={() => {
              work.change("decision", candidate.decision ?? "");
              work.change("reason", candidate.reason ?? "");
            }}
          >
            Restore recorded decision
          </button>
        )}
      </div>
      <Field
        name={"fit-reason-" + candidate.id}
        label={
          decision === "rejected"
            ? "Why does this option not fit?"
            : "Reason for accepting (optional)"
        }
        multiline
        required={decision === "rejected"}
        value={work.values.reason}
        onChange={(value) => work.change("reason", value)}
      />
      <p className={styles.draftState}>
        Your decision is a draft until you record the review changes.
      </p>
    </SavedWorkFieldset>
  );
}

function FitRecorded({ candidate }: { candidate: Candidate }) {
  const { metadata } = useApp();
  if (!candidate.decision) return null;
  const byline = decisionByline(
    candidate,
    (id) =>
      metadata.actors.find((actor) => actor.id === id)?.displayName ??
      "Unknown person",
  );
  return (
    <p>
      <strong>
        Recorded decision:{" "}
        {candidate.decision === "accepted" ? "Accepted" : "Rejected"}
      </strong>
      {candidate.reason && " — " + candidate.reason}
      {byline && <span className={styles.provenance}> · {byline}</span>}
    </p>
  );
}

type Finding = RequestView["findings"][number];

const severityWords: Record<string, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  critical: "Critical",
};

const severityClass: Record<string, string> = {
  low: styles.sevLow,
  moderate: styles.sevModerate,
  high: styles.sevHigh,
  critical: styles.sevCritical,
};

function RiskProse(props: ClaimSectionProps) {
  const { data, changed, rows } = props;
  const current = data.riskAssessment?.status === "succeeded";
  const mutable = firstReviewOpen(data);
  return (
    <section id="risk">
      <h2 id="risk-heading" tabIndex={-1}>
        {completionSections.risk}
      </h2>
      {mutable && (
        <Preparation
          data={data}
          changed={changed}
          purpose="risk_assess"
          available={current}
        />
      )}
      {current && data.findings.length === 0 && (
        <EmptyOutcomeAffirmation
          data={data}
          register={props.register}
          kind="risk"
          statement="Preparation found no findings supported by the policy sources. Review the result; an empty result is not security approval."
          label="I checked the assessment and found no policy findings to review."
        />
      )}
      {current && data.findings.length > 0 && (
        <>
          <p className={styles.para}>{riskLead(data.findings.length)}</p>
          <ul className={styles.claimList} role="list">
            {data.findings.map((finding) => (
              <RiskClaim key={finding.id} {...props} finding={finding} />
            ))}
          </ul>
        </>
      )}
      <InputRequests
        data={data}
        changed={changed}
        administrative={props.administrative}
        rows={rows.filter((row) => !row.findingId)}
      />
    </section>
  );
}

function RiskClaim(
  props: ClaimSectionProps & {
    finding: Finding;
  },
) {
  const { data, finding, rows } = props;
  const { metadata } = useApp();
  const mutable = firstReviewOpen(data);
  const work = useSavedWork(
    {
      visitorId: metadata.visitor.visitorId,
      actingView: "contributor",
      pageKey: "risk-" + finding.id,
      subjectKey: data.record.requestId,
    },
    riskDraftInitial(finding),
  );
  if (mutable)
    props.register("risk", finding.id, work.values, {
      ready: work.ready,
      failed: work.status.kind === "loadFailed",
    });
  const marker = riskMarker(finding, mutable ? work.values : null, rows);
  const open = props.open === finding.id;
  return (
    <li className={styles.claimRow}>
      <button
        type="button"
        className={styles.claimControl}
        data-claim={finding.id}
        aria-expanded={open}
        onClick={() => props.setOpen(open ? null : finding.id)}
      >
        <span className={styles.claimtxt + " " + styles.claimText}>
          {riskClaimText(finding)}
        </span>{" "}
        <SeverityChip severity={finding.finalSeverity ?? finding.severity} />{" "}
        <span className={styles.status + " " + toneClass[marker.tone]}>
          ({marker.label})
        </span>
      </button>
      {open && <RiskClaimPanel {...props} work={work} mutable={mutable} />}
    </li>
  );
}

function riskDraftInitial(finding: Finding) {
  return {
    decision: finding.decision ?? "",
    severity: finding.finalSeverity ?? finding.severity ?? "",
    rationale: finding.decisionRationale ?? "",
  };
}

function SeverityChip({ severity }: { severity: string | null }) {
  return (
    <span
      className={
        styles.sevChip + " " + (severityClass[severity ?? ""] ?? styles.sevLow)
      }
    >
      {severity ? severityWords[severity] : "Severity unknown"}
    </span>
  );
}

function RiskClaimPanel(
  props: ClaimSectionProps & {
    finding: Finding;
    work: ReturnType<typeof useSavedWork>;
    mutable: boolean;
  },
) {
  const { data, changed, finding, work, mutable, rows } = props;
  return (
    <div className={styles.claimpanel} data-claimpanel={finding.id}>
      <SeverityLine finding={finding} />
      <RiskEvidence finding={finding} />
      <RiskRecorded finding={finding} />
      {mutable && <SavedWorkProblem work={work} />}
      {mutable && <RiskJudgment finding={finding} work={work} />}
      <InputRequests
        data={data}
        changed={changed}
        administrative={props.administrative}
        rows={rows.filter((row) => row.findingId === finding.id)}
      />
      {mutable && (
        <AskForInput
          data={data}
          changed={changed}
          area="risk"
          target={{ findingId: finding.id }}
          summary="Ask about this finding"
        />
      )}
    </div>
  );
}

function SeverityLine({ finding }: { finding: Finding }) {
  return (
    <p className={styles.severityLine}>
      {finding.severity
        ? "Proposed severity: " + severityWords[finding.severity]
        : "Information is missing. The risk and its severity cannot yet be established."}
      {finding.finalSeverity &&
        finding.finalSeverity !== finding.severity &&
        " · Reviewed severity: " + severityWords[finding.finalSeverity]}
    </p>
  );
}

function RiskEvidence({ finding }: { finding: Finding }) {
  const rule = finding as Partial<{
    ruleTitle: string | null;
    ruleVersion: number | null;
    ruleIsDemo: boolean | null;
  }>;
  return (
    <>
      <div className={styles.excerpt}>
        <p>
          <strong>
            {finding.kind === "missing_information"
              ? "Missing information:"
              : "Model interpretation:"}
          </strong>{" "}
          {finding.evidence ?? finding.missingInformation}
        </p>
        <h3 className={styles.ruleTitle}>
          Policy source
          {rule.ruleTitle && ": " + rule.ruleTitle} ({finding.ruleCode}
          {rule.ruleVersion ? " v" + rule.ruleVersion : ""})
        </h3>
        {rule.ruleIsDemo && (
          <p className={styles.provenance}>Fictional demo policy</p>
        )}
        <p>{finding.rule}</p>
        <p>
          <strong>Reasoning in the prepared finding:</strong>{" "}
          {finding.rationale}
        </p>
      </div>
      <p className={styles.provenance}>
        Policy citation: {finding.citation} · The model’s interpretation is not
        a verified quotation of the requester’s words.
      </p>
    </>
  );
}

/** The recorded human verdict with its reason and decided-by line. The
 * claim keeps the original proposal text; the verdict is labelled as the
 * reviewer's, so a cleared or overridden outcome never reads as an
 * endorsement of the proposed claim. */
function RiskRecorded({ finding }: { finding: Finding }) {
  const { metadata } = useApp();
  if (!finding.decision) return null;
  const byline = decisionByline(
    finding,
    (id) =>
      metadata.actors.find((actor) => actor.id === id)?.displayName ??
      "Unknown person",
  );
  return (
    <p>
      <strong>Recorded: {riskClaimStatus(finding, null).label}</strong>
      {finding.decisionRationale && " — " + finding.decisionRationale}
      {byline && <span className={styles.provenance}> · {byline}</span>}
    </p>
  );
}

const riskVerbs = [
  { value: "confirmed", label: "Confirm finding" },
  { value: "overridden", label: "Change severity" },
  { value: "cleared", label: "Does not apply" },
  { value: "follow_up_required", label: "Need more information" },
];

function RiskJudgment({
  finding,
  work,
}: {
  finding: Finding;
  work: ReturnType<typeof useSavedWork>;
}) {
  const decision = work.values.decision;
  const changed = riskDraftChanged(work.values, finding);
  const verbs =
    finding.kind === "missing_information"
      ? riskVerbs.filter((verb) => verb.value !== "confirmed")
      : riskVerbs;
  return (
    <SavedWorkFieldset ready={work.ready}>
      <p className={styles.guidance}>
        Confirming a finding records that it applies; it does not approve the
        request or establish safety. Missing information does not establish
        safety either.
      </p>
      <div className={styles.verbs}>
        {verbs.map((verb) => (
          <Button
            key={verb.value}
            type="button"
            outline={decision !== verb.value}
            aria-pressed={decision === verb.value}
            onClick={() => work.change("decision", verb.value)}
          >
            {verb.label}
          </Button>
        ))}
        {changed && (
          <button
            type="button"
            className={styles.linkish}
            onClick={() => {
              work.change("decision", finding.decision ?? "");
              work.change(
                "severity",
                finding.finalSeverity ?? finding.severity ?? "",
              );
              work.change("rationale", finding.decisionRationale ?? "");
            }}
          >
            Restore recorded decision
          </button>
        )}
      </div>
      {decision === "overridden" && (
        <SeverityPicker finding={finding} work={work} />
      )}
      <Field
        name={"brief-rationale-" + finding.id}
        label={
          decision === "confirmed"
            ? "Reason for confirming (optional)"
            : "Reason for this decision"
        }
        multiline
        required={Boolean(decision) && decision !== "confirmed"}
        value={work.values.rationale}
        onChange={(value) => work.change("rationale", value)}
      />
      <p className={styles.draftState}>
        Your decision is a draft until you record the review changes.
      </p>
    </SavedWorkFieldset>
  );
}

function SeverityPicker({
  finding,
  work,
}: {
  finding: Finding;
  work: ReturnType<typeof useSavedWork>;
}) {
  return (
    <>
      <Label htmlFor={"brief-severity-" + finding.id}>New severity</Label>
      <Select
        id={"brief-severity-" + finding.id}
        name="severity"
        value={work.values.severity}
        onChange={(event) => work.change("severity", event.target.value)}
      >
        <option value="">Choose a severity</option>
        {["low", "moderate", "high", "critical"].map((value) => (
          <option key={value} value={value}>
            {severityWords[value]}
          </option>
        ))}
      </Select>
    </>
  );
}

/** Priority renders from the score state, never from the request phase, so
 * an unscored request keeps its priority work visible after first review. */
export function priorityState(priority: PriorityView | null): {
  label: string;
  tone: ClaimTone;
} {
  if (priority?.complete) return { label: "Reviewed", tone: "confirmed" };
  return { label: "Not scored", tone: "proposed" };
}

function PriorityPanel({
  data,
  changed,
  priority,
  inputRows,
  register,
  administrative,
}: RecordProps & {
  priority: PriorityView | null;
  inputRows: ReviewInputRow[];
  administrative: boolean;
  register: Register;
}) {
  /* Priority stays editable while its work is open — the priority read
   * model decides — but never on a closed request. */
  const mutable =
    !data.delivery.resolution && (firstReviewOpen(data) || !priority?.complete);
  return (
    <section id="priority">
      <h2 id="priority-heading" tabIndex={-1}>
        {completionSections.priority}
      </h2>
      <PriorityScoreLine data={data} priority={priority} mutable={mutable} />
      {priority ? (
        <PriorityFactors
          data={data}
          changed={changed}
          priority={priority}
          mutable={mutable}
          administrative={administrative}
          inputRows={inputRows}
          register={(factor, values, owner) =>
            register("priority", factor, values, owner)
          }
        />
      ) : (
        <Problem>
          Current priority information could not load. Reload before relying on
          a score; earlier scores may no longer apply.
        </Problem>
      )}
      <EarlierPriorityForm data={data} />
    </section>
  );
}

function PriorityScoreLine({
  data,
  priority,
  mutable,
}: {
  data: RequestView;
  priority: PriorityView | null;
  mutable: boolean;
}) {
  const score = priority?.score ?? null;
  /* The editable-pending sentence may only render when it is true: the
   * read model loaded, the stage completed, no score, and the panel's
   * own mutable flag allows edits. */
  if (
    priority &&
    mutable &&
    data.record.stage === "first_review_completed" &&
    score === null
  )
    return (
      <p>
        First review is complete. Priority estimates remain incomplete and
        editable. The request stays visible but is excluded from score ranking.
      </p>
    );
  return (
    <p>
      RICE score: <strong>{formatScore(score)}</strong>
    </p>
  );
}

/** What the completion area may claim. A request closed before first
 * review completed must never present itself as a completed review. */
export function reviewClosureState(
  data: RequestView,
): "open" | "completed" | "closed_without_review" {
  if (data.record.stage === "first_review_completed") return "completed";
  if (data.delivery.resolution) return "closed_without_review";
  return "open";
}

/** The area outcome joins the submission only when the server still lists
 * it as pending and the decisions at hand settle it. */
export function assetOutcomeFor(
  candidates: Array<{ id: string; decision: string | null }>,
  draftFor: (kind: "asset", id: string) => DraftValues | null,
): "accepted" | "no_match" | null {
  if (candidates.length === 0) return null;
  const effective = candidates.map((candidate) => {
    const draft = draftFor("asset", candidate.id);
    return draft && !fitDraftMissing(draft) && draft.decision
      ? draft.decision
      : candidate.decision;
  });
  if (effective.some((decision) => decision === "accepted")) return "accepted";
  if (effective.every((decision) => decision === "rejected")) return "no_match";
  return null;
}

export function riskSettled(
  findings: Array<{ id: string; decision: string | null }>,
  draftFor: (kind: "risk", id: string) => DraftValues | null,
): boolean {
  return findings.every((finding) => {
    const draft = draftFor("risk", finding.id);
    const effective =
      draft && !riskDraftMissing(draft) && draft.decision
        ? draft.decision
        : finding.decision;
    return Boolean(effective) && effective !== "follow_up_required";
  });
}

/** With no candidates at all, only the reviewer's explicit affirmation
 * records the no-match outcome — an empty list never self-affirms. */
export function resolveAssetOutcome(
  candidates: FitRecord[],
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
): "accepted" | "no_match" | null {
  if (candidates.length === 0) {
    return draftFor("outcome", "asset")?.affirmed === "yes" ? "no_match" : null;
  }
  return assetOutcomeFor(candidates, draftFor);
}

/** An empty findings list likewise needs the reviewer's explicit statement
 * that the empty assessment was reviewed. */
export function resolveRiskOutcome(
  findings: RiskRecord[],
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
): boolean {
  if (findings.length === 0) {
    return draftFor("outcome", "risk")?.affirmed === "yes";
  }
  return riskSettled(findings, draftFor);
}

/** Assembles one submitAssessment payload from every complete changed draft,
 * or names the reason nothing can be sent. */
export function assembleAssessmentPayload(
  data: RequestView,
  priority: PriorityView | null,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
): {
  payload: Record<string, unknown> | null;
  problem: string;
  incomplete: number;
  priorityDecisions: PriorityDecisionInput[];
} {
  const submission = assembleReviewSubmission(
    data.candidates,
    data.findings,
    draftFor,
  );
  const priorityWork = priorityDecisionsFromDrafts(priority, (factor) =>
    draftFor("priority", factor),
  );
  const incomplete = submission.incomplete + priorityWork.incomplete;
  const blockers = data.review.blockers;
  const assetOutcome = blockers.includes("ASSET_OUTCOME_PENDING")
    ? resolveAssetOutcome(data.candidates, draftFor)
    : null;
  const riskOutcome =
    blockers.includes("RISK_OUTCOME_PENDING") &&
    resolveRiskOutcome(data.findings, draftFor);
  const hasWork =
    submission.assetDecisions.length > 0 ||
    submission.riskDecisions.length > 0 ||
    priorityWork.decisions.length > 0 ||
    assetOutcome !== null ||
    riskOutcome;
  if (!hasWork) {
    return {
      payload: null,
      problem:
        incomplete > 0
          ? "A draft is missing something. Add the required reason, severity, value, or basis — or set the draft back."
          : "Nothing has changed since the last save.",
      incomplete,
      priorityDecisions: [],
    };
  }
  return {
    payload: {
      assetDecisions: submission.assetDecisions,
      riskDecisions: submission.riskDecisions,
      ...(assetOutcome && { assetOutcome }),
      riskOutcome,
      priorityDecisions: priorityWork.decisions,
    },
    problem: "",
    incomplete,
    priorityDecisions: priorityWork.decisions,
  };
}

const completionSections = {
  need: "Confirmed request",
  fit: "Existing options",
  risk: "Policy findings",
  priority: "Priority estimates",
} as const;
type CompletionSection = keyof typeof completionSections;
export type CompletionNeed = { section: CompletionSection; messages: string[] };

const preparationNeeds: Record<
  "fit" | "risk",
  Array<{ blockers: ApprovalBlocker[]; message: string }>
> = {
  fit: [
    {
      blockers: ["ASSET_ASSESSMENT_MISSING", "ASSET_ASSESSMENT_FAILED"],
      message: "a current assessment is still needed.",
    },
    {
      blockers: ["ASSET_CORPUS_STALE"],
      message: "the assessment is out of date and needs to be updated.",
    },
  ],
  risk: [
    {
      blockers: ["RISK_ASSESSMENT_MISSING", "RISK_ASSESSMENT_FAILED"],
      message: "a current assessment is still needed.",
    },
    {
      blockers: ["RISK_RULE_RETIRED"],
      message:
        "a cited policy rule has been retired, so the assessment needs to be updated.",
    },
    {
      blockers: ["RISK_CORPUS_STALE"],
      message:
        "the assessment uses outdated source information and needs to be updated.",
    },
  ],
};

function preparationHold(data: RequestView, section: "fit" | "risk"): string[] {
  const cause = preparationNeeds[section].find((entry) =>
    entry.blockers.some((blocker) => data.review.blockers.includes(blocker)),
  );
  return cause ? [cause.message] : [];
}

/** The same holds drive completion and its section-linked summary. Complete
 * drafts count as their intended judgments; untouched missing scores do not hold. */
export function completionHold(
  data: RequestView,
  priority: PriorityView | null,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
): CompletionNeed[] {
  const questions = (inputRequestsOf(data) ?? []).filter(
    (row) =>
      (row.area === "assets" || row.area === "risk") &&
      row.current &&
      row.state !== "resolved",
  );
  const incomplete = priorityDecisionsFromDrafts(priority, (factor) =>
    draftFor("priority", factor),
  ).incomplete;
  const needs: CompletionNeed[] = [
    {
      section: "need",
      messages: data.review.blockers.includes("OPEN_CLARIFICATION")
        ? ["the requester still needs to answer the open clarification."]
        : [],
    },
    {
      section: "fit",
      messages: fitCompletionHold(
        data,
        draftFor,
        questions.filter((row) => row.area === "assets"),
      ),
    },
    {
      section: "risk",
      messages: riskCompletionHold(
        data,
        draftFor,
        questions.filter((row) => row.area === "risk"),
      ),
    },
    {
      section: "priority",
      messages:
        incomplete > 0
          ? [
              incomplete === 1
                ? "one estimate draft is incomplete; finish it or restore its earlier values."
                : "the " +
                  incomplete +
                  " estimate drafts are incomplete; finish them or restore their earlier values.",
            ]
          : [],
    },
  ];
  return needs.filter((need) => need.messages.length > 0);
}

function fitCompletionHold(
  data: RequestView,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
  questions: ReviewInputRow[],
): string[] {
  const preparation = preparationHold(data, "fit");
  const eligibility = data.review.blockers.includes("CATALOG_INELIGIBLE")
    ? [
        "a previously accepted option is no longer eligible in the catalog and needs to be reconsidered.",
      ]
    : [];
  if (preparation.length) return [...preparation, ...eligibility];
  const incomplete = assembleReviewSubmission(
    data.candidates,
    [],
    draftFor,
  ).incomplete;
  return [
    ...eligibility,
    ...fitHold(data, draftFor, incomplete),
    ...questionHold(data, draftFor, questions),
  ];
}

function fitHold(
  data: RequestView,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
  incomplete: number,
): string[] {
  const pending =
    data.review.blockers.includes("ASSET_OUTCOME_PENDING") &&
    resolveAssetOutcome(data.candidates, draftFor) === null;
  if (incomplete > 0)
    return [
      pending
        ? "the option choice remains open, with unfinished edits to complete or restore; accept one that fits, or reject every option with a reason."
        : "unfinished option edits need to be completed or restored to their earlier values.",
    ];
  if (!pending) return [];
  if (data.candidates.length === 0)
    return [
      "the assessment found no options, and you still need to confirm that no existing option fits.",
    ];
  const undecided = data.candidates.some((candidate) => {
    const draft = draftFor("asset", candidate.id);
    const effective =
      draft && !fitDraftMissing(draft) && draft.decision
        ? draft.decision
        : candidate.decision;
    return !effective;
  });
  return undecided
    ? [
        "the option choice remains open; accept one that fits, or reject every option with a reason.",
      ]
    : [];
}

const riskHoldBlockers: ApprovalBlocker[] = [
  "RISK_FINDINGS_UNDECIDED",
  "RISK_OUTCOME_PENDING",
  "RISK_FOLLOW_UP_OPEN",
];

function riskCompletionHold(
  data: RequestView,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
  questions: ReviewInputRow[],
): string[] {
  const preparation = preparationHold(data, "risk");
  if (preparation.length) return preparation;
  const incomplete = assembleReviewSubmission(
    [],
    data.findings,
    draftFor,
  ).incomplete;
  return [
    ...riskHold(data, draftFor, incomplete, questions),
    ...questionHold(data, draftFor, questions),
  ];
}

function riskHold(
  data: RequestView,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
  incomplete: number,
  questions: ReviewInputRow[],
): string[] {
  const pending =
    data.review.blockers.some((blocker) =>
      riskHoldBlockers.includes(blocker),
    ) && !resolveRiskOutcome(data.findings, draftFor);
  if (!pending)
    return incomplete > 0
      ? [
          "unfinished policy edits need to be completed or restored to their earlier values.",
        ]
      : [];
  if (data.findings.length === 0)
    return [
      "the assessment reported no findings; confirm that you have checked the result.",
    ];
  const counts = riskDraftCounts(data.findings, draftFor, questions);
  const messages = riskDecisionHold(counts.undecided, incomplete);
  if (counts.waiting > 0)
    messages.push(
      counts.waiting === 1
        ? "one finding needs more information but has no open question for it."
        : "more information is needed for " +
            counts.waiting +
            " findings that have no open questions.",
    );
  return messages;
}

function riskDecisionHold(undecided: number, incomplete: number): string[] {
  if (incomplete > 0)
    return [
      undecided > 0
        ? "the policy review is unfinished, with remaining decisions to make and draft edits to complete or restore to their earlier values."
        : "unfinished policy edits need to be completed or restored to their earlier values.",
    ];
  if (undecided > 0)
    return [
      undecided === 1
        ? "one finding still needs a decision."
        : "decisions are still needed for " + undecided + " findings.",
    ];
  return [];
}

function riskDraftCounts(
  findings: RequestView["findings"],
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
  questions: ReviewInputRow[],
): { undecided: number; waiting: number } {
  let undecided = 0;
  let waiting = 0;
  for (const finding of findings) {
    const draft = draftFor("risk", finding.id);
    const effective =
      draft && !riskDraftMissing(draft) && draft.decision
        ? draft.decision
        : finding.decision;
    if (!effective) undecided++;
    else if (
      effective === "follow_up_required" &&
      !questions.some((row) => row.findingId === finding.id)
    )
      waiting++;
  }
  return { undecided, waiting };
}

/** A response still needs the same fresh resolving judgment as the submission
 * command. Grouping its message never clears an unanswered or unknown reply. */
function questionHold(
  data: RequestView,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
  rows: ReviewInputRow[],
): string[] {
  let unanswered = 0;
  let unjudged = 0;
  for (const row of rows) {
    if (row.latestResponse?.outcome !== "provided") {
      unanswered++;
      continue;
    }
    if (!freshJudgmentDrafted(row, data, draftFor)) unjudged++;
  }
  const messages: string[] = [];
  if (unanswered > 0)
    messages.push(
      unanswered === 1
        ? "one open question still needs a useful answer."
        : "useful answers are still needed for " +
            unanswered +
            " open questions.",
    );
  if (unjudged > 0)
    messages.push(
      unjudged === 1
        ? "one answer still needs review and a recorded decision based on that review."
        : "the " +
            unjudged +
            " answers still need review and recorded decisions based on that review.",
    );
  return messages;
}

function freshJudgmentDrafted(
  row: ReviewInputRow,
  data: RequestView,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
): boolean {
  if (row.candidateId) return freshFitDraft(row.candidateId, data, draftFor);
  if (row.findingId) return freshRiskDraft(row.findingId, data, draftFor);
  return row.area === "assets"
    ? resolveAssetOutcome(data.candidates, draftFor) !== null
    : resolveRiskOutcome(data.findings, draftFor);
}

function freshFitDraft(
  candidateId: string,
  data: RequestView,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
): boolean {
  const candidate = data.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) return false;
  const draft = draftFor("asset", candidate.id);
  return Boolean(
    draft && fitDraftChanged(draft, candidate) && !fitDraftMissing(draft),
  );
}

function freshRiskDraft(
  findingId: string,
  data: RequestView,
  draftFor: (kind: DraftKind, id: string) => DraftValues | null,
): boolean {
  const finding = data.findings.find((entry) => entry.id === findingId);
  if (!finding) return false;
  const draft = draftFor("risk", finding.id);
  return Boolean(
    draft &&
    riskDraftChanged(draft, finding) &&
    !riskDraftMissing(draft) &&
    draft.decision !== "follow_up_required",
  );
}

function ActionsSection(
  props: RecordProps & {
    administrative: boolean;
    store: DraftStore;
    priority: PriorityView | null;
  },
) {
  const { data, changed, store, priority } = props;
  const closure = reviewClosureState(data);
  return (
    <section className={styles.completion} id="completion">
      <h2>Review decisions</h2>
      {closure === "closed_without_review" && (
        <p>
          The request was closed before first review was completed. View the
          recorded outcome and supporting history.
        </p>
      )}
      {closure === "completed" && (
        <CompletedActions
          data={data}
          changed={changed}
          store={store}
          priority={priority}
        />
      )}
      {closure === "open" && (
        <>
          <FinishPanel
            data={data}
            changed={changed}
            store={store}
            priority={priority}
          />
          <details className={styles.coordination}>
            <summary>Review responsibilities (optional)</summary>
            <ReviewAssignments data={data} changed={changed} />
          </details>
          <EarlyClose data={data} changed={changed} />
        </>
      )}
    </section>
  );
}

/** Closing without fulfillment is the withdrawal path the workflow keeps
 * open at every stage; the deliberate reveal keeps it out of the way of
 * the review itself. One statement supplies both the recorded summary
 * and the required closure reason. */
function EarlyClose({ data, changed }: RecordProps) {
  const [open, setOpen] = useState(false);
  const form = useRecordForm({
    data,
    changed,
    pageKey: "early-close",
    initial: { reason: "" },
  });
  const reason = form.work.values.reason.trim();
  return (
    <div className={styles.earlyClose}>
      <button
        type="button"
        className={styles.linkish}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Close request without fulfillment
      </button>
      <div hidden={!open} className={styles.claimpanel}>
        <SavedWorkFieldset ready={form.work.ready}>
          <p>
            Closing records your reason and closes this request without
            fulfillment. You can no longer edit its review or delivery details.
            Linked work items keep their own status.
          </p>
          <Field
            name="early-close-reason"
            label="Reason for closing without fulfillment"
            multiline
            value={form.work.values.reason}
            onChange={(value) => form.work.change("reason", value)}
          />
          <FormMessages form={form} />
          <Button
            type="button"
            disabled={form.pending || form.stale || !reason}
            onClick={() =>
              void form.action(
                "resolveRequest",
                {
                  outcome: "closed_without_fulfillment",
                  summary: reason,
                  reason,
                },
                "Request closed without fulfillment. Your reason was recorded.",
              )
            }
          >
            Close without fulfillment
          </Button>
          <Button type="button" outline onClick={() => setOpen(false)}>
            Cancel closure
          </Button>
        </SavedWorkFieldset>
      </div>
    </div>
  );
}

function CompletedActions({
  data,
  changed,
  store,
  priority,
}: RecordProps & {
  store: DraftStore;
  priority: PriorityView | null;
}) {
  const priorityOpen = Boolean(
    priority && !priority.complete && !data.delivery.resolution,
  );
  return (
    <>
      <div className={styles.done}>
        <strong>First review complete.</strong> Recorded decisions remain
        available here. Continue with delivery to carry out the next task.{" "}
        <OpenDeliveryLink />
        {priorityOpen && " You can still complete the priority estimates."}
      </div>
      {priorityOpen && (
        <PostReviewPrioritySave
          data={data}
          changed={changed}
          store={store}
          priority={priority}
        />
      )}
    </>
  );
}

function OpenDeliveryLink() {
  const path = usePathname();
  const query = useSearchParams();
  const next = new URLSearchParams(query.toString());
  next.set("section", "delivery");
  next.delete("return");
  next.delete("panel");
  return (
    <Link href={path + "?" + next} scroll={false}>
      Open delivery
    </Link>
  );
}

function FinishPanel({
  data,
  changed,
  store,
  priority,
}: RecordProps & {
  store: DraftStore;
  priority: PriorityView | null;
}) {
  const [error, setError] = useState("");
  const [ratingAttempted, setRatingAttempted] = useState(false);
  const form = useRecordForm({
    data,
    changed,
    pageKey: "submit-brief",
    initial: {
      idempotencyKey: "",
      nextOwner: data.review.nextOwner ?? "",
      deliveryOwnerActorId: data.review.deliveryOwnerActorId ?? "",
      nextTask: data.review.nextTask ?? "",
      system: "servicenow",
      requiredWork: "",
      supportingWork: "",
      rating: "",
    },
  });
  /* Re-derive the hold on every draft change or readiness transition. */
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const draftFor = draftReader(store.registry);
  const hold = completionHold(data, priority, draftFor);
  const pending = pendingDrafts(store.registry);
  const failed = failedDrafts(store.registry);
  const send = useFinishSend({
    data,
    priority,
    store,
    form,
    setError,
    setRatingAttempted,
  });
  return (
    <div>
      <RatingErrorSummary
        invalid={ratingAttempted && !form.work.values.rating}
      />
      <SavedWorkFieldset ready={form.work.ready}>
        <FinishFields
          hold={hold}
          form={form}
          data={data}
          ratingAttempted={ratingAttempted}
          setRatingAttempted={setRatingAttempted}
        />
        {error && (
          <p className="usa-error-message" role="alert">
            {error}
          </p>
        )}
        {/* The idle "No draft changes yet" describes only this form's own
         * saved work and contradicts visible claim drafts; every other
         * status (loading, failed, recovered, saving) still shows. */}
        <FormMessages
          form={form}
          showSaveStatus={form.work.status.kind !== "idle"}
        />
        <FinishButtons
          form={form}
          pending={pending}
          failed={failed}
          hold={hold}
          send={send}
        />
      </SavedWorkFieldset>
    </div>
  );
}

/** Both buttons wait for every registered draft owner's saved work: a send
 * before then would read initial values in place of a pending draft. */
function FinishButtons({
  form,
  pending,
  failed,
  hold,
  send,
}: {
  form: ReturnType<typeof useRecordForm>;
  pending: number;
  failed: number;
  hold: CompletionNeed[];
  send: (complete: boolean) => Promise<void>;
}) {
  const busy = form.pending || form.stale || !form.work.ready || pending > 0;
  return (
    <>
      <BoundaryHold pending={pending} failed={failed} />
      <div className={styles.verbs}>
        <Button
          type="button"
          outline
          disabled={busy}
          onClick={() => void send(false)}
        >
          Record progress
        </Button>
        <Button
          type="button"
          disabled={busy || hold.length > 0}
          onClick={() => void send(true)}
        >
          Complete first review
        </Button>
      </div>
    </>
  );
}

/** While the hold stands, the status sentence takes the completion form's
 * place; the routing and rating fields appear once every claim is settled,
 * and the final submit still validates them. */
function FinishFields({
  hold,
  form,
  data,
  ratingAttempted,
  setRatingAttempted,
}: {
  hold: CompletionNeed[];
  form: ReturnType<typeof useRecordForm>;
  data: RequestView;
  ratingAttempted: boolean;
  setRatingAttempted: (value: boolean) => void;
}) {
  if (hold.length > 0) return <CompletionNeeds hold={hold} />;
  return (
    <>
      <p className={styles.guidance}>
        The review changes you submit are recorded together.
      </p>
      <HandoffFields form={form} data={data} />
      <TaskRating
        value={form.work.values.rating}
        onChange={(value) => form.work.change("rating", value)}
        invalid={ratingAttempted && !form.work.values.rating}
        onMissing={() => setRatingAttempted(true)}
      />
    </>
  );
}

function CompletionNeeds({ hold }: { hold: CompletionNeed[] }) {
  return (
    <div className={styles.completionNeeds}>
      <p>
        <strong>Needed to complete review</strong>
      </p>
      {hold.map(({ section, messages }) => (
        <p key={section}>
          In{" "}
          {section === "risk" ? (
            completionSections[section]
          ) : (
            <a href={"#" + section + "-heading"}>
              {completionSections[section]}
            </a>
          )}
          ,{" "}
          {messages
            .map((message, index) =>
              index === 0 ? message : capitalize(message),
            )
            .join(" ")}
        </p>
      ))}
    </div>
  );
}

/** The boundary's waiting line: a failed owner outranks plain loading —
 * the state will not resolve by waiting, so the line names the reload. */
function BoundaryHold({
  pending,
  failed,
}: {
  pending: number;
  failed: number;
}) {
  if (failed === 1)
    return (
      <p className="usa-error-message" role="alert">
        One draft could not load. Reload before recording so no draft is missed.
      </p>
    );
  if (failed > 1)
    return (
      <p className="usa-error-message" role="alert">
        {failed} drafts could not load. Reload before recording so no drafts are
        missed.
      </p>
    );
  if (pending > 0)
    return (
      <p role="status">
        Drafts are still loading. Wait before recording the review.
      </p>
    );
  return null;
}

/** Both finish actions share one path: save-progress submits the drafts
 * alone; complete adds the completion payload to the same transaction. */
function useFinishSend({
  data,
  priority,
  store,
  form,
  setError,
  setRatingAttempted,
}: {
  data: RequestView;
  priority: PriorityView | null;
  store: DraftStore;
  form: ReturnType<typeof useRecordForm>;
  setError: (message: string) => void;
  setRatingAttempted: (value: boolean) => void;
}) {
  const registry = store.registry;
  const draftFor = draftReader(registry);
  function preflightProblem(
    complete: boolean,
    assembled: ReturnType<typeof assembleAssessmentPayload>,
  ): "rating" | string | null {
    if (!assembled.payload && !complete) return assembled.problem;
    /* Completion never silently drops an unfinished change. */
    if (complete && assembled.incomplete > 0)
      return "Finish the changed drafts that have missing information before completing the review.";
    if (complete && completionHold(data, priority, draftFor).length > 0)
      return "Review cannot be completed yet. Check the outstanding work listed.";
    if (complete && !form.work.values.rating) return "rating";
    return null;
  }
  return async function send(complete: boolean) {
    setError("");
    /* A submission before every owner's saved work loads — or before this
     * form's own nonce draft loads — would read initial values in place
     * of a pending saved draft. */
    if (pendingDrafts(registry) > 0 || !form.work.ready) {
      setError("Drafts are still loading. Wait before recording the review.");
      return;
    }
    const assembled = assembleAssessmentPayload(data, priority, draftFor);
    const problem = preflightProblem(complete, assembled);
    if (problem === "rating") {
      setRatingAttempted(true);
      return;
    }
    if (problem) {
      setError(problem);
      return;
    }
    const idempotencyKey =
      form.work.values.idempotencyKey || crypto.randomUUID();
    form.work.change("idempotencyKey", idempotencyKey);
    const snapshots = prioritySnapshots(registry, assembled.priorityDecisions);
    await form.action(
      SUBMIT_ASSESSMENT_ACTION,
      {
        idempotencyKey,
        ...(assembled.payload ?? emptyAssessment()),
        ...(complete && {
          complete: completionValues(form.work.values, data),
        }),
      },
      complete
        ? "First review completed. The delivery handoff is next."
        : "Decisions recorded. First review is still open.",
      async () => {
        form.work.change("idempotencyKey", "");
        await resetUnchangedPriorityDrafts(registry, snapshots);
      },
    );
  };
}

function draftReader(registry: DraftRegistry) {
  return (kind: DraftKind, id: string) =>
    registry.get(draftKey(kind, id))?.values ?? null;
}

/** A saved priority decision must not resubmit on the next save. The draft
 * clears after success — unless the person edited it mid-save, in which
 * case the newer edit survives. */
function prioritySnapshots(
  registry: DraftRegistry,
  decisions: PriorityDecisionInput[],
) {
  return decisions.map((decision) => {
    const entry = registry.get(draftKey("priority", decision.factor));
    return {
      factor: decision.factor,
      snapshot: JSON.stringify(entry?.values ?? {}),
    };
  });
}

/** Runs inside the send's recorded phase: the resets are flushed and
 * acknowledged before the refresh, so no cleared draft is left as an
 * unacknowledged local backup. */
async function resetUnchangedPriorityDrafts(
  registry: DraftRegistry,
  snapshots: Array<{ factor: string; snapshot: string }>,
) {
  const flushes: Array<Promise<void>> = [];
  for (const { factor, snapshot } of snapshots) {
    const entry = registry.get(draftKey("priority", factor as never));
    if (!entry?.reset) continue;
    if (JSON.stringify(entry.values) === snapshot) {
      entry.reset();
      if (entry.flush) flushes.push(entry.flush());
    }
  }
  await Promise.all(flushes);
}

/** After first review completes, unresolved priority work still needs a
 * save path: the same submission, priority decisions only. */
function PostReviewPrioritySave({
  data,
  changed,
  store,
  priority,
}: RecordProps & {
  store: DraftStore;
  priority: PriorityView | null;
}) {
  const [error, setError] = useState("");
  const registry = store.registry;
  /* Re-render on draft changes and readiness transitions, exactly as the
   * pre-completion form does. */
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const pending = pendingDrafts(registry);
  const form = useRecordForm({
    data,
    changed,
    pageKey: "post-review-priority",
    initial: { idempotencyKey: "" },
  });
  async function save() {
    setError("");
    if (pendingDrafts(registry) > 0 || !form.work.ready) {
      setError("Drafts are still loading. Wait before recording the review.");
      return;
    }
    const draftFor = draftReader(registry);
    const work = priorityDecisionsFromDrafts(priority, (factor) =>
      draftFor("priority", factor),
    );
    if (work.decisions.length === 0) {
      setError(
        work.incomplete > 0
          ? "Add valid values and explanations to the changed estimates before recording."
          : "No priority changes to record.",
      );
      return;
    }
    const idempotencyKey =
      form.work.values.idempotencyKey || crypto.randomUUID();
    form.work.change("idempotencyKey", idempotencyKey);
    const snapshots = prioritySnapshots(registry, work.decisions);
    await form.action(
      SUBMIT_ASSESSMENT_ACTION,
      { idempotencyKey, priorityDecisions: work.decisions },
      "Priority changes recorded.",
      async () => {
        form.work.change("idempotencyKey", "");
        await resetUnchangedPriorityDrafts(registry, snapshots);
      },
    );
  }
  return (
    <SavedWorkFieldset ready={form.work.ready}>
      <BoundaryHold pending={pending} failed={failedDrafts(registry)} />
      {error && (
        <p className="usa-error-message" role="alert">
          {error}
        </p>
      )}
      <FormMessages
        form={form}
        showSaveStatus={form.work.status.kind !== "idle"}
      />
      <Button
        type="button"
        disabled={form.pending || form.stale || !form.work.ready || pending > 0}
        onClick={() => void save()}
      >
        Record priority changes
      </Button>
    </SavedWorkFieldset>
  );
}

function emptyAssessment() {
  return {
    assetDecisions: [],
    riskDecisions: [],
    riskOutcome: false,
    priorityDecisions: [],
  };
}

/** The completion payload of submitAssessment: rating, delivery plan, and
 * simulated work plan, committed with the drafts in the same transaction. */
export function completionValues(
  values: Record<string, string>,
  data: RequestView,
) {
  const plan = deliveryPlanValues(values, data);
  return {
    rating: Number(values.rating),
    targetSystem: values.system,
    ...(plan.deliveryOwnerActorId
      ? {
          deliveryOwnerActorId: plan.deliveryOwnerActorId,
          ...(plan.nextTask && { nextTask: plan.nextTask }),
        }
      : values.nextOwner.trim() && { nextOwner: values.nextOwner.trim() }),
    workPlan: workPlan(values),
  };
}
