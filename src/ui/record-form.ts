"use client";
import { createContext, useContext, useState } from "react";
import type { RequestView } from "../server/request-views";
import { api, ApiError, errorText } from "./api";
import { useApp } from "./shell";
import { useSavedWork } from "./use-saved-work";

/** Every record screen reads one request and reports when it changed. */
export interface RecordProps {
  data: RequestView;
  changed: () => void;
}

export const RecordMutationContext = createContext<{
  busy: React.RefObject<boolean>;
  setBusy: (value: boolean) => void;
} | null>(null);

function useRecordCoordination() {
  const context = useContext(RecordMutationContext);
  if (!context) throw new Error("Record actions require their record context");
  return context;
}

type RecordFormOptions = {
  data: RequestView;
  pageKey: string;
  initial: Record<string, string>;
  changed: () => void | Promise<void>;
  own?: boolean;
};

export function useRecordForm({
  data,
  pageKey,
  initial,
  changed,
  own = false,
}: RecordFormOptions) {
  const { metadata, announce } = useApp();
  const coordination = useRecordCoordination();
  const work = useSavedWork(
    {
      visitorId: metadata.visitor.visitorId,
      actingView: own ? "requester" : "contributor",
      pageKey,
      subjectKey: data.record.requestId,
    },
    { ...initial, _recordVersion: String(data.record.rowVersion) },
  );
  const [error, setError] = useState("");
  const stale = Number(work.values._recordVersion) < data.record.rowVersion;
  async function send(
    path: string,
    input: Record<string, unknown>,
    message: string,
    onRecorded?: () => void | Promise<void>,
  ) {
    if (!work.ready) {
      setError(work.status.message);
      return false;
    }
    if (coordination.busy.current) return false;
    coordination.setBusy(true);
    setError("");
    try {
      await work.flush();
      const result = await api<{ rowVersion?: number }>(path, input);
      const draftProblem = await recordedPhase(work, result, onRecorded);
      await changed();
      announce(data.record.displayId + ": " + message + draftProblem);
      return true;
    } catch (caught) {
      setError(errorText(caught));
      if (caught instanceof ApiError && caught.code === "VERSION_CONFLICT")
        changed();
      return false;
    } finally {
      coordination.setBusy(false);
    }
  }
  const base = {
    requestId: data.record.requestId,
    expectedRowVersion: Number(work.values._recordVersion),
  };
  function action(
    name: string,
    input: Record<string, unknown>,
    message: string,
    onRecorded?: () => void | Promise<void>,
  ) {
    return send(
      "/api/review/actions",
      { action: name, input: { ...base, ...input } },
      message,
      onRecorded,
    );
  }
  return {
    work,
    error,
    pending: coordination.busy.current,
    stale,
    send,
    action,
    base,
    acknowledge: () =>
      work.change("_recordVersion", String(data.record.rowVersion)),
  };
}

/* The domain change is committed before this phase runs. Draft
 * bookkeeping — the version stamp, the caller's owned-field cleanup, and
 * the WIP flush that acknowledges both — completes before the refresh and
 * the announcement so no local backup is left unacknowledged. A failure
 * here never presents the recorded action as failed: the caller still
 * refreshes and announces the recorded change plus the draft problem. */
async function recordedPhase(
  work: ReturnType<typeof useSavedWork>,
  result: { rowVersion?: number },
  onRecorded?: () => void | Promise<void>,
): Promise<string> {
  try {
    if (result.rowVersion)
      work.change("_recordVersion", String(result.rowVersion));
    if (onRecorded) await onRecorded();
    await work.flush();
    return "";
  } catch {
    return " The draft update could not be confirmed. Check the recorded result before submitting again.";
  }
}

export function firstReviewOpen(data: RequestView): boolean {
  return (
    !data.delivery.resolution && data.record.stage !== "first_review_completed"
  );
}
