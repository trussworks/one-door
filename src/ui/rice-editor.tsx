"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Label, Select } from "@trussworks/react-uswds";
import { api, ApiError, errorText } from "./api";
import { Field, Problem } from "./fields";
import { SaveStatus } from "./saved-work-presentation";
import { useSavedWork } from "./use-saved-work";
import styles from "./rice-editor.module.css";
import type { RequestView } from "../server/request-views";
import { firstReviewOpen } from "./record-form";
import { useApp } from "./shell";

interface Person {
  id: string;
  displayName: string;
  kind?: string;
}
interface RiceValues {
  reach: string;
  reachUnit: string;
  reachPeriod: string;
  impact: string;
  confidence: string;
  effort: string;
  reachRationale: string;
  impactRationale: string;
  confidenceRationale: string;
  effortRationale: string;
  effortActorId: string;
}
export interface RiceRequest {
  requestId: string;
  rowVersion: number;
  title: string;
  displayId: string;
  rice?: RiceValues | null;
}
interface Props {
  request: RiceRequest;
  visitor: { visitorId: string; actorId: string };
  actors: Person[];
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
  refreshRequest: () => void;
}

function initialValues(request: RiceRequest) {
  const rice = request.rice ?? {
    reach: "",
    reachUnit: "",
    reachPeriod: "",
    impact: "",
    confidence: "",
    effort: "",
    reachRationale: "",
    impactRationale: "",
    confidenceRationale: "",
    effortRationale: "",
    effortActorId: "",
  };
  return {
    reach: rice.reach === "" ? "" : String(Number(rice.reach)),
    reachUnit: rice.reachUnit,
    reachPeriod: rice.reachPeriod,
    impact: rice.impact,
    confidence: request.rice
      ? String(Number(request.rice.confidence) * 100)
      : "",
    effort: rice.effort,
    reachRationale: rice.reachRationale,
    impactRationale: rice.impactRationale,
    confidenceRationale: rice.confidenceRationale,
    effortRationale: rice.effortRationale,
    effortActorId: rice.effortActorId,
    _recordVersion: String(request.rowVersion),
  };
}

const guidance = {
  reach: [
    "Who or what will benefit?",
    "Choose what to count: people, applications, sites, or another unit that fits the work. Estimate how many will benefit during the period you name. Use the same unit and period for requests you compare.",
  ],
  impact: [
    "How much will the work improve?",
    "Consider the difference for each person, case, or other unit you counted—not the total reach. Think about time saved, mistakes avoided, or work that becomes possible.",
  ],
  confidence: [
    "How certain are your estimates?",
    "Rate the evidence behind the expected reach and improvement. As a guide: 80% for strong evidence, 50% for partial evidence, or 20% for an early assumption. This is not a vote for the idea.",
  ],
  effort: [
    "How much work will delivery take?",
    "Add up everyone’s working days, including building, testing, and getting ready to use the result. Two people working for five days each means 10 days of work. Do not count time waiting in a queue.",
  ],
};

function Factor({
  name,
  children,
}: {
  name: keyof typeof guidance;
  children: React.ReactNode;
}) {
  return (
    <fieldset
      className={`${styles.riceFactor} usa-fieldset`}
      data-factor={name}
      aria-describedby={name + "-guidance"}
    >
      <legend className="usa-legend" tabIndex={-1}>
        {guidance[name][0]}
      </legend>
      <p id={name + "-guidance"}>{guidance[name][1]}</p>
      <div className={styles.riceValue}>{children}</div>
    </fieldset>
  );
}

export function effortInDays(months: string) {
  return months === "" ? "" : String(Number((Number(months) * 20).toFixed(2)));
}

export function effortInMonths(days: string) {
  return days === "" ? "" : String(Number((Number(days) / 20).toFixed(2)));
}

function calculation(values: Record<string, string>) {
  if (
    ["reach", "impact", "confidence", "effort"].some(
      (key) => values[key] === "",
    )
  )
    return "Not scored";
  const score =
    (Number(values.reach) * Number(values.impact) * Number(values.confidence)) /
    100 /
    Number(values.effort);
  return Number.isFinite(score) && Number(values.effort) > 0
    ? score.toFixed(2)
    : "Not scored";
}

