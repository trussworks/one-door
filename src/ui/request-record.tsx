"use client";

import styles from "./request-record.module.css";

import { useEffect, useRef, useState } from "react";

import { useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Button } from "@trussworks/react-uswds";
import type { RequestView } from "../server/request-views";
import { useData } from "./use-data";
import { useApp } from "./shell";
import { errorText } from "./api";
import { Field, Problem } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { RequestSummary } from "./request-summary";
import { AdministratorNotes } from "./administrator-notes";
import {
  useRecordForm,
  RecordMutationContext,
  type RecordProps,
} from "./record-form";
import { EvidenceList } from "./review-decisions";
import { ReviewBrief } from "./review-brief";
import { RequesterInputAnswers } from "./priority-contributions";
import { DeliveryProgress } from "./review-delivery";
import { RecordHistory } from "./record-history";
import { selectedReviewSection, type ReviewSection } from "./review-navigation";
import { actionLabels, jobPending, requestPhaseLabel } from "./status-labels";

export function recordNavigation(
  own: boolean,
  back: string | null,
  from: string | null,
  requestId?: string,
) {
  if (own) return { href: "/my", label: "My requests" };
  const match = /^\/(reports|dashboard|admin\/requests)(?:[?#]|$)/.exec(
    back ?? "",
  );
  const labels: Record<string, string> = {
    reports: "Reports",
    dashboard: "Dashboard",
    "admin/requests": "All requests",
  };
  if (back && match) return { href: back, label: labels[match[1]] };
  return {
    href:
      "/review?" + (from ?? "") + (requestId ? "#request-" + requestId : ""),
    label: "Review queue",
  };
}

export function RequestRecord({
  requestId,
  own = false,
  administrative = false,
}: {
  requestId: string;
  own?: boolean;
  administrative?: boolean;
}) {
  const search = useSearchParams();
  const source = useData<RequestView>(
    "/api/request-view/" + requestId + (own ? "" : "?view=contributor"),
  );
  const preparing = hasPreparationInProgress(source.data);
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(source.refresh, 1500);
    return () => clearInterval(timer);
  }, [preparing, source.refresh]);
  const navigation = recordNavigation(
    own,
    search.get("back") ??
      (administrative
        ? "/admin/requests?" +
          (search.get("from") ?? "") +
          "#request-" +
          requestId
        : null),
    search.get("from"),
    requestId,
  );
  const returnPath = navigation.href;
  if (!source.data)
    return (
      <>
        <Link href={returnPath}>
          {own ? "My requests" : "Return to review queue"}
        </Link>
        {source.error ? (
          <Problem>{errorText(source.error)}</Problem>
        ) : (
          <p role="status">Loading request…</p>
        )}
      </>
    );
  return (
    <RecordContent
      data={source.data}
      source={source}
      own={own}
      administrative={administrative}
      returnPath={returnPath}
      returnLabel={navigation.label}
    />
  );
}

function hasPreparationInProgress(data: RequestView | undefined) {
  return Object.values(data?.currentJobs ?? {}).some(
    (job) => job?.current && jobPending(job.status),
  );
}

