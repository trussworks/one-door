"use client";
import Link from "next/link";
import { Table } from "@trussworks/react-uswds";
import type { WorkItemView } from "../server/work-item";
import { sortRows } from "../domain/sorting";
import { SortableHeader, useSort } from "./sort";
import { useData } from "./use-data";
import { Problem } from "./fields";
import { errorText } from "./api";
import { externalSystemLabels } from "./status-labels";
import { WorkStatusEditor } from "./work-status-editor";

export function workLinkLabel(relationship: string) {
  const labels: Record<string, string> = {
    delivery_work: "Delivery work",
    required: "Required work",
    supporting: "Supporting work",
  };
  return labels[relationship] ?? relationship.replaceAll("_", " ");
}

export function WorkItemPage({ id }: { id: string }) {
  const source = useData<WorkItemView>("/api/work-items/" + id);
  if (!source.data)
    return (
      <>
        <h1>Delivery work</h1>
        {source.error ? (
          <Problem>{errorText(source.error)}</Problem>
        ) : (
          <p role="status">Loading the work item…</p>
        )}
      </>
    );
  const { item, requests } = source.data;
  return (
    <>
      <p className="breadcrumb">
        <Link href="/dashboard">Dashboard</Link> / Delivery work
      </p>
      <h1>
        {item.externalId}: {item.title}
      </h1>
      <p>
        Local demonstration of {externalSystemLabels[item.system]} data. No real
        tenant is connected.
      </p>
      <WorkItemFacts item={item} />
      <WorkStatusEditor item={item} refresh={source.refresh} />
      <h2>Related requests</h2>
      {requests.length ? (
        <ul>
          {requests.map((request) => (
            <li key={request.requestId}>
              <Link href={"/admin/requests/" + request.requestId}>
                {request.displayId}: {request.title}
              </Link>{" "}
              · {workLinkLabel(request.relationship)}
            </li>
          ))}
        </ul>
      ) : (
        <p>This work has not been linked to a request.</p>
      )}
      <p>
        Record the request’s final outcome from its request record. A closed
        external item does not by itself establish fulfillment.
      </p>
      {source.data.historicalRequests.length > 0 && (
        <details>
          <summary>Earlier request links</summary>
          <ul>
            {source.data.historicalRequests.map((request) => (
              <li key={request.requestId + ":" + request.requestGeneration}>
                <Link href={"/admin/requests/" + request.requestId}>
                  {request.displayId}: {request.title}
                </Link>{" "}
                · Earlier example run {request.requestGeneration}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function WorkItemFacts({ item }: { item: WorkItemView["item"] }) {
  const sort = useSort({ key: "field", direction: "asc" });
  const rows = sortRows(
    [
      ["Source status", item.sourceStatus],
      ["Source health", item.derivedHealth],
      [
        "Last synchronized",
        item.lastSynchronizedAt
          ? new Date(item.lastSynchronizedAt).toLocaleString()
          : "Not recorded",
      ],
      [
        "Closed",
        item.closedAt
          ? new Date(item.closedAt).toLocaleString()
          : "No closure recorded",
      ],
    ] as const,
    sort.state,
    ([label]) => label,
  );
  return (
    <Table fullWidth compact bordered={false}>
      <caption>Latest imported or simulated work status</caption>
      <thead>
        <tr>
          <SortableHeader sortKey="field" label="Field" sort={sort} />
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
