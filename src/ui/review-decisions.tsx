"use client";

import styles from "./review-decisions.module.css";

import { Alert, Button, Label, Select } from "@trussworks/react-uswds";
import { useState } from "react";
import Link from "next/link";
import type { RequestView } from "../server/request-views";
import type { RecordProps } from "./record-form";
import { Field, Problem, DesignNote, PreparationStatus } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { useApp } from "./shell";
import { firstReviewOpen, useRecordForm } from "./record-form";
import { errorText, prepareModel } from "./api";
import { riskDecisionLabels, jobPending } from "./status-labels";

export function assetOutcomeReady(
  candidates: Array<{ decision: string | null }>,
) {
  return (
    candidates.some((candidate) => candidate.decision === "accepted") ||
    candidates.every((candidate) => candidate.decision === "rejected")
  );
}

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

export function ReviewAssets({ data, changed }: RecordProps) {
  const form = useRecordForm({
    data,
    changed,
    pageKey: "asset-outcome",
    initial: {},
  });
  const current = data.assetAssessment?.status === "succeeded";
  const accepted = data.candidates.some(
    (candidate) => candidate.decision === "accepted",
  );
  const settled = assetOutcomeReady(data.candidates);
  return (
    <section id="assets">
      <h2>Existing solutions</h2>
      <p>
        Can an existing solution meet this request? Check what each option does,
        which requirements it covers, and what is missing. Save your decisions,
        then complete this section.
      </p>
      <RequesterConcerns data={data} />
      {firstReviewOpen(data) && (
        <Preparation
          data={data}
          changed={changed}
          purpose="asset_match"
          available={current}
        />
      )}
      {current && (
        <>
          {data.candidates.length === 0 && (
            <p>No suitable existing solution was found.</p>
          )}
          {data.candidates.map((candidate) => (
            <AssetDecision
              key={candidate.id}
              data={data}
              changed={changed}
              candidate={candidate}
            />
          ))}
          {firstReviewOpen(data) && (
            <>
              <FormMessages form={form} />
              <Button
                type="button"
                disabled={
                  !form.work.ready || form.pending || form.stale || !settled
                }
                onClick={() =>
                  void form.action(
                    "recordAssetOutcome",
                    {
                      outcome: accepted ? "accepted" : "no_match",
                    },
                    accepted
                      ? "Existing-solution review completed with the accepted matches."
                      : "Existing-solution review completed. No existing solution fits.",
                  )
                }
              >
                {accepted
                  ? "Complete existing-solution review"
                  : "Record that no existing solution fits"}
              </Button>
            </>
          )}
        </>
      )}
      <DesignNote title="Software matching · Governed inventory and discovery">
        The inventory must be reviewed and approved before matching can be
        useful. A proposal is not a purchase approval or proof of availability.
      </DesignNote>
    </section>
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

function AssetDecision({
  data,
  changed,
  candidate,
}: RecordProps & { candidate: RequestView["candidates"][number] }) {
  const form = useRecordForm({
    data,
    changed,
    pageKey: "asset-" + candidate.id,
    initial: {
      reason: candidate.reason ?? "",
      decision: candidate.decision ?? "",
    },
  });
  return (
    <article className={styles.decisionCard}>
      <h3>{candidate.name}</h3>
      <div className={styles.evidence}>
        <AssetSummary candidate={candidate} />
      </div>
      {firstReviewOpen(data) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.action(
              "saveAssetDecision",
              {
                candidateId: candidate.id,
                decision: form.work.values.decision,
                ...(form.work.values.reason && {
                  reason: form.work.values.reason,
                }),
              },
              "Match decision saved for " + candidate.name + ".",
            );
          }}
        >
          <fieldset
            className="usa-fieldset"
            disabled={!form.work.ready || form.pending}
          >
            <Label htmlFor={"decision-" + candidate.id}>Your decision</Label>
            <Select
              id={"decision-" + candidate.id}
              name="decision"
              required
              value={form.work.values.decision}
              onChange={(event) =>
                form.work.change("decision", event.target.value)
              }
            >
              <option value="">Choose a decision</option>
              <option value="accepted">Fits this need</option>
              <option value="rejected">Does not fit this need</option>
            </Select>
            <Field
              name={"reason-" + candidate.id}
              label="Reason"
              multiline
              required={form.work.values.decision === "rejected"}
              value={form.work.values.reason}
              onChange={(value) => form.work.change("reason", value)}
            />
            <FormMessages form={form} />
            <Button type="submit" disabled={form.stale}>
              Save match decision
            </Button>
          </fieldset>
        </form>
      )}
    </article>
  );
}

export function ReviewRisk({ data, changed }: RecordProps) {
  const form = useRecordForm({
    data,
    changed,
    pageKey: "risk-outcome",
    initial: {},
  });
  return (
    <section id="risk">
      <h2>Initial risk assessment</h2>
      <p>
        Check the cited rules and evidence. Missing information is a question to
        resolve, not evidence that the request is safe.
      </p>
      {firstReviewOpen(data) && (
        <Preparation
          data={data}
          changed={changed}
          purpose="risk_assess"
          available={data.riskAssessment?.status === "succeeded"}
        />
      )}
      {data.riskAssessment?.status === "succeeded" && (
        <>
          {data.findings.length === 0 && (
            <div>
              <p>
                The assessment reported no rule-supported findings. This is not
                a security authorization.
              </p>
              {firstReviewOpen(data) && (
                <>
                  <FormMessages form={form} />
                  <Button
                    type="button"
                    disabled={!form.work.ready || form.pending || form.stale}
                    onClick={() =>
                      void form.action(
                        "recordRiskOutcome",
                        {},
                        "The initial risk review is recorded.",
                      )
                    }
                  >
                    Record my review of the empty assessment
                  </Button>
                </>
              )}
            </div>
          )}
          {data.findings.map((finding) => (
            <RiskDecision
              key={finding.id}
              data={data}
              changed={changed}
              finding={finding}
            />
          ))}
        </>
      )}
    </section>
  );
}

