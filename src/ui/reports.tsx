"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Label, Select, Table } from "@trussworks/react-uswds";
import type {
  ReportMetrics,
  ReportView,
  SatisfactionRecord,
} from "../server/reports";
import { sortRows } from "../domain/sorting";
import { SortableHeader, useSort } from "./sort";
import { useData } from "./use-data";
import { Field, Problem, DesignNote, RefreshStatus } from "./fields";
import { errorText } from "./api";
import styles from "./reports.module.css";
import tableStyles from "./table-scroll.module.css";
import { TableScroll } from "./table-scroll";

type RequestIndex = Array<{
  requestId: string;
  displayId: string;
  title: string;
}>;
export function percent(value: number | null) {
  return value === null
    ? "No measurement yet"
    : new Intl.NumberFormat("en-US", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);
}

export function Reports() {
  const query = useSearchParams();
  const router = useRouter();
  const metric = query.get("metric");
  const filters = new URLSearchParams(query);
  filters.delete("metric");
  const source = useData<ReportView>("/api/reports?" + filters, {
    retainPrevious: true,
  });
  const index = useData<RequestIndex>("/api/request-index");
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace("/reports?" + next, { scroll: false });
  };
  return (
    <>
      <h1>Reports</h1>
      <p>
        See the records behind each measure. Demo interactions are not a study
        of Colorado users or evidence of comparative delivery performance.
      </p>
      <ReportFilters query={query} change={change} />
      <RefreshStatus loading={source.loading && Boolean(source.data)} />
      {source.error && <Problem>{errorText(source.error)}</Problem>}
      {!source.data && !source.error && (
        <p role="status">Calculating the report…</p>
      )}
      {source.data && (
        <>
          <MetricTable
            report={source.data.report}
            inspect={(value) => change("metric", value)}
          />
          {metric && (
            <MetricRecords
              report={source.data.report}
              metric={metric}
              index={index.data ?? []}
              back={"/reports?" + query}
            />
          )}
          <ModelUsage data={source.data} />
          <DesignNote title="Measurement · Keep the definitions beside the figures">
            Live submission and first-review ratings are separate. A rating of 4
            or 5 counts as satisfied. Seeded responses are excluded from live
            satisfaction, and a fixture reset never removes an already recorded
            live response.
          </DesignNote>
        </>
      )}
    </>
  );
}

function ReportFilters({
  query,
  change,
}: {
  query: Pick<URLSearchParams, "get">;
  change: (key: string, value: string) => void;
}) {
  return (
    <div className="queue-filters">
      <div>
        <Label htmlFor="report-dataset">Report data</Label>
        <Select
          id="report-dataset"
          name="dataset"
          value={query.get("dataset") ?? "live"}
          onChange={(event) => change("dataset", event.target.value)}
        >
          <option value="live">Live demo activity</option>
          <option value="seed">Seeded examples</option>
        </Select>
      </div>
      <Field
        name="report-from"
        label="From (UTC date)"
        type="date"
        required={false}
        value={query.get("from") ?? ""}
        onChange={(value) => change("from", value)}
      />
      <Field
        name="report-to"
        label="Through (inclusive UTC date)"
        type="date"
        required={false}
        value={query.get("to") ?? ""}
        onChange={(value) => change("to", value)}
      />
    </div>
  );
}

