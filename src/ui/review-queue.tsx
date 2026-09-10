"use client";

import styles from "./review-queue.module.css";
import { TableScroll } from "./table-scroll";

import { useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Label, Select, Table } from "@trussworks/react-uswds";
import { pageNumber } from "../server/query-options";
import { queueDefaultSort, queueHeadingKeys } from "../domain/sorting";
import {
  SortableHeader,
  SortSummary,
  useUrlSort,
  type SortControl,
} from "./sort";
import { phaseLabels, actionLabels, formatScore } from "./status-labels";
import type { QueueRow, QueueView } from "../server/queue";
import { useData } from "./use-data";
import { useApp } from "./shell";
import { errorText } from "./api";
import { DesignNote, Problem } from "./fields";

type QueueHeadingKey = (typeof queueHeadingKeys)[number];

export function ReviewQueue({
  administrative = false,
}: {
  administrative?: boolean;
}) {
  const search = useSearchParams();
  const router = useRouter();
  const { metadata } = useApp();
  const apiQuery = new URLSearchParams(search);
  const basePath = administrative ? "/admin/requests" : "/review";
  const { sort, change } = useQueueNavigation(basePath);
  apiQuery.set("sort", sort.state.key);
  apiQuery.set("dir", sort.state.direction);
  const reviewer = queueReviewer(search.get("reviewer"), administrative);
  apiQuery.set("reviewer", reviewer);
  const source = useData<QueueView>("/api/queue?" + apiQuery, {
    retainPrevious: true,
  });
  const totalPages = source.data?.pageCount ?? 1;
  const page = pageNumber(search.get("page"));
  useQueuePosition(source, basePath, page, totalPages);
  return (
    <>
      <QueueIntroduction administrative={administrative} />
      {!administrative && (
        <QueueViews query={search.toString()} reviewer={reviewer} />
      )}
      <QueueFilters
        query={search}
        change={change}
        actors={metadata.actors}
        administrative={administrative}
        reviewer={reviewer}
      />
      {source.error && (
        <Problem>
          {source.data
            ? "The queue could not be refreshed. Previously loaded requests are still shown."
            : errorText(source.error)}{" "}
          <Button type="button" onClick={source.refresh}>
            Retry loading
          </Button>
        </Problem>
      )}
      <QueueResults
        data={source.data}
        loading={source.loading}
        query={search.toString()}
        actors={metadata.actors}
        change={change}
        sort={sort}
        basePath={basePath}
        page={page}
        totalPages={totalPages}
        administrative={administrative}
        reset={() =>
          router.push(basePath + (administrative ? "" : "?reviewer=unassigned"))
        }
      />
      <RiceDesignNote />
    </>
  );
}

function useQueuePosition(
  source: ReturnType<typeof useData<QueueView>>,
  basePath: string,
  page: number,
  totalPages: number,
) {
  const search = useSearchParams();
  const router = useRouter();
  const restored = useRef("");
  useEffect(() => {
    if (!source.data || source.loading || source.error) return;
    if (
      location.hash.startsWith("#request-") &&
      restored.current !== location.hash
    ) {
      document
        .getElementById(location.hash.slice(1))
        ?.scrollIntoView({ block: "center" });
      restored.current = location.hash;
    }
    const current = Math.min(page, totalPages);
    if (search.has("page") && search.get("page") !== String(current)) {
      const params = new URLSearchParams(search);
      params.set("page", String(current));
      router.replace(basePath + "?" + params, { scroll: false });
    }
  }, [
    source.data,
    source.loading,
    source.error,
    page,
    totalPages,
    search,
    router,
    basePath,
  ]);
}

function useQueueNavigation(basePath: string) {
  const search = useSearchParams();
  const router = useRouter();
  const sort = useUrlSort(
    basePath,
    queueHeadingKeys,
    "push",
    queueDefaultSort(search),
  );
  function change(key: string, value: string) {
    const params = new URLSearchParams(search);
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.delete("page");
    router.push(basePath + "?" + params, { scroll: false });
  }
  return { sort, change };
}

