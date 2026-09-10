"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@trussworks/react-uswds";
import type { AdministratorNote } from "../workflow/admin";
import { useAdminForm } from "./admin-form";
import { Field } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import styles from "./administrator-notes.module.css";

interface Props {
  notes: AdministratorNote[];
  administrative: boolean;
  requestId: string;
  rowVersion: number;
  changed: () => void | Promise<void>;
}

export function AdministratorNotes(props: Props) {
  if (!props.administrative && props.notes.length === 0) return null;
  return (
    <section
      className={styles.notes}
      aria-labelledby="administrator-notes-heading"
    >
      <h2 id="administrator-notes-heading">Administrator notes</h2>
      {props.administrative && <NoteForm {...props} />}
      <div
        className={styles.entries}
        tabIndex={props.notes.length ? 0 : undefined}
        role="region"
        aria-label="Recorded notes"
      >
        {props.notes.toReversed().map((note) => (
          <article key={note.id}>
            <p className={styles.noteAuthor}>
              <strong>{note.authorName || "Administrator"}</strong> ·{" "}
              <time dateTime={new Date(note.createdAt).toISOString()}>
                {new Date(note.createdAt).toLocaleString()}
              </time>
            </p>
            <p className={styles.noteBody}>{note.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function useNoteForm({ requestId, rowVersion, notes, changed }: Props) {
  const form = useAdminForm({
    pageKey: "administrator-note",
    subjectKey: requestId,
    initial: { body: "", noteId: "" },
    rowVersion,
    changed,
  });
  const posting = useRef(false);
  // An old post must not clear the draft in a reopened note form.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (posting.current) return;
    const body = form.work.values.body.trim();
    if (!body) {
      setError("Enter a note before saving.");
      return;
    }
    if (body.length > 2000) {
      setError("Keep the note to 2,000 characters or fewer.");
      return;
    }
    posting.current = true;
    setError("");
    setConfirmation("");
    try {
      const recorded = notes.find(
        (note) => note.id === form.work.values.noteId,
      );
      const noteId =
        !form.work.values.noteId || (recorded && recorded.body !== body)
          ? crypto.randomUUID()
          : form.work.values.noteId;
      form.work.change("noteId", noteId);
      const result = await form.action(
        "addAdministratorNote",
        { requestId, noteId, body },
        "",
      );
      if (result && mounted.current) {
        setConfirmation("Note recorded.");
        form.work.change("body", "");
        form.work.change("noteId", "");
        void form.work.flush().catch(() => {});
      }
    } finally {
      posting.current = false;
    }
  }
  return { form, error, confirmation, submit };
}

function NoteForm(props: Props) {
  const { form, error, confirmation, submit } = useNoteForm(props);
  const feedback = {
    ...form,
    work: {
      ...form.work,
      status:
        form.work.status.kind === "saved"
          ? { kind: "saved" as const, message: "Your draft is saved." }
          : form.work.status,
    },
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset
        className="usa-fieldset"
        disabled={!form.work.ready || form.pending}
      >
        <Field
          name="administrator-note"
          label="New administrator note"
          hint="Use up to 2,000 characters. Notes are visible only in the reviewer and administrator views."
          value={form.work.values.body}
          multiline
          maxLength={2000}
          error={error}
          onChange={(value) => form.work.change("body", value)}
        />
        <FormMessages form={feedback} />
        <Button type="submit">
          {form.pending ? "Saving note…" : "Record note"}
        </Button>
        <p className="save-status" role="status">
          {confirmation}
        </p>
      </fieldset>
    </form>
  );
}
