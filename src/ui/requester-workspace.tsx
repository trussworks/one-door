"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Label, Select } from "@trussworks/react-uswds";
import type { getIntakeWorkspace } from "../workflow/intake-workspace";
import type { IntakeResult } from "../models/contracts";
import { api, errorText } from "./api";
import { jobPending } from "./status-labels";
import { useData } from "./use-data";
import type { SavedWorkKind, SavedWorkStatus } from "./use-saved-work";
import { useSavedWork } from "./use-saved-work";
import { useApp } from "./shell";
import { Field, Problem, ModelWaiting, DesignNote } from "./fields";
import {
  FormMessages,
  SaveAndExit,
  SavedWorkFooter,
} from "./saved-work-presentation";
import { TaskRating, RatingErrorSummary } from "./rating-presentation";
import {
  PriorityInvitation,
  estimateDraftFields,
  estimateProposals,
  estimateIssues,
} from "./requester-estimates";
import { InlineChange, RequestSummary } from "./request-summary";
import { requesterContentLabels } from "./request-summary";
import styles from "./requester.module.css";

type Content = IntakeResult["content"];
type RawWorkspace = Awaited<ReturnType<typeof getIntakeWorkspace>>;
export type IntakeWorkspace = Omit<RawWorkspace, "content"> & {
  content: Content;
};

export function completeContent(input: unknown, rawNeed: string): Content {
  const values =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const text = (key: string, fallback: string) =>
    typeof values[key] === "string" && values[key].trim()
      ? values[key]
      : fallback;
  const lines = (key: string) =>
    Array.isArray(values[key])
      ? values[key].filter(
          (value): value is string => typeof value === "string",
        )
      : [];
  return {
    title: text("title", "New request"),
    problem: text("problem", rawNeed),
    affectedPeople: text("affectedPeople", ""),
    acceptanceCriteria: lines("acceptanceCriteria"),
    requirements: lines("requirements"),
    constraints: lines("constraints"),
    unknowns: lines("unknowns"),
  };
}

export function RequesterWorkspace({ draftId }: { draftId: string }) {
  const source = useData<RawWorkspace>("/api/intake-workspace/" + draftId);
  const wasRunning = useRef(false);
  const running = Boolean(
    source.data?.job && jobPending(source.data.job.status),
  );
  useEffect(() => {
    if (wasRunning.current && !running)
      (
        document.getElementById("intake-questions-heading") ??
        document.getElementById("working-request-heading")
      )?.focus();
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(source.refresh, 1500);
    return () => clearInterval(timer);
  }, [running, source.refresh]);
  if (!source.data)
    return (
      <>
        <h1>Describe what you need</h1>
        {source.error ? (
          <Problem>{errorText(source.error)}</Problem>
        ) : (
          <p role="status">Opening your saved request…</p>
        )}
      </>
    );
  if (source.data.submittedRequest)
    return (
      <>
        <h1>Your request has been sent</h1>
        <p>
          <Link href={"/request/" + source.data.submittedRequest.requestId}>
            Follow {source.data.submittedRequest.displayId}
          </Link>
        </p>
      </>
    );
  const data: IntakeWorkspace = {
    ...source.data,
    content: completeContent(source.data.content, source.data.draft.rawNeed),
  };
  return (
    <div className={styles.requesterWorkspace}>
      <p className="breadcrumb">
        <Link href="/my">My requests</Link> / New request
      </p>
      <h1>{workspaceHeading(data, running)}</h1>
      {Boolean(source.error) && <Problem>{errorText(source.error)}</Problem>}
      {running ? (
        <WaitingRequest data={data} />
      ) : (
        <WorkspaceForm
          key={data.job?.jobId ?? "manual"}
          data={data}
          refresh={source.refresh}
        />
      )}
    </div>
  );
}

