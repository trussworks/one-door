"use client";

import { Alert, Label, Textarea, TextInput } from "@trussworks/react-uswds";
import type { ReactNode } from "react";
import styles from "./fields.module.css";

export interface FieldProps {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string;
  maxLength?: number;
  required?: boolean;
  multiline?: boolean;
  type?: "text" | "number" | "password" | "search" | "date";
  min?: number;
  max?: number;
  step?: string;
  inputMode?: "numeric" | "decimal";
  pattern?: string;
  /** A short-answer field (a number, a code) rendered at reading width
   * instead of stretching to the form's full width. */
  narrow?: boolean;
}

function fieldAttributes(props: FieldProps) {
  return {
    id: props.name,
    name: props.name,
    value: props.value,
    required: props.required ?? true,
    maxLength: props.maxLength,
    "aria-invalid": Boolean(props.error) || undefined,
    "aria-describedby":
      [props.hint && props.name + "-hint", props.error && props.name + "-error"]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

export function Field(props: FieldProps) {
  const attributes = fieldAttributes(props);
  const input =
    props.type === "date" ? (
      <input
        {...attributes}
        type="date"
        className="usa-input"
        onChange={(event) => props.onChange(event.target.value)}
      />
    ) : (
      <TextInput
        {...attributes}
        type={props.type ?? "text"}
        min={props.min}
        max={props.max}
        step={props.step}
        inputMode={props.inputMode}
        pattern={props.pattern}
        className={props.narrow ? "usa-input--medium" : undefined}
        onChange={(event) => props.onChange(event.target.value)}
      />
    );
  return (
    <div className="field">
      <Label htmlFor={props.name}>{props.label}</Label>
      {props.hint && (
        <p className="usa-hint" id={props.name + "-hint"}>
          {props.hint}
        </p>
      )}
      {props.error && (
        <p
          id={props.name + "-error"}
          className="usa-error-message"
          role="alert"
        >
          {props.error}
        </p>
      )}
      {props.multiline ? (
        <Textarea
          {...attributes}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        input
      )}
    </div>
  );
}

/** Draft controls stay disabled until their saved-work record loads: the
 * controller drops a change made before then, so an enabled field would
 * visibly accept input and lose it. */
export function SavedWorkFieldset({
  ready,
  children,
}: {
  ready: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="usa-fieldset" disabled={!ready}>
      {children}
    </fieldset>
  );
}

export function Problem({ children }: { children: ReactNode }) {
  return (
    <Alert type="error" role="alert" slim>
      {/* The slim alert positions its icon over the start of the body, and
          clears it through .usa-alert__text. Children placed straight into the
          body are drawn under the icon. */}
      <p className={`usa-alert__text ${styles.problem}`}>{children}</p>
    </Alert>
  );
}

export function RefreshStatus({ loading }: { loading: boolean }) {
  return (
    <p role="status" className={styles.refreshStatus}>
      {loading ? "Updating results…" : ""}
    </p>
  );
}

export function PreparationStatus({ label }: { label: string }) {
  return (
    <div className={styles.modelWaiting} role="status" aria-live="polite">
      <progress aria-label={label} />
      <div>
        <strong>{label}</strong>
        <p>
          Preparation can continue while you are away. Results appear here when
          ready, without a manual refresh. Check that your form changes are
          saved before leaving.
        </p>
      </div>
    </div>
  );
}

export function ModelWaiting({
  status,
  refining = false,
}: {
  status?: string;
  refining?: boolean;
}) {
  let label = refining
    ? "Updating request information…"
    : "Preparing request information…";
  if (status !== "leased")
    label = refining
      ? "Waiting to update request information…"
      : "Waiting to prepare request information…";
  return <PreparationStatus label={label} />;
}

export function DesignNote({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <aside className="design-note">
      <strong>{title}</strong>
      <p>{children}</p>
    </aside>
  );
}