function RecordContent({
  data,
  source,
  own,
  administrative,
  returnPath,
  returnLabel,
}: {
  data: RequestView;
  source: ReturnType<typeof useData<RequestView>>;
  own: boolean;
  administrative: boolean;
  returnPath: string;
  returnLabel: string;
}) {
  const busyRef = useRef(false);
  const [busy, updateBusy] = useState(false);
  const [catalogue, setCatalogue] = useState(false);
  const setBusy = (value: boolean) => {
    busyRef.current = value;
    updateBusy(value);
  };
  const query = useSearchParams();
  const section = selectedReviewSection(query.get("section"));
  useEffect(() => setCatalogue(false), [section]);
  const searchingCatalog = !own && section === "assessment" && catalogue;
  return (
    <RecordMutationContext.Provider value={{ busy: busyRef, setBusy }}>
      {Boolean(source.error) && (
        <Problem>
          {errorText(source.error)}
          <Button type="button" onClick={source.refresh}>
            Refresh request
          </Button>
        </Problem>
      )}
      <fieldset
        className="usa-fieldset"
        disabled={busy || Boolean(source.error)}
      >
        <p className="breadcrumb">
          <Link href={returnPath}>{returnLabel}</Link> / {data.record.displayId}
        </p>
        {!searchingCatalog && (
          <>
            <RecordHeading
              data={data}
              own={own}
              assessment={!own && section === "assessment"}
            />
            {!own && <HistoryLink section={section} />}
          </>
        )}
        {own && <RequesterRecord data={data} changed={source.refresh} />}
        {!own && (
          <ReviewSectionFrame
            data={data}
            changed={source.refresh}
            section={section}
            administrative={administrative}
            catalogue={catalogue}
            onCatalogueChange={setCatalogue}
          />
        )}
      </fieldset>
    </RecordMutationContext.Provider>
  );
}

function ReviewSectionFrame(
  props: RecordProps & {
    section: ReviewSection;
    administrative: boolean;
    catalogue: boolean;
    onCatalogueChange: (open: boolean) => void;
  },
) {
  return (
    <div
      className={styles.section}
      id="review-section"
      role="region"
      aria-label="Request details"
    >
      <InternalReview {...props} />
    </div>
  );
}

/** The quiet History reference beside the record identity; it remembers
 * which working view opened it so the return goes back there. */
function HistoryLink({ section }: { section: ReviewSection }) {
  const path = usePathname();
  const query = useSearchParams();
  if (section === "history") return null;
  const next = new URLSearchParams(query.toString());
  next.set("section", "history");
  next.set("return", section);
  next.delete("panel");
  return (
    <p className="history-link">
      <Link href={path + "?" + next} scroll={false}>
        Request history
      </Link>
    </p>
  );
}

function SectionReturn({ to, label }: { to: ReviewSection; label: string }) {
  const path = usePathname();
  const query = useSearchParams();
  const next = new URLSearchParams(query.toString());
  next.set("section", to);
  next.delete("return");
  return (
    <p className="section-return">
      <Link href={path + "?" + next} scroll={false}>
        {label}
      </Link>
    </p>
  );
}

function HistoryReturn() {
  const query = useSearchParams();
  const target: ReviewSection =
    query.get("return") === "delivery" ? "delivery" : "assessment";
  return (
    <SectionReturn
      to={target}
      label={target === "delivery" ? "Return to delivery" : "Return to review"}
    />
  );
}

function RequesterRecord({ data, changed }: RecordProps) {
  return (
    <>
      <RelatedRequests data={data} own />
      {data.record.openClarificationId && (
        <AnswerQuestion data={data} changed={changed} />
      )}
      <RequesterInputAnswers data={data} changed={changed} />
      <RequestSummary content={data.record.content} heading="h2" />
      <MatchFeedback data={data} own />
      <details className={styles.originalWords}>
        <summary>Requester's original words</summary>
        <p>{data.rawNeed}</p>
      </details>
      <DeliveryProgress data={data} changed={changed} own />
      <RecordHistory data={data} own />
    </>
  );
}

function MatchFeedback({ data, own }: { data: RequestView; own: boolean }) {
  return own ? (
    <ConfirmedPreference data={data} />
  ) : (
    <>
      <ServiceEvaluation evaluation={data.serviceEvaluation} />
      {data.serviceChoices.length > 0 && <ServiceFeedback data={data} />}
      <RequesterFitFeedback data={data} />
    </>
  );
}