export function workspaceHeading(data: IntakeWorkspace, running: boolean) {
  if (running)
    return data.contentComplete
      ? "Updating your request"
      : "Preparing your request";
  if (!data.contentComplete) return "Complete your request";
  return data.questions.some((question) => question.answer === null)
    ? "A few details will help"
    : "Review and send your request";
}

function WaitingRequest({ data }: { data: IntakeWorkspace }) {
  return (
    <>
      <ModelWaiting status={data.job?.status} refining={data.contentComplete} />
      <div className="actions">
        <Link className="usa-button usa-button--outline" href="/my">
          Save and exit
        </Link>
      </div>
    </>
  );
}

const textFields = new Set(["title", "problem", "affectedPeople"]);
const textLimits: Record<string, number> = {
  title: 200,
  problem: 5000,
  affectedPeople: 2000,
};

export function contentIssue(content: Content) {
  for (const [field, value] of Object.entries(content)) {
    const label = requesterContentLabels[field as keyof Content];
    if (typeof value === "string" && value.length > textLimits[field])
      return {
        field,
        message: label + ": use " + textLimits[field] + " characters or fewer.",
      };
    if (!Array.isArray(value)) continue;
    const maximum = field === "acceptanceCriteria" ? 20 : 30;
    if (value.length > maximum)
      return {
        field,
        message: label + ": use up to " + maximum + " items, one per line.",
      };
    if (value.some((item) => item.length > 500))
      return {
        field,
        message: label + ": keep each line to 500 characters or fewer.",
      };
  }
  return null;
}

export function contentValues(content: Content) {
  return Object.fromEntries(
    Object.entries(content).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join("\n") : value,
    ]),
  );
}