function riceCommand(props: Props, values: Record<string, string>) {
  return {
    action: "saveRiceScore",
    input: {
      requestId: props.request.requestId,
      expectedRowVersion: Number(values._recordVersion),
      reach: Number(values.reach),
      reachUnit: values.reachUnit,
      reachPeriod: values.reachPeriod,
      impact: Number(values.impact),
      confidence: Number(values.confidence) / 100,
      effort: Number(values.effort),
      reachRationale: values.reachRationale,
      impactRationale: values.impactRationale,
      confidenceRationale: values.confidenceRationale,
      effortRationale: values.effortRationale,
      reachActorId: props.visitor.actorId,
      impactActorId: props.visitor.actorId,
      confidenceActorId: props.visitor.actorId,
      effortActorId: values.effortActorId,
    },
  };
}

function useRiceDialog(error: string) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (error) dialog.current?.scrollTo({ top: 0 });
  }, [error]);
  return dialog;
}

function useRiceEditor(props: Props) {
  const [error, setError] = useState("");
  const dialog = useRiceDialog(error);
  const work = useSavedWork(
    {
      visitorId: props.visitor.visitorId,
      actingView: "contributor",
      pageKey: "rice",
      subjectKey: props.request.requestId,
    },
    initialValues(props.request),
  );
  const [saving, setSaving] = useState(false);
  const step = Math.min(
    3,
    Math.max(0, Math.trunc(Number(work.values._step)) || 0),
  );
  useEffect(() => {
    dialog.current?.scrollTo({ top: 0 });
    dialog.current?.querySelector<HTMLLegendElement>("legend")?.focus();
  }, [step, dialog]);
  const stale = Number(work.values._recordVersion) < props.request.rowVersion;
  const close = async () => {
    try {
      await work.flush();
      props.onClose();
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (step < 3) {
        work.change("_step", String(step + 1));
        await work.flush();
        return;
      }
      await work.flush();
      const result = await api<{ rowVersion: number }>(
        "/api/review/actions",
        riceCommand(props, work.values),
      );
      work.change("_recordVersion", String(result.rowVersion));
      void work.flush().catch(() => {});
      await props.onSaved("RICE score saved. The queue uses the new score.");
    } catch (caught) {
      setError(errorText(caught));
      if (caught instanceof ApiError && caught.code === "VERSION_CONFLICT")
        props.refreshRequest();
    } finally {
      setSaving(false);
    }
  }
  return { dialog, work, error, saving, stale, step, close, submit, setError };
}

export function RiceEditor(props: Props) {
  const { dialog, work, error, saving, stale, step, close, submit, setError } =
    useRiceEditor(props);
  return (
    <dialog
      ref={dialog}
      className={styles.ricePanel}
      aria-labelledby="rice-heading"
      onCancel={(event) => {
        event.preventDefault();
        void close();
      }}
    >
      <RiceHeading request={props.request} values={work.values} close={close} />
      <RiceWarnings
        error={error}
        stale={stale}
        work={work}
        rowVersion={props.request.rowVersion}
      />
      <form onSubmit={(event) => void submit(event)}>
        <p className={styles.riceStep} role="status">
          Step {step + 1} of 4
        </p>
        <fieldset className="usa-fieldset" disabled={!work.ready || saving}>
          <RiceFields work={work} actors={props.actors} step={step} />
        </fieldset>
        <RiceFooter
          work={work}
          saving={saving}
          stale={stale}
          close={close}
          setError={setError}
          step={step}
        />
      </form>
    </dialog>
  );
}

