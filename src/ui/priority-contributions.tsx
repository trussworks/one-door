"use client";

import styles from "./review-brief.module.css";

import { useState } from "react";
import { Button, Label, Select } from "@trussworks/react-uswds";
import {
  priorityFactors,
  type PriorityDecisionInput,
  type PriorityEstimate,
  type PriorityFactor,
  type PriorityFactorView,
  type PriorityView,
} from "../domain/priority";
import type { RequestView } from "../server/request-views";
import type { RecordProps } from "./record-form";
import { useRecordForm } from "./record-form";
import { useApp } from "./shell";
import { Field, Problem, SavedWorkFieldset } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { useSavedWork } from "./use-saved-work";
import { useData } from "./use-data";
import {
  ASK_INPUT_ACTION,
  ANSWER_INPUT_ACTION,
  ASSIGN_INPUT_ACTION,
  acceptFactorEntry,
  displayEstimate,
  entryError,
  entryToValue,
  factorLabels,
  inputRequestsOf,
  type ReviewInputRow,
} from "./review-input-contracts";

type DraftValues = Record<string, string>;
export type PriorityRegister = (
  factor: PriorityFactor,
  values: DraftValues,
  owner: {
    ready: boolean;
    failed?: boolean;
    reset?: () => void;
    flush?: () => Promise<void>;
  },
) => void;

/** Builds the per-factor decision array for one submission from the factor
 * drafts. Incomplete drafts are counted, never sent. */
export function priorityDecisionsFromDrafts(
  priority: PriorityView | null,
  draftFor: (factor: PriorityFactor) => DraftValues | null,
): { decisions: PriorityDecisionInput[]; incomplete: number } {
  if (!priority) return { decisions: [], incomplete: 0 };
  let incomplete = 0;
  const decisions = priority.factors.flatMap(
    (view): PriorityDecisionInput[] => {
      const draft = draftFor(view.factor);
      if (!draft || !draft.action) return [];
      const built = buildDecision(view.factor, draft);
      if (!built) {
        incomplete++;
        return [];
      }
      return [built];
    },
  );
  return { decisions, incomplete };
}

function buildDecision(
  factor: PriorityFactor,
  draft: DraftValues,
): PriorityDecisionInput | null {
  if (draft.action === "adopt") return buildAdopt(factor, draft);
  if (draft.action === "reject") return buildReject(factor, draft);
  if (draft.action === "replace") return buildReplace(factor, draft);
  return null;
}

function buildAdopt(
  factor: PriorityFactor,
  draft: DraftValues,
): PriorityDecisionInput | null {
  if (!draft.proposalId) return null;
  return { factor, action: "adopt", proposalId: draft.proposalId };
}

function buildReject(
  factor: PriorityFactor,
  draft: DraftValues,
): PriorityDecisionInput | null {
  const reason = draft.reason?.trim();
  if (!reason) return null;
  return {
    factor,
    action: "reject",
    ...(draft.proposalId && { proposalId: draft.proposalId }),
    reason,
  };
}

function replaceEstimate(
  factor: PriorityFactor,
  draft: DraftValues,
): PriorityEstimate | null {
  const value = entryToValue(factor, draft.value ?? "");
  const basis = draft.basis?.trim();
  if (value === null || !basis) return null;
  if (entryError(factor, draft.value ?? "")) return null;
  if (factor !== "reach") return { value, basis };
  return reachReplaceEstimate(value, basis, draft);
}

function reachReplaceEstimate(
  value: number,
  basis: string,
  draft: DraftValues,
): PriorityEstimate | null {
  const unit = draft.unit?.trim();
  const period = draft.period?.trim();
  if (!unit || !period) return null;
  return { value, basis, unit, period };
}

function buildReplace(
  factor: PriorityFactor,
  draft: DraftValues,
): PriorityDecisionInput | null {
  const estimate = replaceEstimate(factor, draft);
  if (!estimate) return null;
  return {
    factor,
    action: "replace",
    ...(draft.proposalId && { proposalId: draft.proposalId }),
    estimate,
    ...(draft.reason?.trim() && { reason: draft.reason.trim() }),
  };
}

export function PriorityFactors({
  data,
  changed,
  priority,
  register,
  mutable,
  inputRows = [],
  administrative = false,
}: RecordProps & {
  priority: PriorityView;
  register: PriorityRegister;
  mutable: boolean;
  inputRows?: ReviewInputRow[];
  administrative?: boolean;
}) {
  /* One controller owns the retired form's draft: server row, browser
   * backup, readiness, and failure all flow through the existing
   * saved-work guarantees, and the trigger gates on live values, so a
   * successful send clears it without a refresh. */
  const legacyForm = useRecordForm({
    data,
    changed,
    pageKey: "ask-input",
    initial: {
      factor: "",
      question: "",
      scope: "",
      expertise: "",
      addressee: "",
      inputRequestId: "",
    },
  });
  const legacyState = legacyForm.work.ready
    ? legacyAskState(legacyForm.work.values)
    : null;
  const recovery =
    mutable && legacyState ? (
      <LegacyAskRecovery form={legacyForm} state={legacyState} />
    ) : null;
  return (
    <>
      {legacyForm.work.status.kind === "loadFailed" && (
        <Problem>
          Your earlier question draft could not load. Reload to check for unsent
          work.
        </Problem>
      )}
      {legacyState && !legacyState.known && recovery}
      {priority.factors.map((view) => (
        <FactorLine
          key={view.factor}
          data={data}
          changed={changed}
          view={view}
          register={register}
          mutable={mutable}
          administrative={administrative}
          legacySlot={
            legacyState?.known && legacyState.home === view.factor
              ? recovery
              : null
          }
          rows={inputRows.filter((row) => row.factor === view.factor)}
        />
      ))}
    </>
  );
}

