"use client";
import { TableScroll } from "./table-scroll";
import tableStyles from "./table-scroll.module.css";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Label, Select, Table } from "@trussworks/react-uswds";
import type { DashboardView } from "../server/dashboard";
import type { QueueRow } from "../server/queue";
import { sortRows } from "../domain/sorting";
import { SortableHeader, useSort, useUrlSort } from "./sort";
import { useData } from "./use-data";
import { errorText } from "./api";
import { useApp } from "./shell";
import { Problem, DesignNote, RefreshStatus } from "./fields";
import { phaseLabels, actionLabels } from "./status-labels";
import { factorLabels } from "./review-input-contracts";
import styles from "./dashboard.module.css";

export function dashboardLink(
  query: Pick<URLSearchParams, "toString">,
  show: string,
) {
  const next = new URLSearchParams(query.toString());
  next.set("show", show);
  return "/dashboard?" + next;
}

export function Dashboard() {
  const query = useSearchParams();
  const router = useRouter();
  const dataQuery = new URLSearchParams(query);
  for (const key of ["sort", "dir", "show"]) dataQuery.delete(key);
  const source = useData<DashboardView>("/api/dashboard?" + dataQuery, {
    retainPrevious: true,
  });
  const filter = query.get("show") ?? "attention";
  const change = (value: string) => {
    const next = new URLSearchParams(query);
    next.set("show", value);
    router.replace("/dashboard?" + next, { scroll: false });
  };
  const rows = (source.data?.requests ?? []).filter((row) =>
    dashboardMatches(row, filter),
  );
  return (
    <>
      <h1>Dashboard</h1>
      <p>
        See requests and their related work in one place. Open a request to
        assign an owner or record the next decision.
      </p>
      {source.error && <Problem>{errorText(source.error)}</Problem>}
      <RefreshStatus loading={source.loading && Boolean(source.data)} />
      {!source.data && !source.error && (
        <p role="status">Loading operational status…</p>
      )}
      {source.data && (
        <>
          <DashboardTotals totals={source.data.totals} query={query} />
          <Label htmlFor="dashboard-show">Show requests</Label>
          <Select
            id="dashboard-show"
            name="show"
            value={filter}
            onChange={(event) => change(event.target.value)}
          >
            <option value="attention">Need attention</option>
            <option value="open">All open requests</option>
            <option value="unassigned">Missing an owner</option>
            <option value="blocked">Delivery needs attention</option>
            <option value="preparation">Preparation needs attention</option>
            <option value="resolved">Resolved requests</option>
            <option value="all">All requests</option>
          </Select>
          <ThresholdSettings data={source.data} filter={filter} />
          <DashboardRequests rows={rows} back={"/dashboard?" + query} />
          <InputRequestExceptions data={source.data} />
          <SourceHealth data={source.data} />
          <UnlinkedWork data={source.data} />
          <DesignNote title="Monitoring · One request, related work">
            Each request is counted once, even when several delivery items are
            linked to it. Unlinked external work stays separate. Waiting
            defaults are {source.data.thresholds.internalBusinessDays} internal
            and {source.data.thresholds.requesterBusinessDays} requester
            business days, Monday–Friday; they are pilot assumptions, not OIT
            policy.
          </DesignNote>
        </>
      )}
    </>
  );
}

function DashboardTotals({
  totals,
  query,
}: {
  totals: DashboardView["totals"];
  query: URLSearchParams;
}) {
  return (
    <div className={styles.metricRow}>
      {[
        ["open", "Open requests", totals.open],
        ["attention", "Need attention", totals.needAttention],
        ["resolved", "Resolved", totals.resolved],
      ].map(([key, label, value]) => (
        <Link
          key={key}
          href={dashboardLink(query, String(key))}
          className={styles.metricLink}
          scroll={false}
        >
          <strong>{value}</strong>
          {label}
        </Link>
      ))}
    </div>
  );
}