function MetricTable({
  report,
  inspect,
}: {
  report: ReportMetrics;
  inspect: (metric: MetricKey) => void;
}) {
  const sort = useSort({ key: "measure", direction: "asc" });
  const metrics = sortRows(metricRows(report), sort.state, (row) => row.label);
  return (
    <TableScroll
      label="Measures and definitions"
      className={tableStyles.naturalWidth}
    >
      <Table fullWidth compact bordered={false}>
        <caption>
          Measures and definitions ·{" "}
          {report.dataset === "live" ? "Live demo activity" : "Seeded examples"}
        </caption>
        <thead>
          <tr>
            <SortableHeader sortKey="measure" label="Measure" sort={sort} />
            <th scope="col">Result</th>
            <th scope="col">Definition and sample</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map(({ key, label, value, basis }) => (
            <tr key={key}>
              <th scope="row">
                <Button type="button" unstyled onClick={() => inspect(key)}>
                  {label}
                </Button>
              </th>
              <td className={styles.metricValue}>{value}</td>
              <td>{basis}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

function metricIds(report: ReportMetrics, metric: string) {
  const ids: Record<string, string[]> = {
    reuse: report.reuse.fulfilledRequestIds,
    fulfilled: report.volume.fulfilled.requestIds,
    submissions: report.volume.submissions.requestIds,
    reviews: report.volume.firstReviewsCompleted.requestIds,
    closed: report.closures.requestIds,
    "first-review": report.timeToFirstReview.records.map(
      (row) => row.requestId,
    ),
  } satisfies Partial<Record<MetricKey, string[]>>;
  return ids[metric] ?? [];
}

export function MetricRecords({
  report,
  metric,
  index,
  back,
}: {
  report: ReportMetrics;
  metric: string;
  index: RequestIndex;
  back: string;
}) {
  if (metric === "requester" || metric === "reviewer")
    return (
      <SurveyRecords
        rows={
          metric === "requester"
            ? report.requesterSatisfaction.records
            : report.reviewerSatisfaction.records
        }
        index={index}
        back={back}
      />
    );
  const ids = metricIds(report, metric);
  return (
    <section className={styles.metricDetails} id="metric-records" tabIndex={-1}>
      <h2>Requests included in this measure</h2>
      {ids.length ? (
        <ul>
          {ids.map((id) => (
            <li key={id}>
              <RequestReference id={id} index={index} back={back} />
            </li>
          ))}
        </ul>
      ) : (
        <p>No records match this measure and date range.</p>
      )}
    </section>
  );
}

function RequestReference({
  id,
  index,
  back,
}: {
  id: string;
  index: RequestIndex;
  back: string;
}) {
  const row = index.find((item) => item.requestId === id);
  return (
    <Link href={"/admin/requests/" + id + "?back=" + encodeURIComponent(back)}>
      {row ? row.displayId + ": " + row.title : "Open contributing request"}
    </Link>
  );
}

const surveyColumns = [
  ["request", "Request"],
  ["rating", "Rating"],
  ["recorded", "Recorded at"],
  ["response", "Response ID"],
] as const;

type SurveyColumn = (typeof surveyColumns)[number][0];

function SurveyRecords({
  rows,
  index,
  back,
}: {
  rows: SatisfactionRecord[];
  index: RequestIndex;
  back: string;
}) {
  const sort = useSort<SurveyColumn>({ key: "recorded", direction: "desc" });
  const sorted = sortRows(rows, sort.state, (row, key) => {
    if (key === "request")
      return (
        index.find((item) => item.requestId === row.requestId)?.displayId ??
        null
      );
    if (key === "rating") return row.rating;
    if (key === "recorded") return row.completedAt;
    return row.completionId;
  });
  return (
    <section className={styles.metricDetails} id="metric-records" tabIndex={-1}>
      <h2>Recorded responses</h2>
      <p>
        Each row is one response. Earlier responses remain after an example
        request is reset.
      </p>
      {rows.length ? (
        <TableScroll
          label="Satisfaction responses"
          className={tableStyles.naturalWidth}
        >
          <Table fullWidth compact bordered={false}>
            <caption>
              Responses included in the selected satisfaction measure
            </caption>
            <thead>
              <tr>
                {surveyColumns.map(([key, label]) => (
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
              {sorted.map((row) => (
                <tr key={row.completionId}>
                  <td>
                    <RequestReference
                      id={row.requestId}
                      index={index}
                      back={back}
                    />
                  </td>
                  <td>{row.rating} / 5</td>
                  <td>{new Date(row.completedAt).toLocaleString()}</td>
                  <td>{row.completionId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      ) : (
        <p>No responses are recorded for these dates.</p>
      )}
    </section>
  );
}

function ModelUsage({ data }: { data: ReportView }) {
  const money = (micros: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(micros / 1000000);
  return (
    <section id="model-usage">
      <h2>Model usage</h2>
      <p>
        Global monthly usage: {money(data.quota.monthlySpend.used)} of{" "}
        {money(data.quota.monthlySpend.cap)}. Unresolved call reservations stay
        counted until usage is known.
      </p>
      <p>
        Today: {data.quota.globalDaily.used} of {data.quota.globalDaily.cap}{" "}
        global calls; {data.quota.visitorDaily.used} of{" "}
        {data.quota.visitorDaily.cap} for your browser session.
      </p>
    </section>
  );
}

type MetricKey =
  | "requester"
  | "reviewer"
  | "reuse"
  | "first-review"
  | "submissions"
  | "reviews"
  | "fulfilled"
  | "closed";

interface MetricRow {
  key: MetricKey;
  label: string;
  value: string;
  basis: string;
}

function metricRows(report: ReportMetrics): MetricRow[] {
  const requester = report.requesterSatisfaction,
    reviewer = report.reviewerSatisfaction;
  return [
    {
      key: "requester",
      label: "Requester satisfaction",
      value: percent(requester.rate),
      basis: `${requester.satisfied} of ${requester.responses} submission ratings were 4 or 5. Pilot target: 90%.`,
    },
    {
      key: "reviewer",
      label: "Reviewer satisfaction",
      value: percent(reviewer.rate),
      basis: `${reviewer.satisfied} of ${reviewer.responses} first-review ratings were 4 or 5.`,
    },
    {
      key: "reuse",
      label: "Fulfilled through reuse only",
      value: percent(report.reuse.reuseRate),
      basis: `${report.reuse.reuseOnly} of ${report.reuse.fulfilledTotal} fulfilled requests. Mixed: ${report.reuse.mixed}; new work: ${report.reuse.newWork}. Accepting a match is not fulfillment.`,
    },
    {
      key: "first-review",
      label: "Median time to first human review",
      value:
        report.timeToFirstReview.medianSeconds === null
          ? "No measurement yet"
          : (report.timeToFirstReview.medianSeconds / 3600).toFixed(1) +
            " hours",
      basis: `${report.timeToFirstReview.sampleCount} requests: submission to the first saved human review decision; grouped by that decision’s date.`,
    },
    {
      key: "submissions",
      label: "Requests submitted",
      value: String(report.volume.submissions.count),
      basis: "Counted by submission date.",
    },
    {
      key: "reviews",
      label: "First reviews completed",
      value: String(report.volume.firstReviewsCompleted.count),
      basis: "Counted by first-review completion date; not a delivery outcome.",
    },
    {
      key: "fulfilled",
      label: "Requests fulfilled",
      value: String(report.volume.fulfilled.count),
      basis: "A coordinator recorded fulfillment, counted by resolution date.",
    },
    {
      key: "closed",
      label: "Closed without fulfillment",
      value: String(report.volume.closedWithoutFulfillment.count),
      basis: "Separate from fulfilled requests, counted by closure date.",
    },
  ];
}
