"use client";

import styles from "./record-history.module.css";
import tableStyles from "./table-scroll.module.css";
import { TableScroll } from "./table-scroll";
import { Table } from "@trussworks/react-uswds";
import type { RequestView } from "../server/request-views";
import { sortRows } from "../domain/sorting";
import { SortableHeader, useSort } from "./sort";
import { useApp } from "./shell";
import { formatScore, riskDecisionLabels } from "./status-labels";

const eventLabels: Record<string, string> = {
  request_submitted: "Request submitted",
  clarification_asked: "Request clarification asked",
  clarification_answered: "Request clarification answered",
  asset_decision_saved: "Option decision recorded",
  asset_outcome_recorded: "Option outcome recorded",
  risk_decision_saved: "Policy decision recorded",
  risk_outcome_recorded: "Policy review outcome recorded",
  rice_saved: "RICE score recorded",
  review_assigned: "Review responsibilities updated",
  human_routing_recorded: "Delivery lead and next task recorded",
  first_review_completed: "First review completed",
  handoff_confirmed: "Delivery handoff confirmed",
  handoff_failed: "Delivery handoff failed",
  request_resolved: "Final outcome recorded",
  service_fit_decided: "Requester decided on a service suggestion",
  service_suggestions_rejected: "Requester rejected service suggestions",
  intake_answers_saved: "Intake answers saved",
  intake_confirmed: "Requester confirmed the request summary",
  work_item_linked: "Work item linked",
  review_candidate_added: "Existing option added for review",
  review_submitted: "Review changes recorded",
  priority_reviewed: "Priority decisions recorded",
  work_item_status_updated: "Linked work status updated",
  asset_fit_decided: "Requester feedback on an existing option recorded",
  intake_prepared: "Request information prepared",
};

export function RecordHistory({
  data,
  own = false,
}: {
  data: RequestView;
  own?: boolean;
}) {
  const { metadata } = useApp();
  return (
    <section id="history">
      <h2>Request history</h2>
      <IntakeDialogue questions={data.intakeDialogue} />
      {data.record.clarifications.map((entry) => (
        <div className={styles.historyEntry} key={entry.id}>
          <p>
            Asked by{" "}
            <strong>
              {metadata.actors.find(
                (actor) => actor.id === entry.askedByActorId,
              )?.displayName ?? "Reviewer"}
            </strong>{" "}
            on {new Date(entry.askedAt).toLocaleString()}
          </p>
          <p>{entry.question}</p>
          <p>{entry.answer ?? "No answer recorded."}</p>
          {entry.answeredAt && (
            <p>Recorded: {new Date(entry.answeredAt).toLocaleString()}</p>
          )}
        </div>
      ))}
      <details>
        <summary>Activity and decisions</summary>
        <ol>
          {data.evidence.events.map(({ event, actorName }) => (
            <li key={event.id}>
              <strong>
                {eventLabels[event.eventType] ??
                  event.eventType.replaceAll("_", " ")}
              </strong>{" "}
              — {actorName ?? "System"},{" "}
              {new Date(event.createdAt).toLocaleString()}
              {event.origin === "fixture" && " · Fictional example"}
              {event.eventType === "human_routing_recorded" && (
                <RoutingHistory payload={event.payload} />
              )}
            </li>
          ))}
        </ol>
      </details>
      <RevisionHistory data={data} />
      {!own && (
        <>
          <RiceHistory data={data} />
          <DecisionHistory data={data} />
        </>
      )}
      <details>
        <summary>Task satisfaction ratings</summary>
        <ul>
          {data.evidence.ratings.map(({ completion, actorName }) => (
            <li key={completion.id}>
              {completion.taskType === "requester_submission"
                ? "Submitting the request"
                : "Completing first review"}
              : {completion.rating} / 5 — {actorName},{" "}
              {new Date(completion.completedAt).toLocaleString()}
              {completion.origin === "fixture" && " · Fictional example"}
            </li>
          ))}
        </ul>
      </details>
      {!own && <ModelHistory data={data} />}
    </section>
  );
}