export function readContent(values: Record<string, string>): Content {
  const lines = (key: string) =>
    (values[key] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  return {
    title: (values.title ?? "").trim(),
    problem: (values.problem ?? "").trim(),
    affectedPeople: (values.affectedPeople ?? "").trim(),
    acceptanceCriteria: lines("acceptanceCriteria"),
    requirements: lines("requirements"),
    constraints: lines("constraints"),
    unknowns: lines("unknowns"),
  };
}

function answerValues(questions: IntakeWorkspace["questions"]) {
  return Object.fromEntries(
    questions.map((question) => [
      "answer-" + question.questionIndex,
      question.answer ?? "",
    ]),
  );
}

export function changedContent(previous: Content, current: Content) {
  return (Object.keys(requesterContentLabels) as Array<keyof Content>).filter(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(current[key]),
  );
}

function useWorkspaceForm(data: IntakeWorkspace, refresh: () => Promise<void>) {
  const { announce } = useApp();
  const router = useRouter();
  const { requestDraft, submissionDraft } = useWorkspaceDrafts(data);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [issue, setIssue] = useState<ReturnType<typeof contentIssue>>(null);
  const stale =
    Number(requestDraft.values._recordVersion) < data.draft.rowVersion;
  const state = workspaceState(data, requestDraft.values);
  async function flush() {
    await Promise.all([requestDraft.flush(), submissionDraft.flush()]);
  }
  /** One key per submission attempt, reused until a submission succeeds. */
  function keepIdempotencyKey() {
    const key = submissionDraft.values.idempotencyKey || crypto.randomUUID();
    submissionDraft.change("idempotencyKey", key);
    return key;
  }

  async function run(action: "prepare" | "submit") {
    const invalid = contentIssue(state.content);
    setIssue(invalid);
    if (invalid) {
      setError(invalid.message);
      return;
    }
    if (action === "submit") {
      const estimateProblems = estimateIssues(submissionDraft.values);
      if (estimateProblems.length > 0) {
        setError(estimateProblems[0]);
        return;
      }
    }
    setPending(true);
    setError("");
    try {
      const request = { data, requestDraft, submissionDraft, ...state };
      if (action === "prepare") {
        submissionDraft.change(
          "_previousContent",
          JSON.stringify(data.content),
        );
        keepIdempotencyKey();
        await flush();
        await sendPrepare(request);
        await refresh();
      } else {
        const idempotencyKey = keepIdempotencyKey();
        await flush();
        const sent = await sendSubmit({ ...request, idempotencyKey });
        announce(
          `Request ${sent.displayId} was sent to OIT. Open it below to follow progress.`,
        );
        router.push("/my");
      }
    } catch (caught) {
      setError(errorText(caught));
      await refresh();
    } finally {
      setPending(false);
    }
  }
  return {
    requestDraft,
    submissionDraft,
    manual: !data.contentComplete,
    issue,
    error,
    pending,
    stale,
    ...state,
    run,
    flush,
    setError,
    acknowledge: () => {
      setError("");
      requestDraft.change("_recordVersion", String(data.draft.rowVersion));
    },
  };
}

function sendPrepare(request: Parameters<typeof intakeBase>[0]) {
  return api("/api/intake-workspace", {
    action: "prepare",
    input: intakeBase(request),
  });
}

function sendSubmit(request: Parameters<typeof submissionInput>[0]) {
  return api<{ requestId: string; displayId: string }>(
    "/api/intake-workspace",
    { action: "submit", input: submissionInput(request) },
  );
}

export function intakeBase({
  data,
  requestDraft,
  content,
  answers,
}: {
  data: IntakeWorkspace;
  requestDraft: ReturnType<typeof useSavedWork>;
  content: Content;
  answers: Array<{ questionIndex: number; answer: string }>;
}) {
  return {
    draftId: data.draft.draftId,
    expectedRowVersion: Number(requestDraft.values._recordVersion),
    content,
    answers: answers.filter((answer) => answer.answer.trim()),
    ...(data.job && { jobId: data.job.jobId }),
  };
}

export function submissionInput({
  data,
  requestDraft,
  submissionDraft,
  content,
  answers,
  suggestion,
  idempotencyKey,
}: {
  data: IntakeWorkspace;
  requestDraft: ReturnType<typeof useSavedWork>;
  submissionDraft: ReturnType<typeof useSavedWork>;
  content: Content;
  answers: Array<{ questionIndex: number; answer: string }>;
  suggestion: IntakeWorkspace["suggestion"];
  idempotencyKey: string;
}) {
  const matched =
    suggestion && submissionDraft.values._suggestionJob === suggestion.jobId;
  const proposals = estimateProposals(submissionDraft.values);
  return {
    ...intakeBase({ data, requestDraft, content, answers }),
    rating: Number(submissionDraft.values.rating),
    idempotencyKey,
    ...(proposals.length > 0 && { priorityProposals: proposals }),
    ...(matched && {
      suggestionJobId: suggestion.jobId,
      suggestionDecision: submissionDraft.values.suggestionDecision,
      suggestionReason: submissionDraft.values.suggestionReason || undefined,
    }),
  };
}

/** FormMessages reads one saved-work draft; the workspace supplies its request draft. */
function WorkspaceMessages({
  form,
}: {
  form: ReturnType<typeof useWorkspaceForm>;
}) {
  return (
    <FormMessages
      form={{ ...form, work: form.requestDraft }}
      showSaveStatus={false}
      subject="request"
    />
  );
}

function IntakeDesignNote() {
  return (
    <DesignNote title="Intake · Requirements, not technical routing">
      The requester explains the need. Only a clear strong fit is shown here;
      detailed service and asset comparisons stay with the reviewer. Accepting a
      suggestion is not an approval or access grant.
    </DesignNote>
  );
}

function WorkspaceActions({
  form,
  disabled,
}: {
  form: ReturnType<typeof useWorkspaceForm>;
  disabled: boolean;
}) {
  return (
    <div className="actions">
      <Button type="submit" disabled={form.stale}>
        {primaryActionLabel(form.pending, form.refine)}
      </Button>
      <SaveAndExit flush={form.flush} disabled={disabled} />
    </div>
  );
}

function WorkspaceForm({
  data,
  refresh,
}: {
  data: IntakeWorkspace;
  refresh: () => Promise<void>;
}) {
  const form = useWorkspaceForm(data, refresh);
  const [ratingAttempted, setRatingAttempted] = useState(false);
  const invalidRating = ratingAttempted && !form.submissionDraft.values.rating;
  const disabled =
    form.pending || !form.requestDraft.ready || !form.submissionDraft.ready;
  return (
    <>
      <RatingErrorSummary invalid={invalidRating} />
      <WorkspaceErrors data={data} form={form} />
      <AssistanceOutcome data={data} form={form} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.run(form.refine ? "prepare" : "submit");
        }}
      >
        <fieldset className="usa-fieldset" disabled={disabled}>
          <div className={styles.intakeReviewGrid}>
            <IntakeQuestions data={data} form={form} />
            <WorkingDetails form={form} />
          </div>
          {form.suggestion && (
            <OneSuggestion
              suggestion={form.suggestion}
              requestDraft={form.submissionDraft}
            />
          )}
          {form.changed && !data.canPrepare && (
            <p>
              Your changes will go to OIT with the request. OIT will check any
              earlier matches against the updated details.
            </p>
          )}
          {!form.refine && (
            <section
              className={styles.sendRequest}
              aria-labelledby="send-heading"
            >
              <h2 id="send-heading">Send to OIT</h2>
              <p>
                OIT will review your requirements and identify the right way
                forward.
              </p>
              <PriorityInvitation draft={form.submissionDraft} />
              <TaskRating
                value={form.submissionDraft.values.rating}
                onChange={(value) =>
                  form.submissionDraft.change("rating", value)
                }
                invalid={invalidRating}
                onMissing={() => setRatingAttempted(true)}
              />
            </section>
          )}
          {form.refine && (
            <p>
              We’ll update the summary with your changes. You can review it
              before sending the request to OIT.
            </p>
          )}
          <WorkspaceActions form={form} disabled={disabled} />
        </fieldset>
        <SavedWorkFooter
          work={visibleSaveWork(form.requestDraft, form.submissionDraft)}
          onError={form.setError}
        />
      </form>
      <IntakeDesignNote />
    </>
  );
}