/** The recovery form for the retired ask draft: the parent's controller
 * is the only owner. A junk stored factor shows its correction select
 * with the original value named; the words stay as the reviewer left
 * them. */
function LegacyAskRecovery({
  form,
  state,
}: {
  form: ReturnType<typeof useRecordForm>;
  state: NonNullable<LegacyAskState>;
}) {
  const [open, setOpen] = useState(false);
  const values = form.work.values;
  const factorOk =
    state.known ||
    (priorityFactors as readonly string[]).includes(values.factor);
  const ready =
    values.question.trim() &&
    (values.expertise.trim() || values.addressee) &&
    factorOk;
  const send = askSend(
    form,
    "rice",
    undefined,
    state.known ? state.home : undefined,
  );
  return (
    <div>
      <button
        type="button"
        className={styles.linkish}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Recover your earlier unsent question
      </button>
      <div hidden={!open} className={styles.claimBody}>
        <SavedWorkFieldset ready={form.work.ready}>
          {!state.known && (
            <>
              <Problem>
                The question draft has an unrecognized factor:{" "}
                {state.storedFactor}. Choose the correct factor; your question
                is retained.
              </Problem>
              <Label htmlFor="legacy-ask-factor">
                Factor for this question
              </Label>
              <Select
                id="legacy-ask-factor"
                name="legacy-ask-factor"
                value={factorOk ? values.factor : ""}
                onChange={(event) =>
                  form.work.change("factor", event.target.value)
                }
              >
                <option value="">Choose a factor</option>
                {priorityFactors.map((factor) => (
                  <option key={factor} value={factor}>
                    {factorLabels[factor]}
                  </option>
                ))}
              </Select>
            </>
          )}
          <AskFields form={form} prefix="ask-" />
          <FormMessages form={form} />
          <Button
            type="button"
            disabled={form.pending || form.stale || !ready}
            onClick={() => void send()}
          >
            Ask question
          </Button>
        </SavedWorkFieldset>
      </div>
    </div>
  );
}

/** Names everyone behind a reviewed estimate. The supplier alone must not
 * read as having personally entered the row: when someone else recorded
 * it (an old full-score row, an on-behalf entry), the recorder is named,
 * unless the reviewed-by line already names the same person. */
export function reviewedAttribution(
  reviewed: {
    suppliedByActorId: string;
    recordedByActorId: string;
    reviewerActorId: string | null;
  },
  nameFor: (id: string | null) => string,
): string {
  const parts = ["Supplied by " + nameFor(reviewed.suppliedByActorId)];
  if (
    reviewed.recordedByActorId !== reviewed.suppliedByActorId &&
    reviewed.recordedByActorId !== reviewed.reviewerActorId
  )
    parts.push("Recorded by " + nameFor(reviewed.recordedByActorId));
  if (reviewed.reviewerActorId)
    parts.push("Reviewed by " + nameFor(reviewed.reviewerActorId));
  return parts.join(" · ");
}

/** The one-line reading of a factor: the reviewed estimate, the single
 * proposal awaiting review, or the missing state — never an invented value. */
export function factorLineValue(view: PriorityFactorView): string {
  if (view.reviewed)
    return displayEstimate(view.factor, view.reviewed.estimate);
  if (view.status === "rejected") return "Proposal rejected";
  const current = view.proposals.filter(
    (proposal) => proposal.current && proposal.estimate.value !== null,
  );
  if (current.length === 1)
    return (
      displayEstimate(view.factor, current[0].estimate) + " (Awaiting review)"
    );
  if (current.length > 1) return "Proposals awaiting review: " + current.length;
  return "No estimate";
}

export function factorLineAttribution(
  view: PriorityFactorView,
  nameFor: (id: string | null) => string,
): string | null {
  if (view.reviewed) return reviewedAttribution(view.reviewed, nameFor);
  const current = view.proposals.filter(
    (proposal) => proposal.current && proposal.estimate.value !== null,
  );
  if (current.length !== 1) return null;
  const proposal = current[0];
  const parts = [
    proposal.source === "requester"
      ? "Requester proposal"
      : "Contributor proposal",
    "Supplied by " + nameFor(proposal.suppliedByActorId),
  ];
  if (proposal.recordedByActorId !== proposal.suppliedByActorId)
    parts.push("Recorded by " + nameFor(proposal.recordedByActorId));
  return parts.join(" · ");
}

/** The draft's effective outcome, scannable on the line while the editor is
 * closed and explicitly named as a draft. */
export function factorDraftSummary(
  factor: PriorityFactor,
  values: DraftValues,
): string | null {
  if (!values.action) return null;
  if (values.action === "adopt")
    return values.proposalId
      ? "Draft: adopt proposal"
      : "Draft: choose a proposal to adopt";
  if (values.action === "reject")
    return values.reason?.trim()
      ? "Draft: reject proposal"
      : "Draft: give a reason for rejection";
  const estimate = replaceEstimate(factor, values);
  return estimate
    ? "Draft: use " + displayEstimate(factor, estimate)
    : "Draft: estimate change incomplete or invalid";
}