export function ServiceEvaluation({
  evaluation,
}: {
  evaluation: RequestView["serviceEvaluation"];
}) {
  if (!evaluation?.candidates.length) return null;
  const bands = {
    strong: "Strong suggestion",
    possible: "Moderate suggestion",
    weak: "Weak suggestion",
  };
  return (
    <section id="service-evaluation" className={styles.serviceEvaluation}>
      <h2>Service suggestions from intake</h2>
      <p>
        These suggestions do not settle delivery routing. Review them against
        the confirmed request.
      </p>
      {evaluation && !evaluation.matchesSubmission && (
        <p>
          These suggestions were prepared for an earlier version of the request.
        </p>
      )}
      {evaluation && !evaluation.corpusCurrent && (
        <p>
          The service catalog has changed. Check current availability before
          relying on these suggestions.
        </p>
      )}
      {evaluation?.candidates.length ? (
        evaluation.candidates.map((candidate) => (
          <article key={candidate.id}>
            <h3>{candidate.name}</h3>
            <p className="muted">
              {bands[candidate.fitBand]} · Service version {candidate.version}
            </p>
            <p>{candidate.rationale}</p>
            <EvidenceList
              label="Capabilities reported as covered"
              values={candidate.coverage}
            />
            <EvidenceList
              label="Requirements reported as unmet"
              values={candidate.gaps}
            />
          </article>
        ))
      ) : (
        <p>
          No service match is recorded. OIT still needs to decide how to direct
          the request.
        </p>
      )}
    </section>
  );
}

function ConfirmedPreference({ data }: { data: RequestView }) {
  const names = [
    ...new Set([
      ...data.serviceChoices
        .filter((choice) => choice.requesterDecision === "accepted")
        .map((choice) => choice.name),
      ...data.assetFitDecisions
        .filter((choice) => choice.decision === "accepted" && choice.current)
        .map((choice) => choice.name),
    ]),
  ];
  if (names.length !== 1) return null;
  return (
    <p>
      {"You marked " +
        names[0] +
        " as suitable; OIT checks whether it meets the request."}
    </p>
  );
}

function ServiceFeedback({ data }: { data: RequestView }) {
  return (
    <section>
      <h2>Requester feedback</h2>
      <p>Earlier feedback may refer to different requirements.</p>
      {data.serviceChoices.length ? (
        data.serviceChoices.map((choice, index) => (
          <div key={index}>
            <h3>
              {choice.name} · Version {choice.version}
            </h3>
            <p>
              {serviceFeedbackLabel(choice.requesterDecision, choice.selected)}
            </p>
            <p>{choice.reason ?? choice.rationale}</p>
            {choice.decidedAt && (
              <p className="muted">
                Recorded: {new Date(choice.decidedAt).toLocaleString()}
              </p>
            )}
          </div>
        ))
      ) : (
        <p>No requester feedback recorded.</p>
      )}
    </section>
  );
}

export function serviceFeedbackLabel(
  decision: string | null,
  selected: boolean,
) {
  if (decision === "accepted")
    return "The requester found this service suitable. OIT decides whether the request should go to this service.";
  if (decision === "rejected")
    return "The requester said this service does not meet the need.";
  return selected
    ? "This option was selected in an earlier intake; the selection does not confirm acceptance."
    : "Available for OIT to assess. The requester has not recorded a decision.";
}