function WorkspaceErrors({
  data,
  form,
}: {
  data: IntakeWorkspace;
  form: ReturnType<typeof useWorkspaceForm>;
}) {
  return (
    <>
      <WorkspaceMessages form={form} />
      {form.stale && (
        <section>
          <h2>Currently saved details</h2>
          <RequestSummary content={data.content} />
        </section>
      )}
    </>
  );
}

const savedWorkAttention: Record<SavedWorkKind, number> = {
  failed: 3,
  conflict: 3,
  loadFailed: 3,
  saving: 2,
  queued: 2,
  recovered: 2,
  saved: 1,
  loading: 0,
  idle: 0,
  loaded: 0,
};

export function visibleSaveWork<T extends { status: SavedWorkStatus }>(
  requestDraft: T,
  submissionDraft: T,
): T {
  return savedWorkAttention[submissionDraft.status.kind] >
    savedWorkAttention[requestDraft.status.kind]
    ? submissionDraft
    : requestDraft;
}

function AssistanceOutcome({
  data,
  form,
}: {
  data: IntakeWorkspace;
  form: ReturnType<typeof useWorkspaceForm>;
}) {
  const job = data.job ?? { status: "", current: false };
  if (data.earlierSummary)
    return (
      <p className="intake-update" role="status">
        Your saved summary is still available. OIT will check service matches
        against the latest information.
      </p>
    );
  if (job.status === "succeeded" && job.current)
    return (
      <p className="intake-update" role="status">
        {data.questions.some((question) => question.answer)
          ? "Your answers have been added. Check the changes below, then send your request to OIT."
          : "We’ve organized your description. Check the details and answer what you can."}
      </p>
    );
  return (
    <div className="assistance-unavailable">
      <p>
        {job.status === "failed" || job.status === "capped"
          ? "We couldn’t prepare your request automatically. Your description and answers are saved."
          : "Your saved details are below."}{" "}
        You can edit the details and send them to OIT.
      </p>
      {data.canPrepare && (
        <Button
          type="button"
          outline
          disabled={form.pending}
          onClick={() => void form.run("prepare")}
        >
          Try assistance again
        </Button>
      )}
    </div>
  );
}

