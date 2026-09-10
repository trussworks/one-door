"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";

export interface ReadController {
  mounted: boolean;
  requested: number;
  handled: number;
  pending: Promise<void> | null;
  abort: AbortController | null;
}

type ReadAttempt<T> = { data: T } | { failure: unknown };
export interface ReadResult<T> {
  path: string | null;
  data?: T;
  error?: unknown;
  loading?: boolean;
}

// Only list callers retain results across query changes, never across resource paths.
function retainResult<T>(
  previous: ReadResult<T>,
  path: string,
  retainPrevious: boolean,
) {
  return previous.path === path ||
    (retainPrevious && previous.path?.split("?")[0] === path.split("?")[0])
    ? previous.data
    : undefined;
}

async function attemptRead<T>(
  path: string,
  signal: AbortSignal,
): Promise<ReadAttempt<T>> {
  try {
    return { data: await api<T>(path, undefined, signal) };
  } catch (failure) {
    return { failure };
  }
}

export async function readUntilCurrent<T>(
  controller: ReadController,
  path: string,
  setResult: React.Dispatch<React.SetStateAction<ReadResult<T>>>,
  retainPrevious: boolean,
) {
  while (controller.mounted && controller.handled < controller.requested) {
    const answering = controller.requested;
    const abort = new AbortController();
    controller.abort = abort;
    setResult((previous) => ({
      path,
      data: retainResult(previous, path, retainPrevious),
      loading: true,
    }));
    const attempt = await attemptRead<T>(path, abort.signal);
    if (controller.mounted && !abort.signal.aborted)
      setResult((previous) =>
        "data" in attempt
          ? { path, data: attempt.data, loading: false }
          : {
              path,
              data: retainResult(previous, path, retainPrevious),
              error: attempt.failure,
              loading: false,
            },
      );
    // Only the count taken before the read is handled: a refresh asked for
    // while the read was in flight still runs the loop again.
    controller.handled = answering;
  }
}

export function useData<T>(
  path: string | null,
  { retainPrevious = false }: { retainPrevious?: boolean } = {},
) {
  const controller = useMemo<ReadController>(
    () => ({
      mounted: true,
      requested: 0,
      handled: 0,
      pending: null,
      abort: null,
    }),
    [path],
  );
  const [result, setResult] = useState<ReadResult<T>>({ path: null });
  const refresh = useCallback(() => {
    if (!path || !controller.mounted) return Promise.resolve();
    controller.requested += 1;
    if (!controller.pending) {
      const pending = readUntilCurrent(
        controller,
        path,
        setResult,
        retainPrevious,
      ).finally(() => {
        if (controller.pending === pending) controller.pending = null;
      });
      controller.pending = pending;
    }
    return controller.pending;
  }, [controller, path, retainPrevious]);
  useEffect(() => {
    controller.mounted = true;
    void refresh();
    return () => {
      controller.mounted = false;
      controller.abort?.abort();
    };
  }, [controller, refresh]);
  return {
    data: path ? retainResult(result, path, retainPrevious) : undefined,
    error: result.path === path ? result.error : undefined,
    loading: result.path === path ? Boolean(result.loading) : Boolean(path),
    refresh,
  };
}
