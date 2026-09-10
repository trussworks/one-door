"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  changeSavedWork,
  createController,
  loadSaved,
  queueSave,
  refreshUnchangedTokens,
  savedWorkStatus,
  type Saved,
  type Scope,
} from "./saved-work-controller";

export { sameEditableValues } from "./saved-work-controller";
export type { SavedWorkKind, SavedWorkStatus } from "./saved-work-controller";
type Values = Record<string, string>;

export function useSavedWork(scope: Scope, initial: Values) {
  const key = JSON.stringify(scope);
  const initialJson = JSON.stringify(initial);
  const controller = useMemo(() => createController(initial), [key]);
  const [rendered, setRendered] = useState(initial);
  const [status, setStatus] = useState(savedWorkStatus.loading);
  const flush = useCallback(
    () => queueSave(controller, key, setStatus),
    [controller, key],
  );

  useEffect(() => {
    controller.mounted = true;
    const loadId = ++controller.loadId;
    void loadSaved(controller, key, initial, loadId)
      .then((loaded) => {
        if (!controller.mounted || loaded === null) return;
        setRendered({ ...controller.values });
        setStatus(loaded);
      })
      .catch(() => {
        if (controller.mounted && controller.loadId === loadId)
          setStatus(savedWorkStatus.loadFailed);
      });
    const leaving = (event: BeforeUnloadEvent) => {
      if (controller.sequence !== controller.savedSequence) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => {
      controller.mounted = false;
      window.removeEventListener("beforeunload", leaving);
      if (controller.timer) clearTimeout(controller.timer);
      void flush().catch(() => {});
    };
  }, [controller, key]);

  useEffect(() => {
    const latest = JSON.parse(initialJson) as Values;
    // Refresh concurrency tokens only when the editable values already match
    // the current record. Actual unfinished edits must still be reviewed.
    if (refreshUnchangedTokens(controller, latest, key))
      setRendered({ ...controller.values });
  }, [controller, controller.ready, initialJson, key]);

  function change(name: string, value: string) {
    if (!controller.ready) return;
    refreshUnchangedTokens(controller, initial, key);
    changeSavedWork(controller, key, {
      name,
      value,
      route: location.pathname + location.search,
    });
    setRendered({ ...controller.values });
    setStatus(savedWorkStatus.queued);
    if (controller.timer) clearTimeout(controller.timer);
    controller.timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 450);
  }

  async function overwriteWithLatestBase() {
    const { actingView, pageKey, subjectKey } = scope;
    const saved = await api<Saved | null>(
      "/api/wip?" + new URLSearchParams({ actingView, pageKey, subjectKey }),
    );
    controller.rowVersion = saved?.rowVersion ?? 0;
    await flush();
  }
  return {
    values: controller.ready ? rendered : initial,
    ready: controller.ready,
    status,
    change,
    flush,
    overwriteWithLatestBase,
  };
}