function ThresholdSettings({
  data,
  filter,
}: {
  data: DashboardView;
  filter: string;
}) {
  const router = useRouter();
  const query = useSearchParams();
  return (
    <details>
      <summary>Adjust waiting thresholds for this view</summary>
      <form
        className="queue-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const next = new URLSearchParams(query);
          for (const [key, value] of new FormData(event.currentTarget))
            next.set(key, String(value));
          router.replace("/dashboard?" + next, { scroll: false });
        }}
      >
        <input type="hidden" name="show" value={filter} />
        {[
          [
            "internal",
            "Internal reviewer: business days",
            data.thresholds.internalBusinessDays,
          ],
          [
            "requester",
            "Requester: business days",
            data.thresholds.requesterBusinessDays,
          ],
        ].map(([name, label, value]) => (
          <div key={name}>
            <Label htmlFor={"threshold-" + name}>{label}</Label>
            <input
              className="usa-input"
              id={"threshold-" + name}
              name={String(name)}
              type="number"
              min="1"
              max="365"
              step="1"
              required
              defaultValue={value}
            />
          </div>
        ))}
        <Button type="submit">Apply thresholds</Button>
      </form>
      <p>
        Thresholds stay in this view’s address so reloads and shared links use
        the same rules. They do not change another person’s dashboard.
      </p>
    </details>
  );
}

function dashboardMatches(row: QueueRow, filter: string) {
  if (filter === "attention") return row.needsAttention;
  if (filter === "open") return row.phase !== "resolved";
  if (filter === "resolved") return row.phase === "resolved";
  if (filter === "unassigned") return row.attention.missingOwner;
  if (filter === "blocked") return row.attention.blockedDelivery;
  if (filter === "preparation")
    return row.attention.stalePreparation || row.attention.cappedPreparation;
  return true;
}

const dashboardColumns = [
  ["title", "Request"],
  ["status", "Status / waiting"],
  ["action", "Next action and owner"],
  ["work", "Delivery work"],
] as const;

type DashboardColumn = (typeof dashboardColumns)[number][0];

function dashboardRowValue(
  row: QueueRow,
  key: DashboardColumn,
): string | number {
  if (key === "title") return row.title;
  if (key === "status") return phaseLabels[row.phase];
  if (key === "action") return actionLabels[row.actionNeeded];
  return row.workLinks.length;
}