function ContentFields({
  requestDraft,
  issue,
}: {
  requestDraft: ReturnType<typeof useSavedWork>;
  issue: ReturnType<typeof contentIssue>;
}) {
  return (
    <>
      {Object.entries(requesterContentLabels).map(([key, label]) => (
        <Field
          key={key}
          name={"request-" + key}
          maxLength={textLimits[key]}
          error={issue?.field === key ? issue.message : undefined}
          label={label}
          value={requestDraft.values[key]}
          onChange={(value) => requestDraft.change(key, value)}
          multiline={key !== "title"}
          required={textFields.has(key)}
          hint={
            !textFields.has(key)
              ? "One item per line; leave blank if you don’t know yet"
              : undefined
          }
        />
      ))}
    </>
  );
}

export function IntakeQuestions({
  data,
  form,
}: {
  data: IntakeWorkspace;
  form: ReturnType<typeof useWorkspaceForm>;
}) {
  const questions = data.questions.filter(
    (question) => question.answer === null,
  );
  if (!questions.length) return null;
  return (
    <section className={styles.intakeQuestions}>
      <h2 id="intake-questions-heading" tabIndex={-1}>
        About your work
      </h2>
      {questions.length > 0 && (
        <p>
          These answers are optional. If you don’t know yet, leave them blank.
        </p>
      )}
      {questions.map((question) =>
        question.answer === null ? (
          <Field
            key={question.turnId}
            name={"answer-" + question.questionIndex}
            maxLength={5000}
            label={question.question}
            multiline
            required={false}
            value={
              form.requestDraft.values["answer-" + question.questionIndex] ?? ""
            }
            onChange={(value) =>
              form.requestDraft.change(
                "answer-" + question.questionIndex,
                value,
              )
            }
          />
        ) : (
          <div className="intake-answer" key={question.turnId}>
            <h3>{question.question}</h3>
            <p>{question.answer}</p>
          </div>
        ),
      )}
      {questions.length > 0 && !data.canPrepare && (
        <p>
          OIT will receive these answers with your request; there is no further
          automated interview.
        </p>
      )}
    </section>
  );
}

function OneSuggestion({
  suggestion,
  requestDraft,
}: {
  suggestion: NonNullable<IntakeWorkspace["suggestion"]>;
  requestDraft: ReturnType<typeof useSavedWork>;
}) {
  const current = requestDraft.values._suggestionJob === suggestion.jobId;
  const decision = current ? requestDraft.values.suggestionDecision : "cleared";
  function choose(value: string) {
    requestDraft.change("_suggestionJob", suggestion.jobId);
    requestDraft.change("suggestionDecision", value);
  }
  return (
    <section
      className={styles.singleSuggestion}
      aria-labelledby="suggestion-heading"
    >
      <h2 id="suggestion-heading">This may already meet your need</h2>
      <h3>{suggestion.name}</h3>
      <p>{suggestion.summary}</p>
      {suggestion.conditions.length > 0 && (
        <ul className="usa-list">
          {suggestion.conditions.map((condition, index) => (
            <li key={index}>{condition}</li>
          ))}
        </ul>
      )}
      <p>
        OIT will still check suitability and any approvals. You can leave this
        decision to the reviewer.
      </p>
      <Label htmlFor="suggestion-decision">
        Does this sound like what you want?
      </Label>
      <Select
        id="suggestion-decision"
        name="suggestion-decision"
        value={decision}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="cleared">I’m not sure — let OIT decide</option>
        <option value="accepted">Yes, this sounds right</option>
        <option value="rejected">No, this does not meet the need</option>
      </Select>
      {decision === "rejected" && (
        <Field
          name="suggestion-reason"
          maxLength={2000}
          label="What is missing?"
          multiline
          value={requestDraft.values.suggestionReason}
          onChange={(value) => requestDraft.change("suggestionReason", value)}
        />
      )}
    </section>
  );
}