function FactorLine({
  data,
  changed,
  view,
  register,
  mutable,
  rows,
  administrative,
  legacySlot,
}: RecordProps & {
  view: PriorityFactorView;
  register: PriorityRegister;
  mutable: boolean;
  rows: ReviewInputRow[];
  administrative: boolean;
  legacySlot: React.ReactNode;
}) {
  const { metadata } = useApp();
  const [editing, setEditing] = useState(false);
  const work = useSavedWork(
    {
      visitorId: metadata.visitor.visitorId,
      actingView: "contributor",
      pageKey: "priority-" + view.factor,
      subjectKey: data.record.requestId,
    },
    {
      action: "",
      proposalId: "",
      value: "",
      unit: "",
      period: "",
      basis: "",
      reason: "",
    },
  );
  if (mutable) registerFactor(register, view.factor, work);
  const actorName = (id: string | null) =>
    metadata.actors.find((actor) => actor.id === id)?.displayName ??
    "Unknown person";
  const attribution = factorLineAttribution(view, actorName);
  const draftLine = mutable
    ? factorDraftSummary(view.factor, work.values)
    : null;
  let toggleLabel = "Collapse estimate";
  if (!editing) toggleLabel = mutable ? "Edit estimate" : "View estimate";
  return (
    <div className={styles.estline} data-factor={view.factor}>
      <strong>{factorLabels[view.factor]}:</strong> {factorLineValue(view)}
      <FactorLineNotes attribution={attribution} draftLine={draftLine} />{" "}
      <button
        type="button"
        className={styles.linkish}
        aria-expanded={editing}
        onClick={() => setEditing(!editing)}
      >
        {toggleLabel}
      </button>
      <SavedWorkProblem work={work} />
      {editing && (
        <FactorPanel
          data={data}
          changed={changed}
          view={view}
          work={work}
          mutable={mutable}
          actorName={actorName}
          legacySlot={legacySlot}
        />
      )}
      <InputRequests
        data={data}
        changed={changed}
        administrative={administrative}
        rows={rows}
      />
    </div>
  );
}

function registerFactor(
  register: PriorityRegister,
  factor: PriorityFactor,
  work: ReturnType<typeof useSavedWork>,
) {
  register(factor, work.values, {
    ready: work.ready,
    failed: work.status.kind === "loadFailed",
    reset: () => {
      for (const key of Object.keys(work.values)) work.change(key, "");
    },
    flush: work.flush,
  });
}

function FactorLineNotes({
  attribution,
  draftLine,
}: {
  attribution: string | null;
  draftLine: string | null;
}) {
  return (
    <>
      {attribution && <span className={styles.by}> — {attribution}</span>}
      {draftLine && (
        <span className={styles.status + " " + styles.stDraft}>
          {" "}
          ({draftLine})
        </span>
      )}
    </>
  );
}

/** A bare saved-work owner names its failed load itself; the submission
 * boundary only says work is pending. The control gives the reload path. */
export function SavedWorkProblem({
  work,
}: {
  work: ReturnType<typeof useSavedWork>;
}) {
  if (work.status.kind !== "loadFailed") return null;
  return (
    <p className="usa-error-message" role="alert">
      {work.status.message}{" "}
      <button
        type="button"
        className={styles.linkish}
        onClick={() => window.location.reload()}
      >
        Reload page
      </button>
    </p>
  );
}

function FactorPanel({
  data,
  changed,
  view,
  work,
  mutable,
  actorName,
  legacySlot,
}: RecordProps & {
  view: PriorityFactorView;
  work: ReturnType<typeof useSavedWork>;
  mutable: boolean;
  actorName: (id: string | null) => string;
  legacySlot: React.ReactNode;
}) {
  return (
    <div className={styles.claimpanel}>
      {view.reviewed && (
        <p className={styles.provenance}>
          Reviewed estimate:{" "}
          {displayEstimate(view.factor, view.reviewed.estimate)}
          {view.reviewed.estimate.basis &&
            " — " + view.reviewed.estimate.basis}{" "}
          · {reviewedAttribution(view.reviewed, actorName)}
        </p>
      )}
      <ProposalList view={view} actorName={actorName} />
      {mutable && <FactorEditor view={view} work={work} />}
      {mutable && (
        <AskForInput
          data={data}
          changed={changed}
          factor={view.factor}
          summary={
            view.status === "missing"
              ? "Ask for an estimate"
              : "Ask about this estimate"
          }
        />
      )}
      {legacySlot}
    </div>
  );
}

function ProposalList({
  view,
  actorName,
}: {
  view: PriorityFactorView;
  actorName: (id: string | null) => string;
}) {
  if (view.proposals.length === 0 && !view.reviewed)
    return (
      <p className={styles.provenance}>
        No estimate has been proposed. Enter a value and explain what supports
        it, or ask for input.
      </p>
    );
  return (
    <>
      {view.proposals.map((proposal) => (
        <p key={proposal.id} className={styles.estimateRow}>
          Proposed estimate: {displayEstimate(view.factor, proposal.estimate)}
          {proposal.estimate.basis && " — " + proposal.estimate.basis}{" "}
          <span className={styles.by}>
            ·{" "}
            {proposal.source === "requester"
              ? "Requester proposal"
              : "Contributor proposal"}{" "}
            · Supplied by {actorName(proposal.suppliedByActorId)}
            {proposal.recordedByActorId !== proposal.suppliedByActorId &&
              " · Recorded by " + actorName(proposal.recordedByActorId)}
            {!proposal.current && " · No longer current"}
          </span>
        </p>
      ))}
    </>
  );
}