export function RoutingHistory({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const recorded = payload.recorded as { nextOwner?: unknown } | null;
  if (typeof recorded?.nextOwner !== "string") return null;
  const previous = payload.previous as { nextOwner?: unknown } | null;
  return (
    <div className={styles.historyEntry}>
      <p>
        <strong>Delivery plan recorded at this event:</strong>{" "}
        {recorded.nextOwner}
      </p>
      {typeof previous?.nextOwner === "string" && (
        <p>
          <strong>Replaced delivery plan:</strong> {previous.nextOwner}
        </p>
      )}
    </div>
  );
}

export function IntakeDialogue({
  questions,
}: {
  questions: RequestView["intakeDialogue"];
}) {
  if (!questions.length) return null;
  return (
    <section className={styles.dialogue}>
      <h3>Original request conversation</h3>
      <dl>
        {questions.map((entry) => (
          <div className="intake-answer" key={entry.turnId}>
            <dt>{entry.question}</dt>
            <dd>
              {entry.isQuestion === false
                ? "Intake note"
                : (entry.answer ?? "No answer recorded.")}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const historyContentLabels: Record<string, string> = {
  title: "Request title",
  problem: "Problem to solve",
  affectedPeople: "Who is affected",
  acceptanceCriteria: "What must be achieved",
  requirements: "What the solution must do",
  constraints: "Limits to work within",
  unknowns: "Still unknown",
};
function RevisionHistory({ data }: { data: RequestView }) {
  return (
    <details>
      <summary>
        {"Request revisions (" + data.evidence.revisions.length + ")"}
      </summary>
      {data.evidence.revisions.map(({ revision, actorName }) => (
        <details key={revision.id}>
          <summary>
            Version {revision.revisionNumber}
            {revision.id === data.record.currentRevisionId
              ? " · Current"
              : " · Earlier"}{" "}
            — {actorName}, {new Date(revision.createdAt).toLocaleString()}
          </summary>
          <dl className={styles.revisionContent}>
            {Object.entries(revision.content).map(([key, value]) => (
              <div key={key}>
                <dt>{historyContentLabels[key] ?? key}</dt>
                <dd>
                  {Array.isArray(value)
                    ? value.join("\n")
                    : String(value ?? "")}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ))}
    </details>
  );
}

function RiceHistory({ data }: { data: RequestView }) {
  return (
    <details>
      <summary>Recorded scores and estimates</summary>
      <p>
        Earlier estimates remain available for reference. They do not enter the
        current ranking.
      </p>
      {data.scores.map((score) => (
        <details key={score.id}>
          <summary>
            {"Score version " + score.version + ": " + formatScore(score.score)}
            {score.id === data.record.currentRiceScoreId
              ? " · Current"
              : " · Earlier"}{" "}
            — {new Date(score.createdAt).toLocaleString()}
          </summary>
          <p>
            Reach unit and period: {score.reachUnit}, {score.reachPeriod}.
            Effort values in this table are in person-months.
          </p>
          <RiceFactorTable score={score} />
        </details>
      ))}
    </details>
  );
}

function RiceFactorTable({ score }: { score: RequestView["scores"][number] }) {
  const { metadata } = useApp();
  const sort = useSort({ key: "factor", direction: "asc" });
  const factorValue = (factor: "reach" | "impact" | "confidence" | "effort") =>
    Number(factor === "confidence" ? score.confidence : score[factor]);
  const factors = sortRows(
    ["reach", "impact", "confidence", "effort"] as const,
    sort.state,
    (factor, key) => (key === "factor" ? factor : factorValue(factor)),
  );
  return (
    <TableScroll
      label={"Estimates for score version " + score.version}
      className={tableStyles.naturalWidth}
    >
      <Table fullWidth compact bordered={false}>
        <caption>{"Estimates for score version " + score.version}</caption>
        <thead>
          <tr>
            <SortableHeader sortKey="factor" label="Factor" sort={sort} />
            <SortableHeader sortKey="value" label="Value" sort={sort} />
            <th scope="col">Basis</th>
            <th scope="col">Supplied or reviewed by</th>
          </tr>
        </thead>
        <tbody>
          {factors.map((factor) => (
            <tr key={factor}>
              <th scope="row">{factor[0].toUpperCase() + factor.slice(1)}</th>
              <td>
                {factor === "confidence"
                  ? Number(score.confidence) * 100 + "%"
                  : score[factor]}
              </td>
              <td>{score[`${factor}Rationale`]}</td>
              <td>
                {metadata.actors.find(
                  (actor) => actor.id === score[`${factor}ActorId`],
                )?.displayName ?? "Unknown person"}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

function DecisionHistory({ data }: { data: RequestView }) {
  return (
    <details>
      <summary>Proposals and recorded decisions</summary>
      <p>
        This history includes decisions that have been replaced. View the review
        page for current decisions.
      </p>
      {data.evidence.assetDecisions.map(
        ({ proposal, decision, actorName, name }) => (
          <details key={decision.id}>
            <summary>
              {name}, Catalog version {proposal.catalogVersion} —{" "}
              {decision.decision} by {actorName},{" "}
              {new Date(decision.createdAt).toLocaleString()}
            </summary>
            <p>Reasoning in the matching result: {proposal.rationale}</p>
            <p>
              Requirements reported as covered: {proposal.coverage.join("; ")}
            </p>
            <p>
              Requirements reported as unmet:{" "}
              {proposal.gaps.join("; ") || "None recorded."}
            </p>
            <p>
              Reason for this decision:{" "}
              {decision.reason ?? "No additional reason recorded."}
            </p>
          </details>
        ),
      )}
      {data.evidence.riskDecisions.map(
        ({ finding, decision, actorName, rule }) => (
          <details key={decision.id}>
            <summary>
              {rule.code} — {riskDecisionLabels[decision.decision]} by{" "}
              {actorName}, {new Date(decision.createdAt).toLocaleString()}
            </summary>
            <p>{rule.rule}</p>
            <p>Source: {rule.citation}</p>
            <p>Model interpretation: {finding.evidence}</p>
            <p>
              Proposed severity: {finding.proposedSeverity}. Reviewed severity:{" "}
              {decision.finalSeverity}.
            </p>
            <p>Reason for this decision: {decision.rationale}</p>
          </details>
        ),
      )}
    </details>
  );
}

function ModelHistory({ data }: { data: RequestView }) {
  return (
    <details>
      <summary>Preparation records</summary>
      <p>
        Model results may infer coverage and policy concerns. People must review
        those claims; preparation does not verify them or approve the request.
        Earlier preparation records remain available.
      </p>
      {data.evidence.calls.map((call) => (
        <details key={call.id}>
          <summary>
            {call.purpose.replaceAll("_", " ")} · {call.status} · {call.model} ·{" "}
            {new Date(call.createdAt).toLocaleString()}
          </summary>
          <dl>
            <dt>Prompt version</dt>
            <dd>{call.promptVersion}</dd>
            <dt>Input fingerprint</dt>
            <dd className={styles.fingerprint}>{call.inputHash}</dd>
            <dt>Recorded cost</dt>
            <dd>
              {call.actualCostMicros === null
                ? "Final cost is pending. The reserved amount remains in the usage ledger."
                : "$" + (call.actualCostMicros / 1_000_000).toFixed(4)}
            </dd>
          </dl>
          <details>
            <summary>Source identifiers and validated model results</summary>
            <pre className={styles.json}>
              {JSON.stringify(
                { corpus: call.corpusVersions, output: call.validatedOutput },
                null,
                2,
              )}
            </pre>
          </details>
        </details>
      ))}
    </details>
  );
}
