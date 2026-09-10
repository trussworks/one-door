"use client";

import styles from "./review-brief.module.css";

import { useState } from "react";
import { Button, Label, TextInput } from "@trussworks/react-uswds";
import type { RecordProps } from "./record-form";
import { useRecordForm } from "./record-form";
import { useData } from "./use-data";
import { errorText } from "./api";
import { Problem } from "./fields";
import { FormMessages } from "./saved-work-presentation";

import { ADD_CANDIDATE_ACTION } from "./review-input-contracts";

export type CatalogueEntry = {
  id: string;
  name: string;
  vendor: string | null;
  description: string;
  capabilities: string[];
  publicationState: string;
  approvalStatus: string;
  currentVersion: number;
};

/** Case-insensitive match on name, vendor, and capability text. */
export function filterCatalogue<T extends CatalogueEntry>(
  entries: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    (
      entry.name +
      " " +
      (entry.vendor ?? "") +
      " " +
      entry.capabilities.join(" ")
    )
      .toLowerCase()
      .includes(needle),
  );
}

/** The in-place catalogue view: the assessment steps aside while the
 * reviewer searches, and an added option returns them to the reading with
 * the new claim awaiting judgment. */
export function CatalogueView({
  data,
  changed,
  onBack,
}: RecordProps & { onBack: () => void }) {
  const [query, setQuery] = useState("");
  const source = useData<CatalogueEntry[]>("/api/catalog");
  const form = useRecordForm({
    data,
    changed,
    pageKey: "catalogue-search",
    initial: {},
  });
  const existing = new Set(
    data.candidates.map((candidate) => candidate.catalogItemId),
  );
  return (
    <div>
      <p className="section-return">
        <button type="button" className={styles.linkish} onClick={onBack}>
          Return to review
        </button>
      </p>
      <h1>Existing products and services</h1>
      <p className={styles.context}>{data.record.title}</p>
      <p>
        Search the full catalog for other options. An option you add still needs
        your decision.
      </p>
      <Label htmlFor="catalogue-query">Search products and services</Label>
      {/* USWDS floats [type=search] left for its attached-button search
       * bar; standalone here that float pulls the first result beside
       * the box, so the input stays a plain text type. */}
      <TextInput
        id="catalogue-query"
        name="catalogue-query"
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <CatalogueResults
        error={source.error}
        entries={source.data}
        query={query}
        existing={existing}
        form={form}
        onAdded={onBack}
      />
      <FormMessages form={form} />
    </div>
  );
}

function CatalogueResults({
  error,
  entries,
  query,
  existing,
  form,
  onAdded,
}: {
  error: unknown;
  entries: CatalogueEntry[] | undefined;
  query: string;
  existing: Set<string>;
  form: ReturnType<typeof useRecordForm>;
  onAdded: () => void;
}) {
  if (error) return <Problem>{errorText(error)}</Problem>;
  if (!entries) return <p role="status">Loading catalog…</p>;
  const matches = filterCatalogue(entries, query);
  if (matches.length === 0)
    return <p>No matches. Try another name or capability.</p>;
  return (
    <>
      {matches.map((entry) => (
        <CatalogueResult
          key={entry.id}
          entry={entry}
          inReview={existing.has(entry.id)}
          form={form}
          onAdded={onAdded}
        />
      ))}
    </>
  );
}

function CatalogueResult({
  entry,
  inReview,
  form,
  onAdded,
}: {
  entry: CatalogueEntry;
  inReview: boolean;
  form: ReturnType<typeof useRecordForm>;
  onAdded: () => void;
}) {
  return (
    <details className={styles.claim}>
      <summary>
        <span>
          <strong>{entry.name}</strong>
          {entry.vendor && " · " + entry.vendor} —{" "}
          {entry.capabilities.slice(0, 3).join("; ") ||
            "No capabilities recorded."}
        </span>
      </summary>
      <div className={styles.claimBody}>
        <p>{entry.description}</p>
        {entry.capabilities.length > 0 && (
          <ul className="usa-list">
            {entry.capabilities.map((capability, index) => (
              <li key={index}>{capability}</li>
            ))}
          </ul>
        )}
        <p className={styles.provenance}>
          Catalog version {entry.currentVersion} · Publication status{" "}
          {entry.publicationState} · Catalog approval status{" "}
          {entry.approvalStatus}
        </p>
        {inReview ? (
          <p className={styles.draftState}>Already in this review</p>
        ) : (
          <Button
            type="button"
            outline
            disabled={form.pending || form.stale}
            onClick={async () => {
              const added = await form.action(
                ADD_CANDIDATE_ACTION,
                { catalogItemId: entry.id },
                entry.name +
                  " added for review. No decision has been recorded.",
              );
              if (added) onAdded();
            }}
          >
            Add for review
          </Button>
        )}
      </div>
    </details>
  );
}
