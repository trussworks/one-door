import type { IntakeResult } from "../models/contracts";
import styles from "./requester.module.css";

export const requesterContentLabels = {
  title: "Request title",
  problem: "Problem to solve",
  affectedPeople: "Who is affected",
  acceptanceCriteria: "What must be achieved",
  requirements: "What the solution must do",
  constraints: "Limits to work within",
  unknowns: "Still unknown",
} as const;

export function RequestSummary({
  content,
  changedFields = [],
  previous,
  unknownsLabel = requesterContentLabels.unknowns,
  singleColumn,
  heading = "h3",
}: {
  content: IntakeResult["content"];
  changedFields?: string[];
  previous?: IntakeResult["content"];
  unknownsLabel?: string;
  /** The reviewer's brief reads as one prose column; the requester
   * workspace keeps its two-column fact grid. */
  singleColumn?: boolean;
  heading?: "h2" | "h3";
}) {
  const prior: Partial<IntakeResult["content"]> = previous ?? {};
  return (
    <div className={styles.requestSummary}>
      <p className="summary-need">
        <InlineChange before={prior.problem} after={content.problem} />{" "}
        {changedFields.includes("problem") && (
          <span className={styles.fieldUpdate}>Changed</span>
        )}
      </p>
      {(content.affectedPeople || prior.affectedPeople) && (
        <p>
          <strong>Who is affected:</strong>{" "}
          <InlineChange
            before={prior.affectedPeople}
            after={content.affectedPeople}
          />
          {changedFields.includes("affectedPeople") && (
            <span className={styles.fieldUpdate}>Changed</span>
          )}
        </p>
      )}
      <div
        className={
          styles.summaryFacts + (singleColumn ? " " + styles.singleColumn : "")
        }
      >
        <SummaryList
          heading={heading}
          label={requesterContentLabels.acceptanceCriteria}
          values={content.acceptanceCriteria}
          previous={prior.acceptanceCriteria}
          updated={changedFields.includes("acceptanceCriteria")}
        />
        <SummaryList
          heading={heading}
          label={requesterContentLabels.requirements}
          values={content.requirements}
          previous={prior.requirements}
          updated={changedFields.includes("requirements")}
        />
        <SummaryList
          heading={heading}
          label={requesterContentLabels.constraints}
          values={content.constraints}
          previous={prior.constraints}
          updated={changedFields.includes("constraints")}
        />
        <SummaryList
          heading={heading}
          label={unknownsLabel}
          values={content.unknowns}
          previous={prior.unknowns}
          updated={changedFields.includes("unknowns")}
        />
      </div>
    </div>
  );
}

function SummaryList({
  heading: Heading,
  label,
  values,
  updated,
  previous,
}: {
  heading: "h2" | "h3";
  label: string;
  values: string[];
  updated: boolean;
  previous?: string[];
}) {
  const removed = previous?.filter((value) => !values.includes(value)) ?? [];
  return values.length || updated || removed.length ? (
    <section className={styles.summaryFact}>
      <Heading>
        {label} {updated && <span className={styles.fieldUpdate}>Changed</span>}
      </Heading>
      {values.length || removed.length ? (
        <ul className="usa-list">
          {values.map((value, index) => (
            <li key={index}>
              <InlineChange
                before={previous && (previous.includes(value) ? value : "")}
                after={value}
              />
            </li>
          ))}
          {removed.map((value, index) => (
            <li key={"removed-" + index}>
              <InlineChange before={value} after="" />
            </li>
          ))}
        </ul>
      ) : null}
      {values.length === 0 && <p>No current entries in this list.</p>}
    </section>
  ) : null;
}

export function textChange(before: string, after: string) {
  const oldWords = before.split(/(\s+)/);
  const newWords = after.split(/(\s+)/);
  let start = 0;
  while (
    start < oldWords.length &&
    start < newWords.length &&
    oldWords[start] === newWords[start]
  )
    start++;
  let oldEnd = oldWords.length;
  let newEnd = newWords.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldWords[oldEnd - 1] === newWords[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return {
    prefix: newWords.slice(0, start).join(""),
    removed: oldWords.slice(start, oldEnd).join(""),
    added: newWords.slice(start, newEnd).join(""),
    suffix: newWords.slice(newEnd).join(""),
  };
}

export function InlineChange({
  before,
  after,
}: {
  before?: string;
  after: string;
}) {
  if (before === undefined || before === after) return after;
  const change = textChange(before, after);
  return (
    <>
      {change.prefix}
      {change.removed && (
        <>
          <span className="usa-sr-only">Removed: </span>
          <del className={styles.textRemoved}>{change.removed}</del>{" "}
        </>
      )}
      {change.added && (
        <>
          <span className="usa-sr-only">Added: </span>
          <ins className={styles.textAdded}>{change.added}</ins>
        </>
      )}
      {change.suffix}
    </>
  );
}