function FactorEditor({
  view,
  work,
}: {
  view: PriorityFactorView;
  work: ReturnType<typeof useSavedWork>;
}) {
  const factor = view.factor;
  const adoptable = view.proposals.filter(
    (proposal) => proposal.current && proposal.estimate.value !== null,
  );
  return (
    <fieldset className="usa-fieldset" disabled={!work.ready}>
      <Label htmlFor={"priority-action-" + factor}>
        How will you handle this estimate?
      </Label>
      <Select
        id={"priority-action-" + factor}
        name={"priority-action-" + factor}
        value={work.values.action}
        onChange={(event) => work.change("action", event.target.value)}
      >
        <option value="">Leave unchanged</option>
        {adoptable.length > 0 && (
          <option value="adopt">Adopt a proposal</option>
        )}
        <option value="replace">Enter or replace a value</option>
        {view.proposals.length > 0 && (
          <option value="reject">Reject a proposal</option>
        )}
      </Select>
      {work.values.action === "adopt" && (
        <AdoptPicker view={view} work={work} adoptable={adoptable} />
      )}
      {work.values.action === "replace" && (
        <ReplaceFields factor={factor} work={work} />
      )}
      {(work.values.action === "reject" ||
        (work.values.action === "replace" && view.proposals.length > 0)) && (
        <Field
          name={"priority-reason-" + factor}
          label={
            work.values.action === "reject"
              ? "Reason for rejecting the proposal"
              : "Reason for choosing this value (optional)"
          }
          multiline
          required={work.values.action === "reject"}
          value={work.values.reason}
          onChange={(value) => work.change("reason", value)}
        />
      )}
      {work.values.action && (
        <p className={styles.draftState}>
          Your changed decisions remain drafts until you record them.
        </p>
      )}
    </fieldset>
  );
}

function AdoptPicker({
  view,
  work,
  adoptable,
}: {
  view: PriorityFactorView;
  work: ReturnType<typeof useSavedWork>;
  adoptable: PriorityFactorView["proposals"];
}) {
  return (
    <>
      <Label htmlFor={"priority-proposal-" + view.factor}>
        Proposal to review
      </Label>
      <Select
        id={"priority-proposal-" + view.factor}
        name={"priority-proposal-" + view.factor}
        value={work.values.proposalId}
        onChange={(event) => work.change("proposalId", event.target.value)}
      >
        <option value="">Choose a proposal</option>
        {adoptable.map((proposal) => (
          <option key={proposal.id} value={proposal.id}>
            {displayEstimate(view.factor, proposal.estimate)}
            {proposal.estimate.basis && " — " + proposal.estimate.basis}
          </option>
        ))}
      </Select>
    </>
  );
}

const valueLabels: Record<PriorityFactor, string> = {
  reach: "Reach count",
  impact: "Impact value",
  confidence: "Confidence (%)",
  effort: "Total working days",
};

function ReplaceFields({
  factor,
  work,
}: {
  factor: PriorityFactor;
  work: ReturnType<typeof useSavedWork>;
}) {
  const hints: Partial<Record<PriorityFactor, string>> = {
    effort:
      "Add the working days for everyone involved. Twenty working days equal one person-month.",
    confidence:
      "Rate the evidence behind the estimates. Guideposts: 80% strong evidence, 50% partial evidence, 20% an early assumption.",
  };
  const valueProblem = entryError(factor, work.values.value ?? "");
  return (
    <>
      <Field
        name={"priority-value-" + factor}
        label={valueLabels[factor]}
        value={work.values.value}
        onChange={(value) => {
          if (acceptFactorEntry(factor, value)) work.change("value", value);
        }}
        hint={hints[factor]}
        inputMode={factor === "reach" ? "numeric" : "decimal"}
        pattern={factor === "reach" ? "[0-9]+" : undefined}
        narrow
      />
      {valueProblem && <Problem>{valueProblem}</Problem>}
      {factor === "reach" && (
        <>
          <Field
            name="priority-reach-unit"
            label="Unit counted"
            value={work.values.unit}
            onChange={(value) => work.change("unit", value)}
            hint="For example, people or teams."
          />
          <Field
            name="priority-reach-period"
            label="Time period"
            value={work.values.period}
            onChange={(value) => work.change("period", value)}
            hint="For example, one month or one year."
          />
        </>
      )}
      <Field
        name={"priority-basis-" + factor}
        label="What supports this estimate?"
        multiline
        value={work.values.basis}
        onChange={(value) => work.change("basis", value)}
      />
    </>
  );
}

/** The retired priority form's saved entries, in its units: confidence
 * was percent and effort person-months (riceCommand sent them onward
 * as fraction and months). Only known string fields render; metadata
 * and unknown keys stay out. */
