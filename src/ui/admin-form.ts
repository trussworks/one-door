"use client";
import { useState } from "react";
import { api, ApiError, errorText } from "./api";
import { useSavedWork } from "./use-saved-work";
import { useApp } from "./shell";

export function useAdminForm({
  pageKey,
  subjectKey,
  initial,
  rowVersion,
  changed,
}: {
  pageKey: string;
  subjectKey: string;
  initial: Record<string, string>;
  rowVersion: number;
  changed: () => void | Promise<void>;
}) {
  const { metadata, announce } = useApp();
  const work = useSavedWork(
    {
      visitorId: metadata.visitor.visitorId,
      actingView: "administrator",
      pageKey,
      subjectKey,
    },
    { ...initial, _recordVersion: String(rowVersion) },
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const stale = Number(work.values._recordVersion) < rowVersion;
  async function action(
    name: string,
    input: Record<string, unknown>,
    message: string,
  ) {
    setPending(true);
    setError("");
    try {
      await work.flush();
      const result = await api<{
        rowVersion?: number;
        catalogItemId?: string;
        sourceId?: string;
      }>("/api/admin/actions", {
        action: name,
        input: {
          expectedRowVersion: Number(work.values._recordVersion),
          ...input,
        },
      });
      if (result.rowVersion)
        work.change("_recordVersion", String(result.rowVersion));
      void work.flush().catch(() => {});
      await changed();
      if (message) announce(message);
      return result;
    } catch (caught) {
      setError(errorText(caught));
      if (caught instanceof ApiError && caught.code === "VERSION_CONFLICT")
        changed();
      return null;
    } finally {
      setPending(false);
    }
  }
  return {
    work,
    error,
    pending,
    stale,
    action,
    acknowledge: () => work.change("_recordVersion", String(rowVersion)),
  };
}
