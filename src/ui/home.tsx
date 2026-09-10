"use client";
import Link from "next/link";
import { Table } from "@trussworks/react-uswds";
import type { MyWork } from "../server/my-work";
import { sortRows } from "../domain/sorting";
import { SortableHeader, useUrlSort } from "./sort";
import { phaseLabels } from "./status-labels";
import { useData } from "./use-data";
import { errorText } from "./api";
import { DesignNote, Problem } from "./fields";
import styles from "./home.module.css";

export function MyRequests() {
  const { data, error } = useData<MyWork>("/api/work");
  return (
    <>
      <h1>My requests</h1>
      <p className="intro">
        Get help with software or infrastructure. Describe what you need to do;
        OIT will review the requirements and identify the right way forward.
      </p>
      <div className="actions">
        <Link className="usa-button" href="/new">
          Start a new request
        </Link>
      </div>
      {error && <Problem>{errorText(error)}</Problem>}
      {!data && !error && <p role="status">Loading your saved work…</p>}
      {data && <SavedRequests data={data} />}
      <DesignNote title="Intake · One place to start">
        The guided process helps customers articulate the problem, define
        acceptance criteria, and record high-level requirements. You do not need
        to know OIT’s service names.
      </DesignNote>
    </>
  );
}

function requestStatus(request: MyWork["requests"][number]) {
  return request.answerNeeded
    ? "Your answer is needed"
    : phaseLabels[request.phase];
}

function SavedRequests({ data }: { data: MyWork }) {
  const sort = useUrlSort("/my", ["request", "status"]);
  const requests = sortRows(data.requests, sort.state, (request, key) =>
    key === "request" ? request.title : requestStatus(request),
  );
  return (
    <>
      {data.startedDrafts.length > 0 && (
        <section>
          <h2>Started drafts</h2>
          <ul className={styles.savedDrafts}>
            {data.startedDrafts.map((draft) => (
              <li key={draft.route}>
                <Link href={draft.route}>{draft.title}</Link>
                <span className="muted">
                  Saved {new Date(draft.savedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.drafts.length > 0 && (
        <section>
          <h2>Saved drafts</h2>
          <ul className={styles.savedDrafts}>
            {data.drafts.map((draft) => (
              <li key={draft.draftId}>
                <Link href={"/new?draft=" + draft.draftId}>
                  {draft.displayTitle}
                </Link>
                <span className="muted">
                  Last saved {new Date(draft.workSavedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.requests.length === 0 ? (
        <p>No submitted requests yet.</p>
      ) : (
        <Table bordered={false} fullWidth striped compact>
          <caption>Your submitted requests</caption>
          <thead>
            <tr>
              <SortableHeader sortKey="request" label="Request" sort={sort} />
              <SortableHeader
                sortKey="status"
                label="Status and next step"
                sort={sort}
              />
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.requestId}>
                <td>
                  <Link href={"/request/" + request.requestId}>
                    {request.title}
                  </Link>
                  <span className="request-meta">{request.displayId}</span>
                </td>
                <td>
                  {requestStatus(request)}
                  <span className="request-meta">
                    {requesterNextStep(request.answerNeeded, request.phase)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

export function requesterNextStep(answerNeeded: boolean, phase: string) {
  if (answerNeeded) return "Open the request to send your answer.";
  return phase === "resolved"
    ? "Open the request to see the outcome."
    : "OIT is responsible for the next step. Open the request for updates.";
}