export function earlierRiceEntries(
  payload: Record<string, unknown> | null | undefined,
  nameFor?: (actorId: string) => string,
): Array<{ label: string; value: string }> {
  if (!payload) return [];
  const text = (key: string) => {
    const value = payload[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const entries: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string) => {
    if (value) entries.push({ label, value });
  };
  push("Reach", text("reach"));
  push("Earlier Reach unit", text("reachUnit"));
  push("Earlier Reach period", text("reachPeriod"));
  push("Impact", text("impact"));
  if (text("confidence")) push("Confidence", text("confidence") + "%");
  if (text("effort")) push("Effort", text("effort") + " person-months");
  push("Explanation for earlier Reach", text("reachRationale"));
  push("Explanation for earlier Impact", text("impactRationale"));
  push("Explanation for earlier Confidence", text("confidenceRationale"));
  push("Explanation for earlier Effort", text("effortRationale"));
  /* The attribution names who the earlier form credited for the effort
   * estimate — never a raw id, and never a claim that they entered it. */
  const attributed = text("effortActorId");
  if (attributed && nameFor)
    push("Person named for the earlier Effort estimate", nameFor(attributed));
  return entries;
}

/** Compatibility access to the current visitor's own draft from the
 * retired priority form. Reference only: nothing imports into the new
 * factor drafts, and the reviewed estimates stay separate. The WIP read
 * is session-scoped, so nobody sees another person's draft. */
export function EarlierPriorityForm({ data }: { data: RequestView }) {
  const { metadata } = useApp();
  const source = useData<{ payload?: Record<string, unknown> } | null>(
    "/api/wip?" +
      new URLSearchParams({
        actingView: "contributor",
        pageKey: "rice",
        subjectKey: data.record.requestId,
      }),
  );
  const entries = earlierRiceEntries(
    source.data?.payload,
    (actorId) =>
      metadata.actors.find((actor) => actor.id === actorId)?.displayName ?? "",
  );
  if (entries.length === 0) return null;
  return (
    <details className={styles.claim}>
      <summary>Your earlier estimate drafts</summary>
      <div className={styles.claimBody}>
        <p>
          These entries are your private drafts. They have not been adopted as
          current reviewed values.
        </p>
        {entries.map((entry) => (
          <p key={entry.label} className={styles.estimateRow}>
            {entry.label}: {entry.value}
          </p>
        ))}
      </div>
    </details>
  );
}

/** Open questions and their replies. Only the explicitly allocated person
 * can answer an internal question; an unassigned question waits on the
 * administrator's allocation. */
export function InputRequests({
  data,
  changed,
  rows,
  administrative = false,
}: RecordProps & { rows: ReviewInputRow[]; administrative?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <InputRequestRow
          key={row.id}
          data={data}
          changed={changed}
          row={row}
          administrative={administrative}
        />
      ))}
    </>
  );
}

function InputRequestRow({
  data,
  changed,
  row,
  administrative = false,
}: RecordProps & { row: ReviewInputRow; administrative?: boolean }) {
  const { metadata } = useApp();
  const closed = Boolean(data.delivery.resolution);
  const showAnswer = !closed && canAnswerRow(row, metadata.visitor.actorId);
  const showAssign = !closed && canAssignRow(row, administrative);
  return (
    <div className={styles.estimateRow}>
      <RowStateChip row={row} /> <InputRequestQuestion row={row} />
      {row.latestResponse && <LatestAnswer row={row} />}
      {showAssign && <AssignControl data={data} changed={changed} row={row} />}
      {awaitingAllocation(row, closed || showAssign) && (
        <p className={styles.provenance}>
          An administrator needs to choose someone to answer.
        </p>
      )}
      {showAnswer && <AnswerForm data={data} changed={changed} row={row} />}
    </div>
  );
}

function RowStateChip({ row }: { row: ReviewInputRow }) {
  const open = row.state === "open";
  const askedOf = row.assigneeName ?? row.expertise ?? row.audience;
  return (
    <span
      className={
        styles.statusChip + " " + (open ? styles.stWaiting : styles.stConfirmed)
      }
    >
      {open ? "Waiting for " + askedOf : "Answer available for review"}
    </span>
  );
}

function awaitingAllocation(row: ReviewInputRow, handled: boolean): boolean {
  return (
    !handled &&
    row.state === "open" &&
    row.audience === "internal" &&
    !row.assigneeActorId
  );
}

/** Only the named addressee can answer, and can keep answering while the
 * question stays open: an "I don't know" today can become evidence
 * tomorrow. Earlier replies stay in the record. The backend enforces the
 * same identity; an unassigned question waits on allocation instead of
 * offering a form that would be refused. */
export function canAnswerRow(row: ReviewInputRow, actorId: string): boolean {
  /* A replied question sits in state "answered" until a decision resolves
   * it; the addressee can still replace their reply there. */
  if (row.state === "resolved" || !row.current) return false;
  return row.assigneeActorId === actorId;
}

function canAssignRow(row: ReviewInputRow, administrative: boolean): boolean {
  return administrative && row.state === "open" && row.audience === "internal";
}

function InputRequestQuestion({ row }: { row: ReviewInputRow }) {
  return (
    <>
      {row.factor && factorLabels[row.factor] + ": "}
      {row.question} <InputRequestByline row={row} />
    </>
  );
}

/** One allocation decision: name who should answer. Assignment addresses
 * the question; it never re-evaluates the review or creates a role. */
