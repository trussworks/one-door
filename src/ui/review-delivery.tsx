"use client";
import { TableScroll } from "./table-scroll";
import { useState } from "react";
import Link from "next/link";
import { Button, Label, Select, Table } from "@trussworks/react-uswds";
import type { RecordProps } from "./record-form";
import type { RequestView } from "../server/request-views";
import { Field, Problem } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { useRecordForm } from "./record-form";
import { sortRows } from "../domain/sorting";
import { SortableHeader, useSort } from "./sort";
import { useApp } from "./shell";
import {
  externalSystemLabels,
  isSimulatedWork,
  workClosed,
} from "./status-labels";
import { api, errorText } from "./api";
import { useData } from "./use-data";
import type { workItemOptions } from "../server/work-item";

export function workPlan(values: Record<string, string>) {
  return (
    [
      ["requiredWork", "required"],
      ["supportingWork", "supporting"],
    ] as const
  ).flatMap(([key, relationship]) =>
    values[key]
      .split("\n")
      .map((title) => title.trim())
      .filter(Boolean)
      .map((title) => ({ title, relationship })),
  );
}

export function DeliveryProgress({
  data,
  changed,
  own,
}: RecordProps & { own: boolean }) {
  return (
    <section id="delivery">
      <DeliverySummary data={data} changed={changed} own={own} />
      {data.delivery.links.length > 0 && (
        <WorkTable data={data} changed={changed} own={own} />
      )}
      {!own && !data.delivery.resolution && (
        <LinkExistingWork data={data} changed={changed} />
      )}
      {data.delivery.historicalLinks.length > 0 && (
        <details>
          <summary>Earlier work links</summary>
          <p>
            These links belong to an earlier version of the demo request. They
            do not determine current fulfillment.
          </p>
          <ul>
            {data.delivery.historicalLinks.map((item) => (
              <li key={item.requestGeneration + ":" + item.workItemId}>
                <Link href={"/work-items/" + item.workItemId}>
                  {item.externalId}
                </Link>{" "}
                · Demo generation {item.requestGeneration}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!own && !data.delivery.resolution && (
        <ResolveRequest data={data} changed={changed} />
      )}
    </section>
  );
}

function SendHandoff({ data, changed }: RecordProps) {
  const { announce } = useApp();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function send(simulateFailure: boolean) {
    setPending(true);
    setError("");
    try {
      const result = await api<{ status: string }>("/api/review/actions", {
        action: "executeHandoff",
        input: { requestId: data.record.requestId, simulateFailure },
      });
      if (result.status === "confirmed")
        announce(
          "Simulated handoff confirmed. No real external system was contacted.",
        );
      else
        setError(
          "Simulated handoff failed. First review remains complete; retry the handoff.",
        );
      await changed();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      {error && <Problem>{error}</Problem>}
      <div className="actions">
        <Button
          type="button"
          disabled={pending}
          onClick={() => void send(false)}
        >
          Simulate handoff
        </Button>
        <Button
          type="button"
          unstyled
          disabled={pending}
          onClick={() => void send(true)}
        >
          Simulate handoff failure
        </Button>
      </div>
    </div>
  );
}

function LinkExistingWork({ data, changed }: RecordProps) {
  const available =
    useData<Awaited<ReturnType<typeof workItemOptions>>>("/api/work-items");
  const form = useRecordForm({
    data,
    changed,
    pageKey: "link-work",
    initial: { workItemId: "", relationship: "required" },
  });
  const linked = new Set(data.delivery.links.map((item) => item.workItemId));
  return (
    <details className="record-action">
      <summary>Link existing work</summary>
      <p>
        A work item can be linked to more than one request. Required work must
        be closed before this request can be fulfilled; supporting work does not
        block fulfillment.
      </p>
      {Boolean(available.error) && (
        <Problem>{errorText(available.error)}</Problem>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.action(
            "linkWorkItem",
            {
              workItemId: form.work.values.workItemId,
              relationship: form.work.values.relationship,
            },
            "Work item linked.",
          );
        }}
      >
        <fieldset
          className="usa-fieldset"
          disabled={!form.work.ready || form.pending || !available.data}
        >
          <Label htmlFor="linked-work-item">Work item</Label>
          <Select
            id="linked-work-item"
            name="workItemId"
            required
            value={form.work.values.workItemId}
            onChange={(event) =>
              form.work.change("workItemId", event.target.value)
            }
          >
            <option value="">Choose a work item</option>
            {(available.data ?? [])
              .filter((item) => !linked.has(item.workItemId))
              .map((item) => (
                <option key={item.workItemId} value={item.workItemId}>
                  {item.externalId}: {item.title}
                </option>
              ))}
          </Select>
          <Label htmlFor="linked-work-role">Role in fulfillment</Label>
          <Select
            id="linked-work-role"
            name="relationship"
            value={form.work.values.relationship}
            onChange={(event) =>
              form.work.change("relationship", event.target.value)
            }
          >
            <option value="required">Required</option>
            <option value="supporting">Supporting</option>
          </Select>
          <FormMessages form={form} />
          <Button type="submit" disabled={form.stale}>
            Link work item
          </Button>
        </fieldset>
      </form>
    </details>
  );
}

const workColumns = [
  ["item", "Work item"],
  ["required", "Required"],
  ["status", "Source status"],
  ["health", "Source check"],
] as const;

type WorkColumn = (typeof workColumns)[number][0];

function workRowValue(
  item: RequestView["delivery"]["links"][number],
  key: WorkColumn,
): string {
  if (key === "item") return item.externalId;
  if (key === "required")
    return item.relationship === "required" ? "Yes" : "No (supporting)";
  if (key === "status") return item.sourceStatus;
  return item.derivedHealth;
}

function WorkTable({ data, changed, own }: RecordProps & { own: boolean }) {
  const sort = useSort<WorkColumn>({ key: "item", direction: "asc" });
  const links = sortRows(data.delivery.links, sort.state, workRowValue);
  return (
    <TableScroll label="Linked work for fulfillment">
      <Table fullWidth compact bordered={false}>
        <caption>Linked work — local demonstration records</caption>
        <thead>
          <tr>
            {workColumns.map(([key, label]) => (
              <SortableHeader
                key={key}
                sortKey={key}
                label={label}
                sort={sort}
              />
            ))}
            {!own && <th scope="col">Simulate status</th>}
          </tr>
        </thead>
        <tbody>
          {links.map((item) => (
            <tr key={item.workItemId}>
              <td>
                <Link href={"/work-items/" + item.workItemId}>
                  {item.externalId}
                </Link>
                <span className="request-meta">
                  {externalSystemLabels[item.system]}
                </span>
              </td>
              <td>
                {item.relationship === "required" ? "Yes" : "No (supporting)"}
              </td>
              <td>{item.sourceStatus}</td>
              <td>{item.derivedHealth}</td>
              {!own && (
                <td>
                  {!data.delivery.resolution && isSimulatedWork(item) ? (
                    <AdvanceWork item={item} changed={changed} />
                  ) : (
                    "Status cannot be changed here when the request is closed or the record is imported."
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

function AdvanceWork({
  item,
  changed,
}: {
  item: RequestView["delivery"]["links"][number];
  changed: () => void;
}) {
  const { announce } = useApp();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function advance() {
    setPending(true);
    setError("");
    try {
      await api("/api/review/actions", {
        action: "updateWorkItemStatus",
        input: {
          workItemId: item.workItemId,
          sourceStatus: workClosed(item) ? "In progress" : "Closed",
          closed: !workClosed(item),
          syncHealth: "current",
        },
      });
      announce("Simulated status updated for " + item.externalId + ".");
      await changed();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      {error && <Problem>{error}</Problem>}
      <Button
        type="button"
        unstyled
        disabled={pending}
        onClick={() => void advance()}
      >
        {workClosed(item) ? "Simulate reopening" : "Simulate closure"}
      </Button>
    </>
  );
}

const outcomes = {
  fulfilled_reuse: "Fulfilled through reuse",
  fulfilled_new: "Fulfilled through new work",
  fulfilled_mixed: "Fulfilled through reuse and new work",
  closed_without_fulfillment: "Closed without fulfillment",
};

function ResolveRequest({ data, changed }: RecordProps) {
  const form = useRecordForm({
    data,
    changed,
    pageKey: "resolve-request",
    initial: { outcome: "", summary: "", reason: "" },
  });
  return (
    <details className="record-action">
      <summary>Record final outcome</summary>
      <p>
        Check whether the request's success conditions were met. Closed work
        items alone do not establish fulfillment.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.action(
            "resolveRequest",
            {
              outcome: form.work.values.outcome,
              summary: form.work.values.summary,
              ...(form.work.values.reason && {
                reason: form.work.values.reason,
              }),
            },
            "Final outcome recorded. This request is closed; linked work items keep their own status.",
          );
        }}
      >
        <fieldset
          className="usa-fieldset"
          disabled={!form.work.ready || form.pending}
        >
          <Label htmlFor="outcome">Final outcome</Label>
          <Select
            id="outcome"
            name="outcome"
            required
            value={form.work.values.outcome}
            onChange={(event) =>
              form.work.change("outcome", event.target.value)
            }
          >
            <option value="">Choose an outcome</option>
            {Object.entries(outcomes).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
          <Field
            name="summary"
            label="Outcome explanation"
            multiline
            value={form.work.values.summary}
            onChange={(value) => form.work.change("summary", value)}
          />
          <Field
            name="closure-reason"
            label="Reason for closing without fulfillment"
            required={form.work.values.outcome === "closed_without_fulfillment"}
            multiline
            value={form.work.values.reason}
            onChange={(value) => form.work.change("reason", value)}
          />
          <FormMessages form={form} />
          <Button type="submit" disabled={form.stale}>
            Record outcome
          </Button>
        </fieldset>
      </form>
    </details>
  );
}

export function deliveryPlanValues(
  values: Record<string, string>,
  data: RequestView,
) {
  return {
    deliveryOwnerActorId:
      values.deliveryOwnerActorId ?? data.review.deliveryOwnerActorId ?? "",
    nextTask: values.nextTask ?? data.review.nextTask ?? "",
  };
}

export function HandoffFields({
  form,
  data,
}: {
  form: ReturnType<typeof useRecordForm>;
  data: RequestView;
}) {
  const plan = deliveryPlanValues(form.work.values, data);
  const earlierNote = form.work.values.nextOwner || data.review.nextOwner;
  return (
    <>
      {earlierNote && !data.review.deliveryOwnerActorId && (
        <p className="earlier-plan">
          <strong>Earlier handoff note:</strong> {earlierNote}
        </p>
      )}
      <DeliveryOwnerField
        value={plan.deliveryOwnerActorId}
        onChange={(value) => form.work.change("deliveryOwnerActorId", value)}
      />
      <Field
        name="nextTask"
        label="Next delivery task"
        multiline
        maxLength={2000}
        value={plan.nextTask}
        onChange={(value) => form.work.change("nextTask", value)}
        hint="State what needs to be done and how completion will be recognized."
      />
      <p className="muted">
        This delivery plan is a draft until you complete the review.
      </p>
      <Label htmlFor="target-system">Simulated work system</Label>
      <Select
        id="target-system"
        name="system"
        value={form.work.values.system}
        onChange={(event) => form.work.change("system", event.target.value)}
      >
        {Object.entries(externalSystemLabels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <Field
        name="requiredWork"
        label="Required work (optional, one item per line)"
        multiline
        required={false}
        value={form.work.values.requiredWork}
        onChange={(value) => form.work.change("requiredWork", value)}
        hint="Each listed item must be closed before fulfillment can be recorded. Leave blank if no required work is needed."
      />
      <Field
        name="supportingWork"
        label="Supporting work (optional, one item per line)"
        multiline
        required={false}
        value={form.work.values.supportingWork}
        onChange={(value) => form.work.change("supportingWork", value)}
      />
    </>
  );
}

function DeliveryOwnerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { metadata } = useApp();
  return (
    <div className="field">
      <Label htmlFor="delivery-owner">Delivery lead</Label>
      <p className="usa-hint" id="delivery-owner-hint">
        Choose the person responsible for carrying the next delivery task
        forward.
      </p>
      <Select
        id="delivery-owner"
        name="deliveryOwnerActorId"
        required
        aria-describedby="delivery-owner-hint"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a delivery lead</option>
        {metadata.actors
          .filter(
            (actor) =>
              actor.kind === "persona" ||
              actor.id === metadata.visitor.actorId ||
              actor.id === value,
          )
          .map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.id === metadata.visitor.actorId
                ? actor.displayName + " (you)"
                : actor.displayName}
            </option>
          ))}
      </Select>
    </div>
  );
}

function DeliverySummary({
  data,
  changed,
  own,
}: RecordProps & { own: boolean }) {
  return (
    <>
      <h2>Delivery and outcome</h2>
      {data.delivery.resolution ? (
        <>
          <p>
            <strong>{outcomes[data.delivery.resolution.outcome]}</strong>
          </p>
          <p>{data.delivery.resolution.summary}</p>
          {data.delivery.resolution.reason && (
            <p>{data.delivery.resolution.reason}</p>
          )}
        </>
      ) : (
        <>
          {!data.delivery.handoff && (
            <p>No delivery handoff has been planned.</p>
          )}
          {data.delivery.handoff && (
            <p>
              Handoff status: {data.delivery.handoff.status} · Next task owner:{" "}
              {data.delivery.handoff.nextOwner}
            </p>
          )}
          {!own &&
            data.delivery.handoff &&
            data.delivery.handoff.status !== "confirmed" && (
              <SendHandoff data={data} changed={changed} />
            )}
        </>
      )}
    </>
  );
}