function useWorkspaceDrafts(data: IntakeWorkspace) {
  const { metadata } = useApp();
  const scope = {
    visitorId: metadata.visitor.visitorId,
    actingView: "requester",
    subjectKey: data.draft.draftId,
  };
  const requestDraft = useSavedWork(
    {
      ...scope,
      pageKey: "requester-requirements",
      subjectKey: scope.subjectKey + ":" + (data.job?.jobId ?? "manual"),
    },
    {
      ...contentValues(data.content),
      ...answerValues(data.questions),
      _recordVersion: String(data.draft.rowVersion),
    },
  );
  const submissionDraft = useSavedWork(
    { ...scope, pageKey: "requester-submission" },
    {
      rating: String(data.priorSubmissionRating ?? ""),
      idempotencyKey: "",
      suggestionDecision: "cleared",
      suggestionReason: "",
      _suggestionJob: "",
      _previousContent: "",
      ...estimateDraftFields,
    },
  );

  return { requestDraft, submissionDraft };
}

function WorkingDetails({
  form,
}: {
  form: ReturnType<typeof useWorkspaceForm>;
}) {
  const [editing, setEditing] = useState(form.manual);
  useEffect(() => {
    if (form.issue) setEditing(true);
  }, [form.issue]);
  const previous = previousContent(
    form.submissionDraft.values._previousContent,
  );
  const updates = previous ? changedContent(previous, form.content) : [];
  return (
    <section
      className={styles.workingRequest}
      aria-labelledby="working-request-heading"
    >
      <h2 id="working-request-heading" tabIndex={-1}>
        Your request
      </h2>
      {updates.length > 0 && (
        <p className="intake-update">
          Added text is highlighted and underlined. Removed text is crossed out.
        </p>
      )}
      {editing ? (
        <ContentFields requestDraft={form.requestDraft} issue={form.issue} />
      ) : (
        <>
          <h3>
            <InlineChange before={previous?.title} after={form.content.title} />
          </h3>
          <RequestSummary content={form.content} previous={previous} />
        </>
      )}
      <Button type="button" unstyled onClick={() => setEditing(!editing)}>
        {editing ? "Finish editing" : "Edit these details"}
      </Button>
    </section>
  );
}

/** Older drafts have no comparison snapshot, so decoding may find nothing. */
function decodeSnapshot(previous: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(previous);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function previousContent(previous: string): Content | undefined {
  const parsed = decodeSnapshot(previous);
  return parsed ? completeContent(parsed, "") : undefined;
}

export function primaryActionLabel(pending: boolean, refine: boolean) {
  if (pending) return "Saving…";
  return refine ? "Update my request" : "Send request";
}

export function workspaceState(
  data: IntakeWorkspace,
  values: Record<string, string>,
) {
  const content = readContent(values);
  const answers = data.questions
    .filter((question) => question.answer === null)
    .map((question) => ({
      questionIndex: question.questionIndex,
      answer: values["answer-" + question.questionIndex] ?? "",
    }));
  const answersChanged = data.questions.some(
    (question) =>
      (values["answer-" + question.questionIndex] ?? "").trim() !==
      (question.answer ?? "").trim(),
  );
  const changed =
    changedContent(data.content, content).length > 0 || answersChanged;
  const refine = data.canPrepare && changed && data.job?.status === "succeeded";
  const suggestion = changed ? null : data.suggestion;

  return { content, answers, changed, refine, suggestion };
}