function AssignControl({
  data,
  changed,
  row,
}: RecordProps & { row: ReviewInputRow }) {
  const form = useRecordForm({
    data,
    changed,
    pageKey: "assign-input-" + row.id,
    initial: { assignee: row.assigneeActorId ?? "" },
  });
  const { metadata } = useApp();
  return (
    <SavedWorkFieldset ready={form.work.ready}>
      <Label htmlFor={"assign-input-" + row.id}>
        Person responsible for answering
      </Label>
      <Select
        id={"assign-input-" + row.id}
        name={"assign-input-" + row.id}
        value={form.work.values.assignee}
        onChange={(event) => form.work.change("assignee", event.target.value)}
      >
        <option value="">Unassigned</option>
        {metadata.actors
          .filter((actor) => actor.kind === "visitor")
          .map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.id === metadata.visitor.actorId
                ? actor.displayName + " (you)"
                : actor.displayName}
            </option>
          ))}
      </Select>
      <FormMessages form={form} />
      <Button
        type="button"
        outline
        disabled={form.pending || form.stale}
        onClick={() =>
          void form.action(
            ASSIGN_INPUT_ACTION,
            {
              inputRequestId: row.id,
              expectedInputVersion: row.rowVersion,
              assigneeActorId: form.work.values.assignee || null,
            },
            "Question assigned.",
          )
        }
      >
        Assign question
      </Button>
    </SavedWorkFieldset>
  );
}

function InputRequestByline({ row }: { row: ReviewInputRow }) {
  const recipient = row.assigneeName ?? row.expertise ?? row.audience;
  return (
    <span className={styles.by}>
      — For: {recipient}
      {row.askedByName && " · Asked by " + row.askedByName}
      {row.scope && " · Scope: " + row.scope}
    </span>
  );
}

function LatestAnswer({ row }: { row: ReviewInputRow }) {
  const response = row.latestResponse;
  if (!response) return null;
  return (
    <p className={styles.provenance}>
      {(response.respondentName ?? "Unknown person") +
        (response.outcome === "unknown"
          ? " could not supply the information: "
          : " replied: ") +
        response.answer}
      {row.state !== "resolved" &&
        response.outcome === "provided" &&
        " Review the reply and record the related decision."}
    </p>
  );
}

/** A number the stored precision cannot hold must stop the send with the
 * reason, not travel and fail with a generic validation error. */
export function answerValueProblem(
  row: ReviewInputRow,
  values: DraftValues,
): string | null {
  if (row.area !== "rice" || !row.factor || values.outcome === "unknown")
    return null;
  return entryError(row.factor, values.value ?? "");
}

export function answerPayload(row: ReviewInputRow, values: DraftValues) {
  const unknown = values.outcome === "unknown";
  const estimateValue =
    row.area === "rice" && row.factor && !unknown
      ? entryToValue(row.factor, values.value)
      : null;
  return {
    inputRequestId: row.id,
    expectedInputVersion: row.rowVersion,
    answer: values.answer.trim(),
    outcome: unknown ? "unknown" : "provided",
    ...(estimateValue !== null &&
      row.factor && {
        proposal: {
          factor: row.factor,
          estimate: {
            value: estimateValue,
            basis: values.basis.trim() || values.answer.trim(),
          },
        },
      }),
  };
}

/** One id per reply attempt. A retry of an unacknowledged attempt keeps
 * its id so the backend replay check stays idempotent; once the stored id
 * matches the recorded latest reply, the next send is a revision and
 * mints a fresh id — reusing a recorded id trips the backend's conflict
 * guard. */
export function answerAttemptId(
  row: ReviewInputRow,
  values: DraftValues,
): string {
  const stored = values.responseId;
  /* A reassigned question can hold the stored id deeper in its history
   * (asked of A, then B, then A again), so any recorded response id counts
   * as acknowledged; only an id the record has never seen is a retry. */
  const recorded =
    stored &&
    (row.responses?.some((response) => response.id === stored) ||
      row.latestResponse?.id === stored);
  if (stored && !recorded) return stored;
  return crypto.randomUUID();
}

/** An update starts from the reply it replaces; earlier replies stay in
 * the record. */
function answerInitial(row: ReviewInputRow) {
  return {
    outcome: row.latestResponse?.outcome ?? "provided",
    answer: row.latestResponse?.answer ?? "",
    value: "",
    basis: "",
    responseId: "",
  };
}

function answerSendDisabled(
  form: ReturnType<typeof useRecordForm>,
  row: ReviewInputRow,
) {
  return (
    form.pending ||
    form.stale ||
    !form.work.values.answer.trim() ||
    answerValueProblem(row, form.work.values) !== null
  );
}

function AnswerForm({
  data,
  changed,
  row,
}: RecordProps & { row: ReviewInputRow }) {
  const form = useRecordForm({
    data,
    changed,
    pageKey: "answer-input-" + row.id,
    initial: answerInitial(row),
  });
  const unknown = form.work.values.outcome === "unknown";
  const offerEstimate = row.area === "rice" && row.factor && !unknown;
  async function send() {
    const responseId = answerAttemptId(row, form.work.values);
    form.work.change("responseId", responseId);
    await form.action(
      ANSWER_INPUT_ACTION,
      { responseId, ...answerPayload(row, form.work.values) },
      "Answer recorded for review.",
    );
  }
  return (
    <SavedWorkFieldset ready={form.work.ready}>
      <p className={styles.draftState}>
        {row.latestResponse
          ? "You can update this answer while the question remains unresolved. Earlier answers stay in the history."
          : "Answer the question, or say if you cannot supply the information."}
      </p>
      <Label htmlFor={"answer-outcome-" + row.id}>
        Can you supply the information?
      </Label>
      <Select
        id={"answer-outcome-" + row.id}
        name={"answer-outcome-" + row.id}
        value={form.work.values.outcome}
        onChange={(event) => form.work.change("outcome", event.target.value)}
      >
        <option value="provided">I can supply information</option>
        <option value="unknown">I cannot supply the information</option>
      </Select>
      <Field
        name={"answer-text-" + row.id}
        label={
          unknown
            ? "What would help get the missing information?"
            : "Your answer"
        }
        multiline
        value={form.work.values.answer}
        onChange={(value) => form.work.change("answer", value)}
      />
      {offerEstimate && row.factor && (
        <AnswerEstimateFields row={row} factor={row.factor} form={form} />
      )}
      <FormMessages form={form} />
      <Button
        type="button"
        disabled={answerSendDisabled(form, row)}
        onClick={() => void send()}
      >
        {row.latestResponse ? "Update answer" : "Submit answer"}
      </Button>
    </SavedWorkFieldset>
  );
}

