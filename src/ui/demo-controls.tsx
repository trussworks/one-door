"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Checkbox } from "@trussworks/react-uswds";
import type { ResetOutcome } from "../seed/fixture-reset";
import { api, errorText } from "./api";
import { Problem } from "./fields";
import styles from "./demo-controls.module.css";
import { useApp } from "./shell";

export function DemoControls() {
  const { announce } = useApp();
  const busy = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);

  async function restore(event: React.FormEvent) {
    event.preventDefault();
    if (!confirmed || busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setCompleted(false);
    try {
      await api<ResetOutcome>("/api/admin/actions", {
        action: "resetFixtures",
        input: { confirmed: true },
      });
      setConfirmed(false);
      setCompleted(true);
      announce(
        "Demo examples restored. Visitor-created requests, saved work, ratings, and model costs were kept.",
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <div className={styles.demoControls}>
      <h1>Demo controls</h1>
      <p>
        Prepare the shared examples for another walkthrough. These controls
        affect every demo visitor.
      </p>
      <RestoreConsequences />
      <form onSubmit={(event) => void restore(event)}>
        <Checkbox
          id="confirm-fixture-restore"
          name="confirm-fixture-restore"
          label="I understand that other visitors may be working on these examples. Restore the shared examples."
          checked={confirmed}
          disabled={pending}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {error && <Problem>{error}</Problem>}
        <div className="actions">
          <Button type="submit" disabled={!confirmed || pending}>
            {pending ? "Restoring examples…" : "Restore examples"}
          </Button>
          <Link href="/dashboard">Return to Dashboard</Link>
        </div>
        {pending && (
          <p role="status">
            Restoration is running. Wait for confirmation before starting
            another walkthrough.
          </p>
        )}
      </form>
      {completed && (
        <p>
          <Link href="/admin/requests">Open the restored request queue</Link> or{" "}
          <Link href="/catalog">review the catalog</Link>.
        </p>
      )}
      <h2>Model usage</h2>
      <p>
        <Link href="/reports#model-usage">
          View model calls, costs, and usage limits
        </Link>
        . Restoring examples does not change those records.
      </p>
    </div>
  );
}

function RestoreConsequences() {
  return (
    <>
      <h2>Restore the example scenarios</h2>
      <p>
        Restore the seeded requests, catalog, source conflicts, and simulated
        delivery records to their starting state. Changes made while trying
        those examples will no longer be the current state.
      </p>
      <h3>What stays</h3>
      <ul className="usa-list">
        <li>Requests that visitors created and their answers</li>
        <li>Saved unfinished work and recorded satisfaction ratings</li>
        <li>Earlier decisions, source evidence, and model-call costs</li>
      </ul>
      <p>
        Preparation still running on a seeded example will stop being current.
        This does not cancel charges already incurred or reset the model limits.
      </p>
    </>
  );
}
