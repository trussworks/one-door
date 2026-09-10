"use client";
import { TableScroll } from "./table-scroll";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "@trussworks/react-uswds";
import type { getConflictComparison } from "../workflow/inventory";

type ComparisonView = Awaited<ReturnType<typeof getConflictComparison>>;
import { sortRows } from "../domain/sorting";
import { SortableHeader, useSort } from "./sort";
import { useData } from "./use-data";
import { CatalogEditor, catalogFields, fieldText } from "./catalog-editor";
import { Problem } from "./fields";
import { errorText } from "./api";
import { useApp } from "./shell";
import styles from "./conflict.module.css";

export function comparisonValue(
  key: string,
  fields: Record<string, unknown>,
  organizations: Array<{ id: string; name: string }>,
) {
  if (key !== "ownerOrganizationId") return fieldText(fields[key]);
  const mapped = organizations.find(
    (organization) => organization.id === fields.ownerOrganizationId,
  )?.name;
  if (fields.owner)
    return (
      String(fields.owner) +
      (mapped ? "\nMapped team: " + mapped : "\nNo team mapping recorded")
    );
  return mapped ?? fieldText(fields.ownerOrganizationId);
}

export function ConflictPage({ id }: { id: string }) {
  const result = useData<ComparisonView>("/api/conflicts/" + id);
  const router = useRouter();
  if (!result.data)
    return (
      <>
        <h1>Source disagreement</h1>
        {result.error ? (
          <Problem>{errorText(result.error)}</Problem>
        ) : (
          <p role="status">Loading the source evidence…</p>
        )}
      </>
    );
  const data = result.data;
  return (
    <>
      <p className="breadcrumb">
        <Link href="/catalog">Catalog</Link> / Source disagreement
      </p>
      <h1>Resolve source disagreement</h1>
      <p>
        {data.item?.name ?? "No catalog item is linked"} · {data.conflict.state}{" "}
        · Evidence version {data.conflict.currentEvidenceVersion}
      </p>
      <p>
        Compare what each source supplied. Choose a supported value or record
        who verified a different value; the original observations will remain
        unchanged.
      </p>
      <ConflictComparison data={data} />
      {data.item && data.conflict.state !== "resolved" && (
        <CatalogEditor
          item={data.item}
          conflict={data.conflict}
          subjectKey={data.conflict.id}
          sources={data.members}
          saved={(itemId) => router.push("/catalog/" + itemId)}
          close={() => router.push("/catalog/" + data.item?.id)}
          refresh={result.refresh}
        />
      )}
      {data.item && data.conflict.state === "resolved" && (
        <Link href={"/catalog/" + data.item.id}>
          Open the resolved catalog entry
        </Link>
      )}
    </>
  );
}

function ConflictComparison({ data }: { data: ComparisonView }) {
  const { metadata } = useApp();
  const sort = useSort({ key: "field", direction: "asc" });
  const fieldRows = sortRows(
    Object.entries(catalogFields),
    sort.state,
    ([, label]) => label,
  );
  return (
    <TableScroll
      label="Compare catalog and source values"
      className={styles.comparisonTable}
    >
      <Table fullWidth compact bordered={false}>
        <caption>
          Current catalog alongside the conflicting source records
        </caption>
        <thead>
          <tr>
            <SortableHeader sortKey="field" label="Field" sort={sort} />
            <th scope="col">Current catalog</th>
            {data.members.map((member) => (
              <th key={member.sourceRecordId} scope="col">
                {member.sourceName}
                <span className="request-meta">
                  {new Date(member.observedAt).toLocaleDateString()}
                </span>
                <Link href={"/observations/" + member.sourceRecordId}>
                  Open original record
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fieldRows.map(([key, label]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td className="preserve-lines">
                {comparisonValue(
                  key,
                  data.item ?? {},
                  metadata.organizations,
                ) || "Not recorded"}
              </td>
              {data.members.map((member) => (
                <td className="preserve-lines" key={member.sourceRecordId}>
                  {comparisonValue(
                    key,
                    member.normalizedFields,
                    metadata.organizations,
                  ) || "Not supplied by this source"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}
