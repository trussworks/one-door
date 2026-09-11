"use client";

import styles from "./review-decisions.module.css";

import { Alert, Button, Label, Select } from "@trussworks/react-uswds";
import { useState } from "react";
import type { RequestView } from "../server/request-views";
import type { RecordProps } from "./record-form";
import { Problem, PreparationStatus } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { useApp } from "./shell";
import { useRecordForm } from "./record-form";
import { errorText, prepareModel } from "./api";
import { jobPending } from "./status-labels";

const preparationLabels = {
  asset_match: {
    waiting: "Preparation is queued or running. No result is ready yet.",
    action: "Update option matching",
    source: "inventory",
    stale: "ASSET_CORPUS_STALE",
  },
  risk_assess: {
    waiting: "Preparation is queued or running. No result is ready yet.",
    action: "Update policy assessment",
    source: "policy",
    stale: "RISK_CORPUS_STALE",
  },
} as const;

export function Preparation({
  data,
  purpose,
  changed,
  available = false,
}: RecordProps & {
  purpose: "asset_match" | "risk_assess";
  available?: boolean;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const labels = preparationLabels[purpose];
  const job = data.currentJobs[purpose];
  const running = Boolean(job?.current && jobPending(job.status));
  async function retry() {
    setPending(true);
    try {
      await prepareModel(job, {
        purpose,
        draftId: data.draftId,
        requestId: data.record.requestId,
      });
      changed();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }
  const stale = data.review.blockers.includes(labels.stale);
  const message = preparationMessage(job, available);
  if (!preparationNeeded(available, stale, job)) return null;
  return (
    <div className="preparation">
      {running ? (
        <PreparationStatus label={labels.waiting} />
      ) : (
        <PreparationNotice stale={stale} message={message} />
      )}
      {error && <Problem>{error}</Problem>}
      {!running && (
        <Button
          type="button"
          outline
          disabled={pending}
          onClick={() => void retry()}
        >
          {pending ? "Requesting preparation…" : labels.action}
        </Button>
      )}
    </div>
  );
}

function PreparationNotice({
  stale,
  message,
}: {
  stale: boolean;
  message: string;
}) {
  return stale ? (
    <Alert type="warning" slim>
      The request or source material has changed since preparation. Update the
      result before using it.
    </Alert>
  ) : (
    <p>{message}</p>
  );
}

export function preparationNeeded(
  available: boolean,
  stale: boolean,
  job: RequestView["currentJobs"]["asset_match"],
) {
  return (
    !available ||
    stale ||
    Boolean(job && (!job.current || job.status !== "succeeded"))
  );
}

export function RequesterConcerns({ data }: { data: RequestView }) {
  const concerns = [
    ...data.serviceChoices
      .filter((choice) => choice.requesterDecision === "rejected")
      .map((choice) => ({ name: choice.name, reason: choice.reason })),
    ...data.assetFitDecisions
      .filter((choice) => choice.decision === "rejected")
      .map((choice) => ({ name: choice.name, reason: choice.reason })),
  ].filter((choice) => choice.reason);
  if (!concerns.length) return null;
  return (
    <aside className={styles.requesterConcerns}>
      <h3>Why the requester rejected options</h3>
      {concerns.map((choice, index) => (
        <div key={index}>
          <strong>{choice.name}</strong>
          <p>{choice.reason}</p>
        </div>
      ))}
      <p className="muted">
        Check the requester’s intake concerns against the current requirements.
        Earlier decisions remain in the history.
      </p>
    </aside>
  );
}

export function ReviewAssignments({ data, changed }: RecordProps) {
  const { metadata } = useApp();
  const initial = Object.fromEntries(
    data.review.tasks.map((task) => [task.area, task.assigneeActorId ?? ""]),
  );
  const form = useRecordForm({
    data,
    changed,
    pageKey: "assign-review",
    initial: { ...initial, coordinator: data.review.coordinatingActorId ?? "" },
  });
  return (
    <section>
      <h2>Review responsibilities</h2>
      <p>
        Assign these optional responsibilities to people assessing the request.
        The delivery lead is responsible for the next delivery task after
        review.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.action(
            "assignReview",
            {
              coordinatorActorId: form.work.values.coordinator || null,
              assignments: ["assets", "risk", "rice"].map((area) => ({
                area,
                assigneeActorId: form.work.values[area] || null,
              })),
            },
            "Review responsibilities recorded.",
          );
        }}
      >
        <fieldset
          className={"usa-fieldset " + styles.assignments}
          disabled={!form.work.ready || form.pending}
        >
          {[
            ["coordinator", "Review coordinator"],
            ["assets", "Existing options reviewer"],
            ["risk", "Policy reviewer"],
            ["rice", "Priority reviewer"],
          ].map(([key, label]) => (
            <div key={key}>
              <Label htmlFor={"assign-" + key}>{label}</Label>
              <Select
                id={"assign-" + key}
                name={key}
                value={form.work.values[key] ?? ""}
                onChange={(event) => form.work.change(key, event.target.value)}
              >
                <option value="">Unassigned</option>
                {metadata.actors
                  .filter((actor) => actor.kind !== "system")
                  .map((actor) => (
                    <option key={actor.id} value={actor.id}>
                      {actor.id === metadata.visitor.actorId
                        ? actor.displayName + " (you)"
                        : actor.displayName}
                    </option>
                  ))}
              </Select>
            </div>
          ))}
          <FormMessages form={form} />
          <Button type="submit" disabled={form.stale}>
            Record responsibilities
          </Button>
        </fieldset>
      </form>
    </section>
  );
}

export function EvidenceList({
  label,
  values,
  empty,
  heading: Heading = "h4",
}: {
  label: string;
  values: string[];
  empty?: string;
  heading?: "h3" | "h4";
}) {
  if (!values.length && !empty) return null;
  return (
    <section className={styles.evidenceList}>
      <Heading>{label}</Heading>
      {values.length ? (
        <ul className="usa-list">
          {values.map((value, index) => (
            <li key={index}>{value}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

function preparationMessage(
  job: RequestView["currentJobs"]["asset_match"],
  available: boolean,
) {
  if (job?.current && job.status === "capped")
    return "A model usage limit has stopped preparation. View usage for details.";
  if (job?.current && job.status === "failed")
    return "Preparation failed. The request and existing evidence remain available.";
  let message = "No current preparation result is available.";
  if (available)
    message =
      "You can rerun preparation after source material changes. With unchanged inputs, One Door reuses the saved result.";
  if (job && !job.current)
    message =
      "The request or source material has changed since preparation. Update the result before using it.";
  return message;
}