export function RiceFields({
  work,
  actors,
  step,
}: {
  work: ReturnType<typeof useSavedWork>;
  actors: Person[];
  step: number;
}) {
  const field = (name: string, label: string, extra = {}) => (
    <Field
      name={name}
      label={label}
      value={work.values[name] ?? ""}
      onChange={(value) => work.change(name, value)}
      {...extra}
    />
  );
  return (
    <>
      {step === 0 && <ReachFields field={field} work={work} />}
      {step === 1 && <ImpactField work={work} />}
      {step === 2 && (
        <Factor name="confidence">
          {field("confidence", "How certain, from 1 to 100%?", {
            type: "number",
            min: 1,
            max: 100,
            step: "1",
          })}
          {field(
            "confidenceRationale",
            "What has been checked, and what is still an assumption?",
            {
              multiline: true,
            },
          )}
        </Factor>
      )}
      {step === 3 && (
        <Factor name="effort">
          <Field
            name="effort"
            label="Total working days"
            type="number"
            min={0.2}
            step="0.2"
            value={effortInDays(work.values.effort ?? "")}
            onChange={(value) => work.change("effort", effortInMonths(value))}
          />
          <EffortOwner work={work} actors={actors} />
          {field("effortRationale", "What work does the estimate include?", {
            multiline: true,
            hint: "Include preparation, delivery, testing, and any dependencies",
          })}
        </Factor>
      )}
    </>
  );
}

function ReachFields({
  field,
  work,
}: {
  field: (name: string, label: string, extra?: object) => React.ReactNode;
  work: ReturnType<typeof useSavedWork>;
}) {
  return (
    <Factor name="reach">
      {field("reach", "How many?", {
        inputMode: "numeric",
        pattern: "[0-9]+",
        hint: "Enter a whole number",
        onChange: (value: string) => {
          if (/^\d*$/.test(value)) work.change("reach", value);
        },
      })}
      {field("reachUnit", "What are you counting?", {
        hint: "Name the unit, such as budget analysts, applications, or sites",
      })}
      {field("reachPeriod", "Time period", {
        hint: "For example, the next quarter",
      })}
      {field("reachRationale", "Where does that count come from?", {
        multiline: true,
        hint: "Name the source, or explain your estimate",
      })}
    </Factor>
  );
}

function RiceHeading({
  request,
  values,
  close,
}: {
  request: RiceRequest;
  values: Record<string, string>;
  close: () => Promise<void>;
}) {
  return (
    <>
      <div className={styles.riceHeading}>
        <div>
          <h2 id="rice-heading">Estimate this request’s priority</h2>
          <p>
            {request.displayId} · {request.title}
          </p>
        </div>
        <div>
          <div className={styles.ricePreview}>
            Score preview
            <output aria-live="polite">{calculation(values)}</output>
          </div>
          <Button type="button" outline onClick={() => void close()}>
            Save draft and close
          </Button>
        </div>
      </div>
      <p>
        Answer four questions to help compare this request with other work. Use
        your team’s evidence and estimates; One Door calculates the score.
      </p>
    </>
  );
}

function RiceWarnings({
  error,
  stale,
  work,
  rowVersion,
}: {
  error: string;
  stale: boolean;
  work: ReturnType<typeof useSavedWork>;
  rowVersion: number;
}) {
  return (
    <>
      {error && <Problem>{error}</Problem>}
      {stale && (
        <Problem>
          A newer request revision is available. Review its changes before
          reusing these estimates.
          <Button
            type="button"
            unstyled
            onClick={() => work.change("_recordVersion", String(rowVersion))}
          >
            I reviewed the current revision; keep my estimates
          </Button>
        </Problem>
      )}
    </>
  );
}

function ImpactField({ work }: { work: ReturnType<typeof useSavedWork> }) {
  const value = work.values.impact ? String(Number(work.values.impact)) : "";
  const levels = [
    ["0.25", "Minimal — a small convenience"],
    ["0.5", "Low — a modest improvement"],
    ["1", "Medium — noticeably easier work"],
    ["2", "High — removes a major obstacle"],
    ["3", "Very high — makes essential work possible"],
  ];
  return (
    <Factor name="impact">
      <div className="field">
        <Label htmlFor="impact">Expected improvement</Label>
        <Select
          id="impact"
          name="impact"
          required
          value={value}
          onChange={(event) => work.change("impact", event.target.value)}
        >
          <option value="">Choose an impact level</option>
          {value && !levels.some(([level]) => level === value) && (
            <option value={value}>Saved estimate: {value}</option>
          )}
          {levels.map(([value, label]) => (
            <option key={value} value={value}>
              {label} ({value})
            </option>
          ))}
        </Select>
      </div>
      <Field
        name="impactRationale"
        label="What improvement do you expect?"
        multiline
        hint="Describe the expected difference and what supports that estimate"
        value={work.values.impactRationale ?? ""}
        onChange={(value) => work.change("impactRationale", value)}
      />
    </Factor>
  );
}

