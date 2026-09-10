"use client";
import { TableScroll } from "./table-scroll";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, Table } from "@trussworks/react-uswds";
import { useData } from "./use-data";
import { useApp } from "./shell";
import { Problem, Field, DesignNote } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { errorText } from "./api";
import { useAdminForm } from "./admin-form";
import { sortRows } from "../domain/sorting";
import { SortableHeader, useSort } from "./sort";
import { approvals, publications } from "./catalog";
import {
  CatalogEditor,
  catalogFields,
  fieldText,
  type CatalogRecord,
} from "./catalog-editor";
import styles from "./catalog-record.module.css";

export function CatalogItemPage({ id }: { id: string }) {
  const source = useData<CatalogRecord>("/api/catalog/" + id);
  const search = useSearchParams();
  const [editing, setEditing] = useState(false);
  if (!source.data)
    return (
      <>
        <h1>Inventory item</h1>
        {source.error ? (
          <Problem>{errorText(source.error)}</Problem>
        ) : (
          <p role="status">Loading the item…</p>
        )}
      </>
    );
  const data = source.data;
  return (
    <>
      <p className="breadcrumb">
        <Link href={"/catalog?" + (search.get("from") ?? "")}>Catalog</Link> /{" "}
        {data.item.name}
      </p>
      <h1>{data.item.name}</h1>
      <p>
        {publications[data.item.publicationState]} ·{" "}
        {approvals[data.item.approvalStatus]} · Version{" "}
        {data.item.currentVersion}
      </p>
      {source.error && <Problem>{errorText(source.error)}</Problem>}
      <ActiveConflicts conflicts={data.conflicts} />
      {editing ? (
        <CatalogEditor
          item={data.item}
          subjectKey={id}
          sources={data.sources}
          saved={() => {
            setEditing(false);
            source.refresh();
          }}
          close={() => setEditing(false)}
          refresh={source.refresh}
        />
      ) : (
        <>
          <div className="actions">
            <Button type="button" onClick={() => setEditing(true)}>
              Revise the entry
            </Button>
          </div>
          <ItemFacts data={data} />
          <CatalogActions data={data} changed={source.refresh} />
        </>
      )}
      {data.conflicts.some((conflict) => conflict.state === "resolved") && (
        <>
          <h2>Resolved source disagreements</h2>
          <ul>
            {data.conflicts
              .filter((conflict) => conflict.state === "resolved")
              .map((conflict) => (
                <li key={conflict.conflictId}>
                  <Link href={"/conflicts/" + conflict.conflictId}>
                    Review source evidence
                  </Link>{" "}
                  · {conflict.state}
                </li>
              ))}
          </ul>
        </>
      )}
      <FieldHistory data={data} />
      <DesignNote title="Trusted inventory · Preserve the evidence">
        Imported source observations and earlier field decisions remain
        available after revision or retirement. Publication requires approval
        and evidence for material fields.
      </DesignNote>
    </>
  );
}

