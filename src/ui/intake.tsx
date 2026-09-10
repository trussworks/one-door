"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Label, Select } from "@trussworks/react-uswds";
import { api, errorText } from "./api";
import { useApp } from "./shell";
import { useSavedWork } from "./use-saved-work";
import { DesignNote, Field, Problem } from "./fields";
import { SavedWorkFooter, SaveAndExit } from "./saved-work-presentation";
import { RequesterWorkspace } from "./requester-workspace";
import type { getOwnDraft } from "../workflow/requester";
import styles from "./requester.module.css";

export function NewRequest() {
  const search = useSearchParams();
  const router = useRouter();
  const draftId = search.get("draft");
  const start = search.get("start");
  const parent = search.get("parent");
  useEffect(() => {
    if (draftId || start) return;
    const query = new URLSearchParams({ start: crypto.randomUUID() });
    if (parent) query.set("parent", parent);
    router.replace("/new?" + query);
  }, [draftId, start, parent, router]);
  if (draftId) return <RequesterWorkspace key={draftId} draftId={draftId} />;
  return start ? (
    <StartRequest key={start} start={start} parentId={parent} />
  ) : (
    <p role="status">Starting your draft…</p>
  );
}

function StartRequest({
  start,
  parentId,
}: {
  start: string;
  parentId: string | null;
}) {
  const { metadata } = useApp();
  const router = useRouter();
  const work = useSavedWork(
    {
      visitorId: metadata.visitor.visitorId,
      actingView: "requester",
      pageKey: "start-request",
      subjectKey: start,
    },
    {
      rawNeed: "",
      organizationId: "",
      draftId: "",
      parentRequestId: parentId ?? "",
    },
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (work.ready && work.values.draftId && !pending && !error)
      router.replace("/new?draft=" + work.values.draftId);
  }, [work.ready, work.values.draftId, pending, error, router]);
  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const draftId = await startAssistance(work, start);
      router.replace("/new?draft=" + draftId);
    } catch (caught) {
      setError(errorText(caught));
      setPending(false);
    }
  }
  return (
    <IntakeDescriptionForm
      work={work}
      pending={pending}
      error={error}
      prepare={prepare}
      setError={setError}
    />
  );
}

function IntakeDescriptionForm({
  work,
  pending,
  error,
  prepare,
  setError,
}: {
  work: ReturnType<typeof useSavedWork>;
  pending: boolean;
  error: string;
  prepare: (event: React.FormEvent) => Promise<void>;
  setError: (message: string) => void;
}) {
  return (
    <div className={styles.requesterWorkspace}>
      <p className="breadcrumb">
        <Link href="/my">My requests</Link> / New request
      </p>
      <h1>Describe what you need</h1>
      <p>
        Describe the work you need help with. We’ll ask a few useful questions,
        then you can check and send your request to OIT.
      </p>
      {work.values.parentRequestId && (
        <p>
          This is a follow-up request.{" "}
          <Link href={"/request/" + work.values.parentRequestId}>
            View the earlier request
          </Link>
          .
        </p>
      )}
      {error && <Problem>{error}</Problem>}
      <form
        className={styles.intakeForm}
        onSubmit={(event) => void prepare(event)}
      >
        <fieldset className="usa-fieldset" disabled={!work.ready || pending}>
          <Field
            name="rawNeed"
            maxLength={5000}
            label="What do you need to accomplish?"
            multiline
            value={work.values.rawNeed}
            onChange={(value) => work.change("rawNeed", value)}
            hint="Describe who needs help, what happens today, and what would make the work easier"
          />
          <OrganizationField work={work} />
          <div className="actions">
            <Button type="submit">
              {pending ? "Saving your description…" : "Submit"}
            </Button>
            <SaveAndExit flush={work.flush} disabled={!work.ready || pending} />
          </div>
        </fieldset>
        <SavedWorkFooter work={work} onError={setError} />
      </form>
      {error && work.values.draftId && (
        <p>
          Your description is saved.{" "}
          <Link href={"/new?draft=" + work.values.draftId}>
            Open the draft to review and send it without assistance
          </Link>
          .
        </p>
      )}
      <DesignNote title="Intake · Understand the need first">
        The requester describes the work and its constraints. OIT evaluates
        services and technology; the requester does not need to choose an
        architecture.
      </DesignNote>
    </div>
  );
}

async function startAssistance(
  work: ReturnType<typeof useSavedWork>,
  creationKey: string,
) {
  await work.flush();
  const draft = await saveStartDraft(work.values, creationKey);
  work.change("draftId", draft.draftId);
  await work.flush();
  await api("/api/intake-workspace", {
    action: "prepare",
    input: { draftId: draft.draftId, expectedRowVersion: draft.rowVersion },
  });
  return draft.draftId;
}

export async function saveStartDraft(
  values: Record<string, string>,
  creationKey: string,
) {
  type Draft = Awaited<ReturnType<typeof getOwnDraft>>;
  const prior = values.draftId
    ? await api<Draft>("/api/drafts/" + values.draftId)
    : null;
  if (
    prior &&
    prior.rawNeed === values.rawNeed &&
    prior.organizationId === values.organizationId
  )
    return prior;
  return api<Draft>("/api/drafts", {
    ...(prior
      ? { draftId: prior.draftId, expectedRowVersion: prior.rowVersion }
      : {
          creationKey,
          ...(values.parentRequestId && {
            parentRequestId: values.parentRequestId,
          }),
        }),
    organizationId: values.organizationId,
    rawNeed: values.rawNeed,
  });
}

function OrganizationField({
  work,
}: {
  work: ReturnType<typeof useSavedWork>;
}) {
  const { metadata } = useApp();
  return (
    <>
      {" "}
      <Label htmlFor="organizationId">Requesting agency or office</Label>
      <Select
        id="organizationId"
        name="organizationId"
        required
        value={work.values.organizationId}
        onChange={(event) => work.change("organizationId", event.target.value)}
      >
        <option value="">Choose an agency or office</option>
        {metadata.organizations
          .filter((office) => office.kind !== "team")
          .map((office) => (
            <option key={office.id} value={office.id}>
              {office.name}
            </option>
          ))}
      </Select>
    </>
  );
}