function AnswerEstimateFields({
  row,
  factor,
  form,
}: {
  row: ReviewInputRow;
  factor: PriorityFactor;
  form: ReturnType<typeof useRecordForm>;
}) {
  const valueProblem = entryError(factor, form.work.values.value ?? "");
  return (
    <>
      <Field
        name={"answer-value-" + row.id}
        label={valueLabels[factor]}
        value={form.work.values.value}
        onChange={(value) => {
          if (acceptFactorEntry(factor, value))
            form.work.change("value", value);
        }}
        hint="Add a numeric estimate if you have one. The estimate will be a proposal for the reviewer."
        inputMode={factor === "reach" ? "numeric" : "decimal"}
        pattern={factor === "reach" ? "[0-9]+" : undefined}
        narrow
      />
      {valueProblem && <Problem>{valueProblem}</Problem>}
      <Field
        name={"answer-basis-" + row.id}
        label="What supports your estimate?"
        value={form.work.values.basis}
        onChange={(value) => form.work.change("basis", value)}
      />
    </>
  );
}

export type AskArea = "rice" | "assets" | "risk";
export type AskTarget = { candidateId?: string; findingId?: string };

/** One bounded internal question payload. The factor travels only on rice
 * questions; a candidate or finding id ties the question to the decision
 * that needs the answer. */
export function askPayload(
  values: DraftValues,
  area: AskArea,
  target: AskTarget | undefined,
  inputRequestId: string,
) {
  const payload: Record<string, string> = {
    inputRequestId,
    area,
    audience: "internal",
    question: values.question.trim(),
  };
  const optional = {
    factor: area === "rice" ? values.factor : "",
    candidateId: target?.candidateId ?? "",
    findingId: target?.findingId ?? "",
    scope: values.scope.trim(),
    expertise: values.expertise.trim(),
    assigneeActorId: values.addressee,
  };
  for (const [key, value] of Object.entries(optional))
    if (value) payload[key] = value;
  return payload;
}

/** Files one bounded internal question — a missing rice estimate, or the
 * information a fit or risk decision is waiting on. Requester questions
 * keep their own clarification channel. Naming a person is optional and
 * never a role assignment. The trigger is a deliberate link-styled
 * action at the claim or factor being worked on; the form stays mounted
 * while hidden so a typed draft survives closing the reveal. */
export function AskForInput({
  data,
  changed,
  area = "rice",
  target,
  factor,
  summary = "Ask for an estimate",
}: RecordProps & {
  area?: AskArea;
  target?: AskTarget;
  factor?: PriorityFactor;
  summary?: string;
}) {
  const [open, setOpen] = useState(false);
  const { pageKey, prefix } = askKeys(target, factor);
  const form = useRecordForm({
    data,
    changed,
    pageKey,
    initial: {
      factor: "effort",
      question: "",
      scope: "",
      expertise: "",
      addressee: "",
      inputRequestId: "",
    },
  });
  const values = form.work.values;
  const ready =
    values.question.trim() && (values.expertise.trim() || values.addressee);
  const send = askSend(form, area, target, factor);
  return (
    <div>
      <button
        type="button"
        className={styles.linkish}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {summary}
      </button>
      <div hidden={!open} className={styles.claimBody}>
        <SavedWorkFieldset ready={form.work.ready}>
          <AskFields form={form} prefix={prefix} />
          <FormMessages form={form} />
          <Button
            type="button"
            disabled={form.pending || form.stale || !ready}
            onClick={() => void send()}
          >
            Ask question
          </Button>
        </SavedWorkFieldset>
      </div>
    </div>
  );
}

/** The retired generic ask form's draft, when it still holds a question.
 * The factor is the draft's own — never reassigned. An absent factor
 * keeps the old form's untouched initial meaning (effort); an explicit
 * junk value is surfaced for correction, never silently relabeled. */
export type LegacyAskState = {
  home: PriorityFactor;
  known: boolean;
  storedFactor: string;
} | null;

export function legacyAskState(values: DraftValues): LegacyAskState {
  if (!values.question?.trim()) return null;
  const stored = values.factor ?? "";
  if ((priorityFactors as readonly string[]).includes(stored))
    return {
      home: stored as PriorityFactor,
      known: true,
      storedFactor: stored,
    };
  if (stored === "") return { home: "effort", known: true, storedFactor: "" };
  return { home: "effort", known: false, storedFactor: stored };
}

/* Several ask forms can share the page; ids stay unique per target or
 * factor. The retired generic form's "ask-input" draft is deliberately
 * not reused: reading it here would retarget a question typed for one
 * factor onto another, so it rests untouched under its original key. */
export function askKeys(
  target: AskTarget | undefined,
  factor?: PriorityFactor,
) {
  const targetKey = target?.candidateId ?? target?.findingId ?? factor ?? "";
  return {
    pageKey: targetKey ? "ask-input-" + targetKey : "ask-input",
    prefix: targetKey ? "ask-" + targetKey + "-" : "ask-",
  };
}