function QueueViews({ query, reviewer }: { query: string; reviewer: string }) {
  return (
    <nav aria-label="Request views" className="record-links queue-views">
      {[
        ["me", "Assigned to me"],
        ["unassigned", "Needs a coordinator"],
      ].map(([value, label]) => {
        const next = new URLSearchParams(query);
        next.set("reviewer", value);
        next.delete("page");
        return (
          <Link
            key={value}
            href={"/review?" + next}
            scroll={false}
            aria-current={reviewer === value ? "page" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function QueueIntroduction({ administrative }: { administrative: boolean }) {
  const { metadata } = useApp();
  return (
    <>
      <h1>{administrative ? "All requests" : "Review queue"}</h1>
      <p>
        {administrative
          ? "Find requests, assign responsibilities and help work progress."
          : "Start with a request assigned to you or one that needs a coordinator."}
      </p>
      {!administrative && metadata.demoReviewPersona && (
        <p className={styles.demoIdentity}>
          {"This demo queue includes fictional example requests assigned to " +
            metadata.demoReviewPersona.name +
            ", alongside requests assigned to you."}
        </p>
      )}
    </>
  );
}

function QueueFilters({
  query,
  change,
  actors,
  administrative,
  reviewer,
}: {
  query: Pick<URLSearchParams, "get">;
  change: (key: string, value: string) => void;
  actors: Array<{ id: string; displayName: string }>;
  administrative: boolean;
  reviewer: string;
}) {
  return (
    <div
      className={
        administrative
          ? "queue-filters"
          : "queue-filters " + styles.filtersReview
      }
    >
      {administrative && (
        <AssignmentFilter
          actors={actors}
          administrative={administrative}
          reviewer={reviewer}
          change={change}
        />
      )}
      <QueueFilter
        name="phase"
        label="Stage"
        query={query}
        change={change}
        options={phaseLabels}
      />
      <QueueFilter
        name="action"
        label="Next task"
        query={query}
        change={change}
        options={actionLabels}
      />
      <QueueFilter
        name="scored"
        label="Current RICE score"
        query={query}
        change={change}
        options={{ yes: "Has a current score", no: "Not scored" }}
      />
      <QueueFilter
        name="risk"
        label="Risk"
        query={query}
        change={change}
        options={{
          critical: "Critical",
          high: "High or critical",
          moderate: "Moderate or higher",
          low: "Any assessed severity",
          information_gap: "Information missing",
          unassessed: "Not assessed",
        }}
      />
    </div>
  );
}

function ReachBasisWarning({ mixed }: { mixed: boolean }) {
  return mixed ? (
    <p className={styles.reachBasis}>
      Compare scores with care when Reach counts different populations, units or
      time periods.
    </p>
  ) : null;
}

function QueueFilter({
  name,
  label,
  query,
  change,
  options,
}: {
  name: string;
  label: string;
  query: Pick<URLSearchParams, "get">;
  change: (key: string, value: string) => void;
  options: Record<string, string>;
}) {
  return (
    <div>
      <Label htmlFor={name + "-filter"}>{label}</Label>
      <Select
        id={name + "-filter"}
        name={name}
        value={query.get(name) ?? ""}
        onChange={(event) => change(name, event.target.value)}
      >
        <option value="">All</option>
        {Object.entries(options).map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </Select>
    </div>
  );
}

const queueColumns = [
  ["title", "Request"],
  ["organization", "Requester and organization"],
  ["action", "Status and next task"],
  ["coordinator", "Coordinator"],
  ["waiting", "Wait"],
  ["submitted", "Submitted"],
  ["risk", "Risk"],
  ["score", "RICE"],
] as const;

function QueueTable({
  rows,
  loading,
  query,
  actors,
  basePath,
  sort,
}: {
  rows: QueueRow[];
  loading: boolean;
  query: string;
  actors: Array<{ id: string; displayName: string }>;
  basePath: string;
  sort: SortControl<QueueHeadingKey>;
}) {
  return (
    <TableScroll label="Request list" fixedHeight>
      <Table
        fullWidth
        bordered={false}
        compact
        striped
        className={styles.table}
      >
        <caption>Waiting time is shown in business days.</caption>
        <thead>
          <tr>
            {queueColumns.map(([key, name]) => (
              <SortableHeader
                key={key}
                sortKey={key}
                label={name}
                sort={sort}
              />
            ))}
          </tr>
        </thead>
        <tbody inert={loading}>
          {rows.map((row) => (
            <QueueEntry
              key={row.requestId}
              row={row}
              query={query}
              actors={actors}
              basePath={basePath}
            />
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

/** A completed review without a score is pending priority work, not a fixed
 * blank: the label says so and the editor stays reachable. Only a recorded
 * score or a resolved request closes the entry point. */
export function queueScoreLabel(row: {
  score: string | number | null;
  stage: string;
}): string {
  if (row.score === null && row.stage === "first_review_completed")
    return "Not ranked";
  return formatScore(row.score);
}

/** The score cell links into the brief's priority section — per-factor
 * review replaced the old four-step modal. */
function ScoreLink({
  row,
  basePath,
  query,
}: {
  row: QueueRow;
  basePath: string;
  query: string;
}) {
  const closed =
    row.phase === "resolved" ||
    (row.stage === "first_review_completed" && row.score !== null);
  if (closed) return queueScoreLabel(row);
  return (
    <Link
      href={
        basePath +
        "/" +
        row.requestId +
        "?from=" +
        encodeURIComponent(query) +
        "&section=assessment#priority"
      }
      aria-label={
        "Open priority estimates for " +
        row.displayId +
        "; RICE score: " +
        (row.score ?? "Not scored")
      }
    >
      {queueScoreLabel(row)}
    </Link>
  );
}

export function queueRiskLabel(risk: QueueRow["risk"]) {
  const status = {
    unassessed: "Not assessed",
    preparing: "Assessment in progress",
    failed: "Assessment failed",
    stale: "Assessment outdated",
  };
  if (risk.status !== "assessed") return status[risk.status];
  if (risk.highestSeverity)
    return (
      risk.highestSeverity[0].toUpperCase() + risk.highestSeverity.slice(1)
    );
  return risk.missingInformation ? "Information missing" : "No active findings";
}

function QueueRisk({ risk }: { risk: QueueRow["risk"] }) {
  return (
    <>
      {queueRiskLabel(risk)}
      {risk.status === "assessed" && risk.missingInformation > 0 && (
        <span className="request-meta">
          Unresolved information gaps: {risk.missingInformation}
        </span>
      )}
    </>
  );
}

function QueuePages({
  page,
  totalPages,
  change,
}: {
  page: number;
  totalPages: number;
  change: (key: string, value: string) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Request list pages" className="actions">
      <Button
        type="button"
        outline
        disabled={page === 1}
        onClick={() => change("page", String(page - 1))}
      >
        Previous page
      </Button>
      <span>{"Page " + page + " of " + totalPages}</span>
      <Button
        type="button"
        outline
        disabled={page === totalPages}
        onClick={() => change("page", String(page + 1))}
      >
        Next page
      </Button>
    </nav>
  );
}

function EmptyQueue({
  reset,
  administrative,
}: {
  reset: () => void;
  administrative: boolean;
}) {
  return (
    <>
      No requests match these filters.{" "}
      <Button type="button" unstyled onClick={reset}>
        {administrative
          ? "Clear filters"
          : "Find requests needing a coordinator"}
      </Button>
    </>
  );
}

function RiceDesignNote() {
  return (
    <DesignNote title="People supply estimates; scores need a shared basis">
      People supply the estimates, and One Door calculates the RICE score.
      Request text alone does not reliably establish Reach, Impact or Effort. A
      request stays unscored until all four estimates are valid and reviewed.
      Request changes invalidate the score until another human review. Compare
      scores using consistent Reach units, periods and scope.
    </DesignNote>
  );
}

function QueueEntry({
  row,
  query,
  actors,
  basePath,
}: {
  row: QueueRow;
  query: string;
  actors: Array<{ id: string; displayName: string }>;
  basePath: string;
}) {
  return (
    <tr id={"request-" + row.requestId}>
      <td>
        <Link
          onClick={(event) => rememberQueueRow(event, row.requestId)}
          href={
            basePath +
            "/" +
            row.requestId +
            "?from=" +
            encodeURIComponent(query)
          }
        >
          {row.title}
        </Link>
        <span className="request-meta">
          {row.displayId}
          {row.fixtureKey && " · Fictional example"}
        </span>
      </td>
      <td>
        {row.requesterName}
        <span className="request-meta">{row.organizationName}</span>
      </td>
      <td>
        <strong>{actionLabels[row.actionNeeded]}</strong>
        <span className="request-meta">{phaseLabels[row.phase]}</span>
      </td>
      <td>
        {actors.find((person) => person.id === row.coordinatorActorId)
          ?.displayName ?? "Unassigned"}
      </td>
      <td data-column="waiting">{row.businessDaysInPhase}</td>
      <td data-column="submitted">
        {new Date(row.createdAt).toLocaleDateString()}
      </td>
      <td>
        <QueueRisk risk={row.risk} />
      </td>
      <td>
        <ScoreLink row={row} basePath={basePath} query={query} />
        {row.score !== null && (
          <span className="request-meta">
            {row.reachUnit} · {row.reachPeriod}
          </span>
        )}
      </td>
    </tr>
  );
}

function rememberQueueRow(event: React.MouseEvent, requestId: string) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  history.replaceState(
    history.state,
    "",
    location.pathname + location.search + "#request-" + requestId,
  );
}

export function queueReviewer(value: string | null, administrative: boolean) {
  if (administrative) return value ?? "all";
  return value === "unassigned" ? "unassigned" : "me";
}

function QueueResults({
  data,
  loading,
  query,
  actors,
  change,
  sort,
  basePath,
  page,
  totalPages,
  administrative,
  reset,
}: {
  data: QueueView | undefined;
  loading: boolean;
  query: string;
  actors: Array<{ id: string; displayName: string }>;
  change: (key: string, value: string) => void;
  sort: SortControl<QueueHeadingKey>;
  basePath: string;
  page: number;
  totalPages: number;
  administrative: boolean;
  reset: () => void;
}) {
  return (
    <>
      <QueueCount
        data={data}
        loading={loading}
        sort={sort}
        administrative={administrative}
        reset={reset}
      />
      <ReachBasisWarning mixed={data?.mixedReachBasis ?? false} />
      <div aria-busy={loading}>
        <QueueTable
          rows={data?.rows ?? []}
          loading={loading}
          query={query}
          actors={actors}
          basePath={basePath}
          sort={sort}
        />
      </div>
      {data && (
        <QueuePages
          page={Math.min(page, totalPages)}
          totalPages={totalPages}
          change={change}
        />
      )}
    </>
  );
}

function QueueCount({
  data,
  loading,
  sort,
  administrative,
  reset,
}: {
  data?: QueueView;
  loading: boolean;
  sort: SortControl<QueueHeadingKey>;
  administrative: boolean;
  reset: () => void;
}) {
  const empty = loading
    ? "Loading requests…"
    : "No request list has loaded yet.";
  const count = data ? "Requests: " + data.total : empty;
  const label =
    queueColumns.find(([key]) => key === sort.state.key)?.[1] ?? sort.state.key;
  return (
    <p role="status">
      {data?.rows.length === 0 && !loading ? (
        <EmptyQueue reset={reset} administrative={administrative} />
      ) : (
        count
      )}
      {" · "}
      <SortSummary state={sort.state} label={label} />
      {data && loading && " · Updating requests…"}
    </p>
  );
}

function AssignmentFilter({
  actors,
  administrative,
  reviewer,
  change,
}: {
  actors: Array<{ id: string; displayName: string }>;
  administrative: boolean;
  reviewer: string;
  change: (key: string, value: string) => void;
}) {
  return (
    <div>
      <Label htmlFor="reviewer-filter">
        {administrative ? "Assigned reviewer" : "Show"}
      </Label>
      <Select
        id="reviewer-filter"
        name="reviewer"
        value={reviewer}
        onChange={(event) => change("reviewer", event.target.value)}
      >
        <option value="me">Assigned to me</option>
        <option value="unassigned">Needs a coordinator</option>
        {administrative && <option value="all">All reviewers</option>}
        {administrative &&
          actors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.displayName}
            </option>
          ))}
      </Select>
    </div>
  );
}