function RiceActions({
  work,
  saving,
  stale,
  close,
  step,
}: {
  work: ReturnType<typeof useSavedWork>;
  saving: boolean;
  stale: boolean;
  close: () => Promise<void>;
  step: number;
}) {
  const action = step < 3 ? "Continue" : "Save score";
  return (
    <div className="actions">
      {step > 0 && (
        <Button
          type="button"
          outline
          disabled={saving}
          onClick={() => work.change("_step", String(step - 1))}
        >
          Back
        </Button>
      )}
      <Button type="submit" disabled={!work.ready || saving || stale}>
        {saving ? "Saving…" : action}
      </Button>
      <Button type="button" outline onClick={() => void close()}>
        Save draft and close
      </Button>
    </div>
  );
}

function RiceFooter({
  work,
  saving,
  stale,
  close,
  setError,
  step,
}: {
  work: ReturnType<typeof useSavedWork>;
  saving: boolean;
  stale: boolean;
  close: () => Promise<void>;
  setError: (message: string) => void;
  step: number;
}) {
  return (
    <>
      {step === 3 && (
        <p className={styles.riceCalculation}>
          RICE combines Reach (the count), Impact (the improvement), Confidence,
          and Effort. For the calculation, 20 working days equals one month of
          work. Higher scores indicate more expected benefit for the effort;
          compare requests using the same counting method and time period.
        </p>
      )}
      <RiceActions
        work={work}
        saving={saving}
        stale={stale}
        close={close}
        step={step}
      />
      <SaveStatus
        status={work.status}
        replace={() =>
          void work
            .overwriteWithLatestBase()
            .catch((caught) => setError(errorText(caught)))
        }
        retry={() =>
          void work.flush().catch((caught) => setError(errorText(caught)))
        }
      />
    </>
  );
}

function EffortOwner({
  work,
  actors,
}: {
  work: ReturnType<typeof useSavedWork>;
  actors: Person[];
}) {
  return (
    <div className="field">
      <Label htmlFor="effortActorId">Who checked the work estimate?</Label>
      <Select
        id="effortActorId"
        name="effortActorId"
        required
        value={work.values.effortActorId}
        onChange={(event) => work.change("effortActorId", event.target.value)}
      >
        <option value="">Choose the responsible person</option>
        {actors
          .filter((actor) => actor.kind !== "system")
          .map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.displayName}
            </option>
          ))}
      </Select>
    </div>
  );
}

export function RicePanel({
  data,
  refresh,
  close,
  saved,
  completedMessage,
}: {
  data: RequestView;
  refresh: () => Promise<void>;
  close: () => void;
  saved: (message: string) => void | Promise<void>;
  completedMessage: string;
}) {
  const { metadata } = useApp();
  const scored = data.scores.some(
    (score) => score.id === data.record.currentRiceScoreId,
  );
  /* A completed review with a recorded score is settled history. Without a
   * score, the priority work is still open — completion never closes it. */
  if (!firstReviewOpen(data) && scored)
    return (
      <aside>
        <p>{completedMessage}</p>
        <Button type="button" onClick={close}>
          Close priority panel
        </Button>
      </aside>
    );
  return (
    <RiceEditor
      request={{
        ...data.record,
        rice: data.scores.find(
          (score) => score.id === data.record.currentRiceScoreId,
        ),
      }}
      visitor={metadata.visitor}
      actors={metadata.actors}
      onClose={close}
      onSaved={saved}
      refreshRequest={refresh}
    />
  );
}