function ActiveConflicts({
  conflicts,
}: {
  conflicts: CatalogRecord["conflicts"];
}) {
  const open = conflicts.filter((conflict) => conflict.state !== "resolved");
  if (!open.length) return null;
  return (
    <section className="prerequisites">
      <h2>Check the source disagreement first</h2>
      <p>Compare the source records before changing the published value.</p>
      <ul className="usa-list">
        {open.map((conflict) => (
          <li key={conflict.conflictId}>
            <Link href={"/conflicts/" + conflict.conflictId}>
              Compare the source evidence
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ItemFacts({ data }: { data: CatalogRecord }) {
  const { metadata } = useApp();
  const sort = useSort({ key: "field", direction: "asc" });
  const rows = sortRows(
    Object.entries(catalogFields),
    sort.state,
    ([, label]) => label,
  );
  return (
    <Table fullWidth bordered={false} compact>
      <caption>Current catalog values</caption>
      <thead>
        <tr>
          <SortableHeader sortKey="field" label="Field" sort={sort} />
          <th scope="col">Published or draft value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, label]) => (
          <tr key={key}>
            <th scope="row">{label}</th>
            <td className="preserve-lines">
              {key === "ownerOrganizationId"
                ? metadata.organizations.find(
                    (org) => org.id === data.item.ownerOrganizationId,
                  )?.name
                : fieldText(data.item[key as keyof typeof catalogFields]) ||
                  "Not recorded"}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function CatalogActions({
  data,
  changed,
}: {
  data: CatalogRecord;
  changed: () => void;
}) {
  const form = useAdminForm({
    pageKey: "catalog-state",
    subjectKey: data.item.id,
    initial: { reviewDate: data.item.reviewDate },
    rowVersion: data.item.rowVersion,
    changed,
  });
  const ready = form.work.ready && !form.pending && !form.stale;
  return (
    <section>
      <h2>Publication and review</h2>
      <p>
        Only published, approved items are eligible for new recommendations.
        Retiring an item keeps its history and removes it from future matches.
      </p>
      <FormMessages form={form} subject="catalog item" />
      <div className="actions">
        {data.item.publicationState !== "published" && (
          <Button
            type="button"
            disabled={!ready || data.item.approvalStatus !== "approved"}
            onClick={() =>
              void form.action(
                "publishCatalogItem",
                { catalogItemId: data.item.id },
                "Catalog item published. It is eligible for future matching.",
              )
            }
          >
            Publish approved item
          </Button>
        )}
        {data.item.publicationState !== "retired" && (
          <Button
            type="button"
            outline
            disabled={!ready}
            onClick={() => {
              if (
                window.confirm(
                  "Retire this item from future recommendations? Its source evidence and history will remain.",
                )
              )
                void form.action(
                  "retireCatalogItem",
                  { catalogItemId: data.item.id },
                  "Catalog item retired. Its history is retained.",
                );
            }}
          >
            Retire item
          </Button>
        )}
      </div>
      {data.item.approvalStatus !== "approved" && (
        <p>
          To publish, revise the approval status and record its supporting
          evidence.
        </p>
      )}
      <ConfirmAccuracy form={form} itemId={data.item.id} ready={ready} />
    </section>
  );
}

function FieldHistory({ data }: { data: CatalogRecord }) {
  const { metadata } = useApp();
  const sort = useSort({ key: "version", direction: "desc" });
  const author = (decision: CatalogRecord["decisions"][number]) =>
    metadata.actors.find((actor) => actor.id === decision.decidedByActorId)
      ?.displayName ?? "Unknown author";
  const decisions = sortRows(data.decisions, sort.state, (decision, key) => {
    if (key === "version") return decision.canonicalVersion;
    if (key === "field")
      return (
        catalogFields[decision.fieldName as keyof typeof catalogFields] ??
        decision.fieldName
      );
    return author(decision);
  });
  return (
    <section>
      <h2>Field-decision history</h2>
      <TableScroll
        label="Field decisions with source and author"
        className={styles.historyTable}
      >
        <Table fullWidth compact bordered={false}>
          <caption>Recorded catalog decisions</caption>
          <thead>
            <tr>
              <SortableHeader sortKey="version" label="Version" sort={sort} />
              <SortableHeader
                sortKey="field"
                label="Field / value"
                sort={sort}
              />
              <th scope="col">Source or verification</th>
              <SortableHeader
                sortKey="author"
                label="Author / time"
                sort={sort}
              />
            </tr>
          </thead>
          <tbody>
            {decisions.map((decision) => (
              <tr key={decision.id}>
                <td>{decision.canonicalVersion}</td>
                <td>
                  {catalogFields[
                    decision.fieldName as keyof typeof catalogFields
                  ] ?? decision.fieldName}
                  <span className="request-meta preserve-lines">
                    {fieldText(decision.value)}
                  </span>
                </td>
                <td>
                  {decision.sourceRecordId && (
                    <Link href={"/observations/" + decision.sourceRecordId}>
                      Open cited source record
                    </Link>
                  )}
                  <p>{decision.rationale}</p>
                </td>
                <td>
                  {author(decision)}
                  <span className="request-meta">
                    {new Date(decision.createdAt).toLocaleString()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </section>
  );
}

export function NewCatalogItem() {
  const query = useSearchParams();
  const router = useRouter();
  const draft = query.get("draft");
  useEffect(() => {
    if (!draft) router.replace("/catalog/new?draft=" + crypto.randomUUID());
  }, [draft, router]);
  return (
    <>
      <p className="breadcrumb">
        <Link href="/catalog">Catalog</Link> / New item
      </p>
      <h1>Add an inventory item</h1>
      {draft && (
        <CatalogEditor
          subjectKey={draft}
          sources={[]}
          saved={(id) => router.push("/catalog/" + id)}
          close={() => router.push("/catalog")}
          refresh={() => {}}
        />
      )}
    </>
  );
}

function ConfirmAccuracy({
  form,
  itemId,
  ready,
}: {
  form: ReturnType<typeof useAdminForm>;
  itemId: string;
  ready: boolean;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.action(
          "confirmCatalogItemAccurate",
          {
            catalogItemId: itemId,
            reviewDate: form.work.values.reviewDate,
          },
          "The accuracy review and next review date are recorded.",
        );
      }}
    >
      <fieldset
        className="usa-fieldset"
        disabled={!form.work.ready || form.pending}
      >
        <Field
          name="next-review"
          label="Review again by"
          type="date"
          value={form.work.values.reviewDate}
          onChange={(value) => form.work.change("reviewDate", value)}
        />
        <Button type="submit" disabled={!ready}>
          Confirm the entry is still accurate
        </Button>
      </fieldset>
    </form>
  );
}
