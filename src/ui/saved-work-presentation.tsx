"use client";

import { Button } from "@trussworks/react-uswds";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorText } from "./api";
import type { useRecordForm } from "./record-form";
import { Problem } from "./fields";
import type { SavedWorkStatus, useSavedWork } from "./use-saved-work";

export function SaveStatus({
  status,
  retry,
  replace,
}: {
  status: SavedWorkStatus;
  retry: () => void;
  replace?: () => void;
}) {
  return (
    <p className="save-status" role="status">
      {status.message}
      {status.kind === "failed" && (
        <Button type="button" unstyled onClick={retry}>
          Retry draft save
        </Button>
      )}
      {status.kind === "conflict" && replace && (
        <Button type="button" unstyled onClick={replace}>
          Replace newer server draft with my entries
        </Button>
      )}
    </p>
  );
}

export function needsSaveAttention(status: SavedWorkStatus): boolean {
  return status.kind === "failed" || status.kind === "conflict";
}

export function SaveAndExit({
  flush,
  disabled = false,
}: {
  flush: () => Promise<void>;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function leave() {
    setPending(true);
    setError("");
    try {
      await flush();
      router.push("/my");
    } catch (caught) {
      setError(errorText(caught));
      setPending(false);
    }
  }
  return (
    <>
      <Button
        type="button"
        outline
        disabled={disabled || pending}
        onClick={() => void leave()}
      >
        {pending
          ? "Saving draft before leaving…"
          : "Save draft and return to my requests"}
      </Button>
      {error && <Problem>{error}</Problem>}
    </>
  );
}

export function SavedWorkFooter({
  work,
  onError,
}: {
  work: ReturnType<typeof useSavedWork>;
  onError: (message: string) => void;
}) {
  return (
    <SaveStatus
      status={work.status}
      retry={() =>
        void work.flush().catch((error) => onError(errorText(error)))
      }
      replace={() =>
        void work
          .overwriteWithLatestBase()
          .catch((error) => onError(errorText(error)))
      }
    />
  );
}

export function FormMessages({
  form,
  subject = "request",
  showSaveStatus = true,
}: {
  form: Pick<
    ReturnType<typeof useRecordForm>,
    "work" | "error" | "stale" | "acknowledge"
  >;
  subject?: string;
  showSaveStatus?: boolean;
}) {
  return (
    <>
      {form.error && <Problem>{form.error}</Problem>}
      {form.stale && (
        <Problem>
          {"The " +
            subject +
            " has changed. Review the current version before keeping your entries."}
          <Button type="button" unstyled onClick={form.acknowledge}>
            Keep entries after reviewing the latest version
          </Button>
        </Problem>
      )}
      {(showSaveStatus || needsSaveAttention(form.work.status)) && (
        <SaveStatus
          status={form.work.status}
          retry={() => void form.work.flush().catch(() => {})}
          replace={() =>
            void form.work.overwriteWithLatestBase().catch(() => {})
          }
        />
      )}
    </>
  );
}