function RelatedRequests({ data, own }: { data: RequestView; own: boolean }) {
  const path = usePathname();
  let prefix = path.startsWith("/admin/") ? "/admin/requests/" : "/review/";
  if (own) prefix = "/request/";
  return (
    <>
      {data.parentRequest && (
        <p>
          Follow-up to:{" "}
          <Link href={prefix + data.parentRequest.requestId}>
            {data.parentRequest.displayId}: {data.parentRequest.title}
          </Link>
          . The earlier request keeps its own decisions and outcome.
        </p>
      )}
      {data.followUps.length > 0 && (
        <section>
          <h2>Follow-up requests</h2>
          <ul>
            {data.followUps.map((request) => (
              <li key={request.requestId}>
                <Link href={prefix + request.requestId}>
                  {request.displayId}: {request.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {own &&
        (data.delivery.resolution ||
          data.record.stage === "first_review_completed") && (
          <p>
            <Link
              className="usa-button usa-button--outline"
              href={"/new?parent=" + data.record.requestId}
            >
              Start a follow-up request
            </Link>
          </p>
        )}
    </>
  );
}

const requesterFitLabels = {
  accepted: "Suitable",
  rejected: "Unsuitable",
  cleared: "Deferred to OIT",
};

function RequesterFitFeedback({ data }: { data: RequestView }) {
  const { metadata } = useApp();
  if (!data.assetFitDecisions.length) return null;
  return (
    <section id="requester-fit-feedback">
      <h2>Requester's decisions on existing options</h2>
      <p>Requester feedback does not replace OIT's review decisions.</p>
      {data.assetFitDecisions.map((decision) => (
        <details key={decision.id}>
          <summary>
            {decision.name} · Version {decision.catalogVersion} ·{" "}
            {requesterFitLabels[decision.decision]}
            {decision.current ? " · Current proposal" : " · Earlier proposal"}
          </summary>
          <p>{decision.reason ?? "No additional comment recorded."}</p>
          <p>Reasoning in the matching result: {decision.rationale}</p>
          <p>
            Requirements reported as unmet:{" "}
            {decision.gaps.join("; ") ||
              "Preparation reported no gaps; this is not confirmation that none exist."}
          </p>
          <p>
            {metadata.actors.find((actor) => actor.id === decision.actorId)
              ?.displayName ?? "Requester"}{" "}
            · {new Date(decision.decidedAt).toLocaleString()}
          </p>
        </details>
      ))}
    </section>
  );
}

export function recordNextAction(data: RequestView, own: boolean) {
  if (!own) return "Next: " + actionLabels[data.status?.actionNeeded ?? "none"];
  if (data.record.openClarificationId) return "Answer the open clarification.";
  return data.delivery.resolution
    ? "No further action is needed from you."
    : "OIT has the next task.";
}

function RecordHeading({
  data,
  own,
  assessment = false,
}: {
  data: RequestView;
  own: boolean;
  assessment?: boolean;
}) {
  const delivery = data.delivery.resolution?.summary ?? data.review.nextOwner;
  /* On the assessment the prepared assessment is the strong heading, as in
   * the approved page; the request title supports it as context. Delivery,
   * History, and the requester's view keep the title as the heading. */
  return (
    <>
      {assessment ? (
        <AssessmentHeading data={data} />
      ) : (
        <>
          <h1>{data.record.title}</h1>
          <RecordMeta data={data} />
        </>
      )}
      <div
        className={own ? styles.status : styles.status + " " + styles.compact}
      >
        <strong>{requestPhaseLabel(data)}</strong>
        {data.status && <p>{recordNextAction(data, own)}</p>}
        {own && delivery && <p>{delivery}</p>}
      </div>
    </>
  );
}

function AssessmentHeading({ data }: { data: RequestView }) {
  return (
    <>
      <p className="record-meta">
        {data.record.title} · <RecordMeta data={data} inline />
      </p>
      <h1>Review request</h1>
    </>
  );
}

function RecordMeta({
  data,
  inline = false,
}: {
  data: RequestView;
  inline?: boolean;
}) {
  const facts = (
    <>
      {data.record.displayId} · {data.organizationName} · Submitted by{" "}
      {data.requesterName}
      {data.fixtureKey && " · Fictional example"}
    </>
  );
  return inline ? facts : <p className="record-meta">{facts}</p>;
}

function AskQuestion({ data, changed }: RecordProps) {
  const form = useRecordForm({
    data,
    changed,
    pageKey: "ask-question",
    initial: { question: "" },
  });
  if (data.record.waitingOnRequester)
    return (
      <section>
        <h2>Waiting for the requester to clarify the request.</h2>
        <p>
          {
            data.record.clarifications.find(
              (entry) => entry.id === data.record.openClarificationId,
            )?.question
          }
        </p>
        <p>
          Waiting for the requester's clarification. Preparation and review can
          resume after the answer; both the question and answer stay in the
          history.
        </p>
      </section>
    );
  return (
    <AskReveal label="Ask the requester to clarify the request">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.send(
            "/api/clarifications",
            { ...form.base, question: form.work.values.question },
            "Clarification requested. The requester's answer may revise the request.",
          );
        }}
      >
        <fieldset
          className="usa-fieldset"
          disabled={!form.work.ready || form.pending}
        >
          <Field
            name="question"
            label="What should the requester clarify?"
            multiline
            value={form.work.values.question}
            onChange={(value) => form.work.change("question", value)}
          />
          <FormMessages form={form} />
          <Button
            type="submit"
            disabled={!form.work.ready || form.pending || form.stale}
          >
            Ask for clarification
          </Button>
        </fieldset>
      </form>
    </AskReveal>
  );
}

/** A deliberate ask action: a link-styled trigger revealing the form in
 * place. The form stays mounted while hidden, so a typed draft survives
 * closing and reopening the reveal. */
function AskReveal({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="record-action">
      <button
        type="button"
        className="linkish-action"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      <div hidden={!open}>{children}</div>
    </div>
  );
}

function AnswerQuestion({ data, changed }: RecordProps) {
  const question = data.record.clarifications.find(
    (entry) => entry.id === data.record.openClarificationId,
  );
  const form = useRecordForm({
    data,
    changed,
    own: true,
    pageKey: "answer-" + question?.id,
    initial: { answer: "" },
  });
  if (!question) return null;
  return (
    <section className={styles.answerNeeded}>
      <h2>Questions for you</h2>
      <p>{question.question}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.send(
            "/api/answers",
            {
              ...form.base,
              clarificationId: question.id,
              answer: form.work.values.answer,
            },
            "Clarification answer saved. OIT can resume reviewing the request.",
          );
        }}
      >
        <fieldset
          className="usa-fieldset"
          disabled={!form.work.ready || form.pending}
        >
          <Field
            name="answer"
            label="Your answer"
            multiline
            value={form.work.values.answer}
            onChange={(value) => form.work.change("answer", value)}
          />
          <FormMessages form={form} />
          <Button
            type="submit"
            disabled={!form.work.ready || form.pending || form.stale}
          >
            Submit answer
          </Button>
        </fieldset>
      </form>
    </section>
  );
}

function InternalReview({
  data,
  changed,
  section,
  administrative,
  catalogue,
  onCatalogueChange,
}: RecordProps & {
  section: ReviewSection;
  administrative: boolean;
  catalogue: boolean;
  onCatalogueChange: (open: boolean) => void;
}) {
  return (
    <>
      {section === "history" && (
        <>
          <HistoryReturn />
          <RecordHistory data={data} />
          <details className={styles.originalWords}>
            <summary>Requester's original words</summary>
            <p className="preserve-lines">{data.rawNeed}</p>
          </details>
          <ServiceFeedback data={data} />
          <RequesterFitFeedback data={data} />
          <AdministratorNotes
            notes={data.administratorNotes}
            requestId={data.record.requestId}
            rowVersion={data.record.rowVersion}
            administrative={administrative}
            changed={changed}
          />
        </>
      )}
      {section === "delivery" && (
        <>
          <SectionReturn to="assessment" label="Return to review" />
          <DeliveryProgress data={data} changed={changed} own={false} />
        </>
      )}
      {/* The assessment hides rather than unmounts while History or
       * Delivery shows, so claim and factor draft owners stay live and
       * unsaved local input survives the round trip. */}
      <div hidden={section !== "assessment"}>
        <ReviewBrief
          data={data}
          changed={changed}
          administrative={administrative}
          catalogue={catalogue}
          onCatalogueChange={onCatalogueChange}
          needSlot={
            data.record.stage !== "first_review_completed" &&
            !data.delivery.resolution ? (
              <AskQuestion data={data} changed={changed} />
            ) : null
          }
          fitSlot={<ServiceEvaluation evaluation={data.serviceEvaluation} />}
        />
      </div>
    </>
  );
}