function DashboardRequests({ rows, back }: { rows: QueueRow[]; back: string }) {
  const sort = useUrlSort(
    "/dashboard",
    dashboardColumns.map(([key]) => key),
  );
  return (
    <>
      <p>{rows.length} requests in this view.</p>
      <TableScroll label="Operational request status" fixedHeight>
        <Table fullWidth compact bordered={false} striped>
          <caption>Requests, next actions, and linked delivery work</caption>
          <thead>
            <tr>
              {dashboardColumns.map(([key, label]) => (
                <SortableHeader
                  key={key}
                  sortKey={key}
                  label={label}
                  sort={sort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortRows(rows, sort.state, dashboardRowValue).map((row) => (
              <tr key={row.requestId}>
                <td>
                  <Link
                    href={
                      "/admin/requests/" +
                      row.requestId +
                      "?back=" +
                      encodeURIComponent(back)
                    }
                  >
                    {row.title}
                  </Link>
                  <span className="request-meta">
                    {row.displayId} · {row.organizationName}
                    {row.origin === "seed" && " · Seeded example"}
                  </span>
                </td>
                <td>
                  {phaseLabels[row.phase]}
                  <span className="request-meta">
                    {row.businessDaysInPhase} business days
                    {row.overdue && " · Review overdue"}
                  </span>
                </td>
                <NextActionCell row={row} />
                <td>
                  {row.workLinks.length
                    ? row.workLinks.map((work) => (
                        <Link
                          className="block-link"
                          key={work.workItemId}
                          href={"/work-items/" + work.workItemId}
                        >
                          {work.externalId} · {work.sourceStatus}
                        </Link>
                      ))
                    : "No linked delivery items"}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </>
  );
}

function NextActionCell({ row }: { row: QueueRow }) {
  const { metadata } = useApp();
  return (
    <td>
      {actionLabels[row.actionNeeded]}
      <span className="request-meta">
        {nextOwnerLabel(row, metadata.actors)}
      </span>
      {row.deliveryOwnerName &&
        row.nextTask &&
        ["approved", "delivery"].includes(row.phase) && (
          <span className="request-meta">{row.nextTask}</span>
        )}
    </td>
  );
}

export function nextOwnerLabel(
  row: Pick<
    QueueRow,
    | "phase"
    | "requesterName"
    | "deliveryOwnerName"
    | "nextOwner"
    | "actionNeeded"
    | "reviewTasks"
    | "coordinatorActorId"
  >,
  people: Array<{ id: string; displayName: string }>,
) {
  if (row.phase === "resolved") return null;
  if (row.phase === "waiting") return row.requesterName;
  if (["approved", "delivery"].includes(row.phase))
    return row.deliveryOwnerName ?? row.nextOwner ?? "Not assigned";
  const areas: Record<string, string> = {
    review_assets: "assets",
    review_risk: "risk",
    score_rice: "rice",
  };
  const assigned =
    row.reviewTasks.find((task) => task.area === areas[row.actionNeeded])
      ?.assigneeActorId ?? row.coordinatorActorId;
  return (
    people.find((person) => person.id === assigned)?.displayName ??
    "Not assigned"
  );
}

const sourceColumns = [
  ["name", "Source"],
  ["health", "Health"],
  ["last", "Last successful update"],
  ["hours", "Expected interval"],
] as const;

function sourceHealthRows(data: DashboardView) {
  return [
    ...data.sources.workSystems.map((system) => ({
      key: system.system,
      href: null as string | null,
      name: system.name,
      health: system.syncHealth,
      last: system.lastSuccessfulAt,
      hours: system.expectedFreshnessHours,
    })),
    ...data.sources.inventorySources.map((source) => ({
      key: source.sourceId,
      href: "/sources/" + source.sourceId,
      name: source.name,
      health: source.health,
      last: source.lastSuccessfulAt,
      hours: source.expectedFreshnessHours,
    })),
  ];
}

function SourceHealth({ data }: { data: DashboardView }) {
  const sort = useSort({ key: "name", direction: "asc" });
  const rows = sortRows(sourceHealthRows(data), sort.state, (row, key) => {
    if (key === "name") return row.name;
    if (key === "health") return row.health;
    if (key === "last") return row.last;
    return row.hours;
  });
  return (
    <section>
      <h2>Source health</h2>
      <p>Last-known data remains visible during a failed or overdue update.</p>
      <TableScroll label="Source health" className={tableStyles.naturalWidth}>
        <Table fullWidth compact bordered={false}>
          <caption>
            Expected refresh intervals and last successful updates
          </caption>
          <thead>
            <tr>
              {sourceColumns.map(([key, label]) => (
                <SortableHeader
                  key={key}
                  sortKey={key}
                  label={label}
                  sort={sort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  {row.href ? (
                    <Link href={row.href}>{row.name}</Link>
                  ) : (
                    row.name
                  )}
                </td>
                <td>{row.health}</td>
                <td>
                  {row.last
                    ? new Date(row.last).toLocaleString()
                    : "None recorded"}
                </td>
                <td>{row.hours} hours</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </section>
  );
}

/** Unresolved review-input questions. The administrator routes them; the
 * assign control lives on the request page, which carries the row versions
 * the assignment needs. */
function InputRequestExceptions({ data }: { data: DashboardView }) {
  const allocation = data.inputRequestsNeedingAllocation;
  const overdue = data.overdueInputRequests;
  if (allocation.length === 0 && overdue.length === 0) return null;
  return (
    <section>
      <h2>Questions needing attention</h2>
      <p>
        Assign questions to someone who knows the subject. Replies appear
        directly in the original review.
      </p>
      <ul>
        {allocation.map((input) => (
          <ExceptionLine
            key={input.id}
            input={input}
            label="Needs an assignee"
          />
        ))}
        {overdue
          .filter((input) => !allocation.some((other) => other.id === input.id))
          .map((input) => (
            <ExceptionLine
              key={input.id}
              input={input}
              label={"Business days waiting: " + input.businessDaysWaiting}
            />
          ))}
      </ul>
    </section>
  );
}

function ExceptionLine({
  input,
  label,
}: {
  input: DashboardView["inputRequestsNeedingAllocation"][number];
  label: string;
}) {
  return (
    <li>
      <Link href={"/admin/requests/" + input.requestId}>
        {input.displayId}
        {input.title && ": " + input.title}
      </Link>{" "}
      — {input.factor ? factorLabels[input.factor] + ": " : ""}
      {input.question}
      {input.expertise && " (" + input.expertise + ")"} · {label}
    </li>
  );
}

function UnlinkedWork({ data }: { data: DashboardView }) {
  return (
    <section>
      <h2>External work without a request link</h2>
      {data.unlinkedWork.length ? (
        <ul>
          {data.unlinkedWork.map((work) => (
            <li key={work.workItemId}>
              <Link href={"/work-items/" + work.workItemId}>
                {work.externalId} · {work.title}
              </Link>{" "}
              — {work.sourceStatus}, {work.syncHealth}
            </li>
          ))}
        </ul>
      ) : (
        <p>All imported work is linked to a request.</p>
      )}
    </section>
  );
}