function RiskDecision({
  data,
  changed,
  finding,
}: RecordProps & { finding: RequestView["findings"][number] }) {
  const form = useRecordForm({
    data,
    changed,
    pageKey: "risk-" + finding.id,
    initial: {
      decision: finding.decision ?? "",
      severity: finding.finalSeverity ?? finding.severity ?? "",
      rationale: finding.decisionRationale ?? "",
    },
  });
  return (
    <article className={styles.decisionCard}>
      <h3>
        {finding.ruleCode} · {finding.domain}
      </h3>
      <div className={styles.evidence}>
        <RiskSummary finding={finding} />
      </div>
      {firstReviewOpen(data) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.action(
              "saveRiskDecision",
              {
                findingId: finding.id,
                decision: form.work.values.decision,
                ...(form.work.values.decision === "overridden" && {
                  finalSeverity: form.work.values.severity,
                }),
                ...(form.work.values.rationale && {
                  rationale: form.work.values.rationale,
                }),
              },
              "Risk decision saved for " + finding.ruleCode + ".",
            );
          }}
        >
          <fieldset
            className="usa-fieldset"
            disabled={!form.work.ready || form.pending}
          >
            <RiskFields form={form} finding={finding} />
            <FormMessages form={form} />
            <Button type="submit" disabled={form.stale}>
              Save risk decision
            </Button>
          </fieldset>
        </form>
      )}
    </article>
  );
}

function RiskFields({
  form,
  finding,
}: {
  form: ReturnType<typeof useRecordForm>;
  finding: RequestView["findings"][number];
}) {
  return (
    <>
      <Label htmlFor={"risk-decision-" + finding.id}>Your decision</Label>
      <Select
        id={"risk-decision-" + finding.id}
        name="risk-decision"
        required
        value={form.work.values.decision}
        onChange={(event) => form.work.change("decision", event.target.value)}
      >
        <option value="">Choose a decision</option>
        {finding.kind !== "missing_information" && (
          <option value="confirmed">Confirm the finding</option>
        )}
        <option value="overridden">Record a different assessment</option>
        <option value="cleared">This finding does not apply</option>
        <option value="follow_up_required">More information is needed</option>
      </Select>
      {form.work.values.decision === "overridden" && (
        <>
          <Label htmlFor={"severity-" + finding.id}>Final severity</Label>
          <Select
            id={"severity-" + finding.id}
            name="severity"
            required
            value={form.work.values.severity}
            onChange={(event) =>
              form.work.change("severity", event.target.value)
            }
          >
            <option value="">Choose severity</option>
            {["low", "moderate", "high", "critical"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </>
      )}
      <Field
        name={"rationale-" + finding.id}
        label="Reason and supporting evidence"
        multiline
        required={form.work.values.decision !== "confirmed"}
        value={form.work.values.rationale}
        onChange={(value) => form.work.change("rationale", value)}
      />
    </>
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

function AssetSummary({
  candidate,
}: {
  candidate: RequestView["candidates"][number];
}) {
  return (
    <>
      <h4>What this solution does</h4>
      <p>
        {candidate.description ||
          "The description used for this assessment was not retained. Check the catalog entry before relying on this match."}
      </p>
      {!candidate.catalogTextCurrent && (
        <p className="muted">
          This assessment used catalog version {candidate.catalogVersion}; the
          current version is {candidate.currentVersion}.{" "}
          <Link href={"/catalog/" + candidate.catalogItemId}>
            Check the catalog entry
          </Link>{" "}
          before completing review.
        </p>
      )}
      <h4>Why it was suggested for this request</h4>
      <p>{candidate.rationale}</p>
      <EvidenceList
        label="Requirements it could meet"
        values={candidate.coverage}
        empty="No coverage stated"
      />
      <EvidenceList
        label="What is still missing"
        values={candidate.gaps}
        empty="No gaps identified in this assessment"
      />
      <EvidenceList
        label="What it depends on"
        values={candidate.dependencies}
      />
      {candidate.decision && (
        <p>
          <strong>
            Recorded decision:{" "}
            {candidate.decision === "accepted"
              ? "Fits this need"
              : "Does not fit this need"}
          </strong>
          {candidate.reason && " — " + candidate.reason}
        </p>
      )}
    </>
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

function RiskSummary({
  finding,
}: {
  finding: RequestView["findings"][number];
}) {
  return (
    <>
      <p>
        <strong>
          {finding.severity
            ? "Proposed severity: " + finding.severity
            : "Information is needed before this risk can be assessed"}
        </strong>
      </p>
      <p>
        <strong>
          {finding.kind === "missing_information"
            ? "What is missing:"
            : "Request evidence:"}
        </strong>{" "}
        {finding.evidence ?? finding.missingInformation}
      </p>
      <p>{finding.rationale}</p>
      <h4>Rule to check</h4>
      <p>{finding.rule}</p>
      <p>
        <strong>Source:</strong> {finding.citation}
      </p>
      {finding.decision && (
        <p>
          <strong>Recorded decision:</strong>{" "}
          {riskDecisionLabels[finding.decision]}
          {finding.finalSeverity && " · " + finding.finalSeverity}
        </p>
      )}
    </>
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
