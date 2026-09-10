"use client";
import { useState } from "react";
import { Button, Label, Select } from "@trussworks/react-uswds";
import type { WorkItemView } from "../server/work-item";
import { isSimulatedWork, workClosed } from "./status-labels";
import { api, errorText } from "./api";
import { useApp } from "./shell";
import { useSavedWork } from "./use-saved-work";
import { Problem } from "./fields";
import { SavedWorkFooter } from "./saved-work-presentation";

function useSimulatedWorkStatus({
  item,
  refresh,
}: {
  item: WorkItemView["item"];
  refresh: () => Promise<void>;
}) {
  const { metadata, announce } = useApp();
  const work = useSavedWork(
    {
      visitorId: metadata.visitor.visitorId,
      actingView: "administrator",
      pageKey: "work-item-status",
      subjectKey: item.id,
    },
    { status: item.sourceStatus, health: item.derivedHealth },
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function apply(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await work.flush();
      const result = await api<{ syncHealth: string }>("/api/admin/actions", {
        action: "updateWorkItemStatus",
        input: {
          workItemId: item.id,
          sourceStatus: work.values.status,
          closed:
            work.values.status === item.sourceStatus
              ? workClosed(item)
              : work.values.status === "Closed",
          syncHealth: work.values.health,
        },
      });
      await refresh();
      announce(
        result.syncHealth === "current"
          ? "The simulated source update was recorded."
          : "The unsuccessful source check was recorded. Last-known status and synchronization time were retained.",
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }
  return { work, error, pending, apply, setError };
}

export function WorkStatusEditor(props: {
  item: WorkItemView["item"];
  refresh: () => Promise<void>;
}) {
  const { item } = props;
  const { work, error, pending, apply, setError } =
    useSimulatedWorkStatus(props);
  if (!isSimulatedWork(item)) return null;
  const statuses = [
    ...new Set([item.sourceStatus, "Open", "In progress", "Blocked", "Closed"]),
  ];
  return (
    <details>
      <summary>Simulate a source update</summary>
      <p>
        This changes shared fictional source data and can affect every linked
        request. No real delivery system is contacted. A failed or stale check
        keeps the last-known status.
      </p>
      {error && <Problem>{error}</Problem>}
      <form onSubmit={(event) => void apply(event)}>
        <fieldset className="usa-fieldset" disabled={!work.ready || pending}>
          <Label htmlFor="simulated-health">Source check result</Label>
          <Select
            id="simulated-health"
            name="health"
            value={work.values.health}
            onChange={(event) => work.change("health", event.target.value)}
          >
            <option value="current">A current update is available</option>
            <option value="stale">The source is overdue</option>
            <option value="failed">The source check failed</option>
          </Select>
          <Label htmlFor="simulated-status">Reported work status</Label>
          <Select
            id="simulated-status"
            name="status"
            disabled={work.values.health !== "current"}
            value={work.values.status}
            onChange={(event) => work.change("status", event.target.value)}
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
          <SavedWorkFooter work={work} onError={setError} />
          <Button type="submit">Apply simulated update</Button>
        </fieldset>
      </form>
    </details>
  );
}