function askSend(
  form: ReturnType<typeof useRecordForm>,
  area: AskArea,
  target: AskTarget | undefined,
  factor?: PriorityFactor,
) {
  return async function send() {
    const values = factor ? { ...form.work.values, factor } : form.work.values;
    const inputRequestId = values.inputRequestId || crypto.randomUUID();
    form.work.change("inputRequestId", inputRequestId);
    await form.action(
      ASK_INPUT_ACTION,
      askPayload(values, area, target, inputRequestId),
      "Question submitted. Review is still needed.",
      () => {
        for (const key of ["question", "scope", "inputRequestId"])
          form.work.change(key, "");
      },
    );
  };
}

function AskFields({
  form,
  prefix,
}: {
  form: ReturnType<typeof useRecordForm>;
  prefix: string;
}) {
  const values = form.work.values;
  return (
    <>
      <Field
        name={prefix + "question"}
        label="Question"
        multiline
        value={values.question}
        onChange={(value) => form.work.change("question", value)}
      />
      <Field
        name={prefix + "scope"}
        label="Scope or assumptions (optional)"
        required={false}
        value={values.scope}
        onChange={(value) => form.work.change("scope", value)}
      />
      <Field
        name={prefix + "expertise"}
        label="Expertise needed (required for internal questions without a named person)"
        required={!values.addressee}
        value={values.expertise}
        onChange={(value) => form.work.change("expertise", value)}
      />
      <AddresseePicker form={form} prefix={prefix} />
    </>
  );
}

/** Only real signed-in demo identities can answer a question; seeded
 * personas exist for history and attribution, never as recipients. */
function AddresseePicker({
  form,
  prefix,
}: {
  form: ReturnType<typeof useRecordForm>;
  prefix: string;
}) {
  const { metadata } = useApp();
  return (
    <>
      <Label htmlFor={prefix + "addressee"}>Person to ask (optional)</Label>
      <Select
        id={prefix + "addressee"}
        name={prefix + "addressee"}
        value={form.work.values.addressee}
        onChange={(event) => form.work.change("addressee", event.target.value)}
      >
        <option value="">Have an administrator choose</option>
        {metadata.actors
          .filter((actor) => actor.kind === "visitor")
          .map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.id === metadata.visitor.actorId
                ? actor.displayName + " (you)"
                : actor.displayName}
            </option>
          ))}
      </Select>
    </>
  );
}

/** The requester answers a requester-audience question through the direct
 * endpoint; the internal action route is contributor-only. */
export function RequesterInputAnswers({ data, changed }: RecordProps) {
  const rows = (inputRequestsOf(data) ?? []).filter(
    (row) => row.audience === "requester",
  );
  if (rows.length === 0) return null;
  return (
    <section>
      <h2>Questions for you</h2>
      {rows.map((row) => (
        <RequesterInputRow
          key={row.id}
          data={data}
          changed={changed}
          row={row}
        />
      ))}
    </section>
  );
}

function RequesterInputRow({
  data,
  changed,
  row,
}: RecordProps & { row: ReviewInputRow }) {
  return (
    <div className={styles.estimateRow}>
      {row.factor && factorLabels[row.factor] + ": "}
      {row.question}
      {row.scope && <span className={styles.by}> · scope: {row.scope}</span>}
      {row.latestResponse && <LatestAnswer row={row} />}
      {!data.delivery.resolution && row.state !== "resolved" && row.current && (
        <RequesterAnswerForm data={data} changed={changed} row={row} />
      )}
    </div>
  );
}

function RequesterAnswerForm({
  data,
  changed,
  row,
}: RecordProps & { row: ReviewInputRow }) {
  const form = useRecordForm({
    data,
    changed,
    own: true,
    pageKey: "requester-answer-" + row.id,
    initial: answerInitial(row),
  });
  const unknown = form.work.values.outcome === "unknown";
  async function send() {
    const responseId = answerAttemptId(row, form.work.values);
    form.work.change("responseId", responseId);
    await form.send(
      "/api/review-inputs/answer",
      { ...form.base, responseId, ...answerPayload(row, form.work.values) },
      "Answer recorded for review.",
    );
  }
  return (
    <SavedWorkFieldset ready={form.work.ready}>
      <Label htmlFor={"requester-outcome-" + row.id}>
        Can you supply the information?
      </Label>
      <Select
        id={"requester-outcome-" + row.id}
        name={"requester-outcome-" + row.id}
        value={form.work.values.outcome}
        onChange={(event) => form.work.change("outcome", event.target.value)}
      >
        <option value="provided">I can supply information</option>
        <option value="unknown">I cannot supply the information</option>
      </Select>
      <Field
        name={"requester-answer-" + row.id}
        label={
          unknown
            ? "What would help get the missing information?"
            : "Your answer"
        }
        multiline
        value={form.work.values.answer}
        onChange={(value) => form.work.change("answer", value)}
      />
      {row.area === "rice" && row.factor && !unknown && (
        <AnswerEstimateFields row={row} factor={row.factor} form={form} />
      )}
      <FormMessages form={form} />
      <Button
        type="button"
        disabled={answerSendDisabled(form, row)}
        onClick={() => void send()}
      >
        {row.latestResponse ? "Update answer" : "Submit answer"}
      </Button>
    </SavedWorkFieldset>
  );
}
