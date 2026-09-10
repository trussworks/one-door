"use client";
import { useState } from "react";
import { Button } from "@trussworks/react-uswds";
import { api, errorText } from "./api";
import { Field, Problem } from "./fields";
import styles from "./gate.module.css";

export function DemoGate({ entered }: { entered: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await api("/api/session", { code });
      entered();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }
  return (
    <main id="main-content" className={styles.gate + " grid-container"}>
      <h1>Try One Door</h1>
      <p>
        The shared code lets you try the requester, reviewer and administrator
        views.
      </p>
      <p>
        Demonstration only: inventory, policies and external activity are
        fictional. Use fictional information; submitted requests are shared with
        reviewers.
      </p>
      {error && <Problem>{error}</Problem>}
      <form className="usa-form" onSubmit={(event) => void submit(event)}>
        <Field
          name="access-code"
          label="Demo code"
          type="password"
          value={code}
          onChange={setCode}
        />
        <div className="actions">
          <Button type="submit" disabled={pending}>
            {pending ? "Checking code…" : "Enter demo"}
          </Button>
        </div>
      </form>
    </main>
  );
}
