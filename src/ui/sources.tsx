"use client";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, Label, Select, Table } from "@trussworks/react-uswds";
import type { getSourceHistory } from "../workflow/inventory";
import type { InventoryOverview } from "../server/catalog-views";
import type { sourceObservation } from "../server/catalog-views";
import { sortRows } from "../domain/sorting";
import { SortableHeader, useSort } from "./sort";
import { useData } from "./use-data";
import { useApp } from "./shell";
import { useAdminForm } from "./admin-form";
import { Field, Problem, DesignNote } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { errorText } from "./api";
import { fieldText, catalogFields } from "./catalog-editor";

type SourceRecord = Awaited<ReturnType<typeof getSourceHistory>>;

export function Sources() {
  const inventory = useData<InventoryOverview>("/api/inventory");
  const { metadata } = useApp();
  return (
    <>
      <p className="breadcrumb">
        <Link href="/catalog">Catalog</Link> / Inventory sources
      </p>
      <h1>Inventory sources</h1>
      <p>
        Keep each list’s ownership, expected update interval, and import history
        visible. A source observation is evidence, not an approved catalog
        value.
      </p>
      <div className="actions">
        <Link className="usa-button" href="/sources/new">
          Register a source
        </Link>
      </div>
      {inventory.error && <Problem>{errorText(inventory.error)}</Problem>}
      {!inventory.data && !inventory.error && (
        <p role="status">Loading sources…</p>
      )}
      {inventory.data && (
        <SourceList sources={inventory.data.sources} metadata={metadata} />
      )}
      <DesignNote title="Trusted inventory · Multiple, unaligned lists">
        Each source keeps its own observations and history. Reconciliation
        changes the governed catalog without rewriting what a source supplied.
      </DesignNote>
    </>
  );
}

const sourceListColumns = [
  ["name", "Source"],
  ["owner", "Owner"],
  ["freshness", "Expected update"],
  ["import", "Last successful import"],
  ["state", "State"],
] as const;

function SourceList({
  sources,
  metadata,
}: {
  sources: InventoryOverview["sources"];
  metadata: { organizations: Array<{ id: string; name: string }> };
}) {
  const sort = useSort({ key: "name", direction: "asc" });
  const ownerName = (source: InventoryOverview["sources"][number]) =>
    metadata.organizations.find((org) => org.id === source.ownerOrganizationId)
      ?.name;
  const rows = sortRows(sources, sort.state, (source, key) => {
    if (key === "name") return source.name;
    if (key === "owner") return ownerName(source) ?? null;
    if (key === "freshness") return source.expectedFreshnessHours;
    if (key === "import") return source.lastSuccessfulAt;
    return source.lifecycle;
  });
  return (
    <Table fullWidth compact bordered={false} striped>
      <caption>Source ownership and latest import</caption>
      <thead>
        <tr>
          {sourceListColumns.map(([key, label]) => (
            <SortableHeader key={key} sortKey={key} label={label} sort={sort} />
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((source) => (
          <tr key={source.id}>
            <td>
              <Link href={"/sources/" + source.id}>{source.name}</Link>
            </td>
            <td>{ownerName(source)}</td>
            <td>Every {source.expectedFreshnessHours} hours</td>
            <td>
              {source.lastSuccessfulAt
                ? new Date(source.lastSuccessfulAt).toLocaleString()
                : "No successful import"}
            </td>
            <td>{source.lifecycle}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function SourcePage({ id }: { id: string }) {
  const source = useData<SourceRecord>("/api/sources/" + id);
  if (!source.data)
    return (
      <>
        <h1>Inventory source</h1>
        {source.error ? (
          <Problem>{errorText(source.error)}</Problem>
        ) : (
          <p role="status">Loading the source…</p>
        )}
      </>
    );
  const data = source.data;
  return (
    <>
      <p className="breadcrumb">
        <Link href="/catalog">Catalog</Link> /{" "}
        <Link href="/sources">Inventory sources</Link> / {data.source.name}
      </p>
      <h1>{data.source.name}</h1>
      <p>
        {data.source.lifecycle === "retired"
          ? "Retired. Earlier observations remain available."
          : "Source definition and import history"}
      </p>
      <SourceEditor
        source={data.source}
        draftId={id}
        changed={source.refresh}
      />
      {data.source.fixtureKey === "inventory-source:architecture-registry" &&
        data.source.lifecycle === "active" && (
          <ArchitectureImport data={data} changed={source.refresh} />
        )}
      <h2>Import history</h2>
      {data.runs.length ? (
        <ImportHistory runs={data.runs} />
      ) : (
        <p>No import has run for this source.</p>
      )}
    </>
  );
}

const runColumns = [
  ["version", "Source version"],
  ["outcome", "Outcome"],
  ["records", "Records"],
  ["completed", "Completed"],
  ["error", "Error"],
] as const;

function ImportHistory({ runs }: { runs: SourceRecord["runs"] }) {
  const sort = useSort({ key: "version", direction: "desc" });
  const rows = sortRows(runs, sort.state, (run, key) => {
    if (key === "version") return run.sourceVersion;
    if (key === "outcome") return run.status;
    if (key === "records") return run.recordCount;
    if (key === "completed") return run.completedAt;
    return run.sanitizedError;
  });
  return (
    <Table fullWidth compact bordered={false}>
      <caption>
        Import attempts; earlier successful data is retained after failures
      </caption>
      <thead>
        <tr>
          {runColumns.map(([key, label]) => (
            <SortableHeader key={key} sortKey={key} label={label} sort={sort} />
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((run) => (
          <tr key={run.runId}>
            <td>{run.sourceVersion}</td>
            <td>{run.status}</td>
            <td>{run.recordCount}</td>
            <td>
              {run.completedAt
                ? new Date(run.completedAt).toLocaleString()
                : "In progress"}
            </td>
            <td>{run.sanitizedError ?? "None"}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function SourceEditor({
  source,
  draftId,
  changed,
}: {
  source?: SourceRecord["source"];
  draftId: string;
  changed: () => void;
}) {
  const router = useRouter();
  const form = useAdminForm({
    pageKey: "source-definition",
    subjectKey: draftId,
    rowVersion: source?.rowVersion ?? 0,
    changed,
    initial: {
      name: source?.name ?? "",
      owner: source?.ownerOrganizationId ?? "",
      freshness: String(source?.expectedFreshnessHours ?? 24),
    },
  });
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = await form.action(
      source ? "updateSource" : "registerSource",
      {
        ...(source && { sourceId: source.id }),
        name: form.work.values.name,
        ownerOrganizationId: form.work.values.owner,
        expectedFreshnessHours: Number(form.work.values.freshness),
        adapterKind: source?.adapterKind ?? "manual_source",
      },
      "Inventory source definition saved.",
    );
    if (!source && result?.sourceId) router.push("/sources/" + result.sourceId);
  }
  return <SourceDefinitionForm source={source} form={form} submit={submit} />;
}

function SourceDefinitionForm({
  source,
  form,
  submit,
}: {
  source?: SourceRecord["source"];
  form: ReturnType<typeof useAdminForm>;
  submit: (event: React.FormEvent) => Promise<void>;
}) {
  return (
    <section>
      <h2>Source definition</h2>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset
          className="usa-fieldset"
          disabled={
            !form.work.ready || form.pending || source?.lifecycle === "retired"
          }
        >
          <SourceDefinitionFields form={form} />
          {!source && (
            <p>
              Registration saves the source’s ownership and update expectations.
              This demo does not connect to a new external system automatically.
            </p>
          )}
          <FormMessages form={form} subject="source definition" />
          <div className="actions">
            <Button type="submit" disabled={form.stale}>
              Save source definition
            </Button>
            {source && (
              <Button
                type="button"
                outline
                disabled={form.stale}
                onClick={() => {
                  if (
                    window.confirm(
                      "Retire this source? Its observations and import history will remain.",
                    )
                  )
                    void form.action(
                      "retireSource",
                      { sourceId: source.id },
                      "Inventory source retired; its history is retained.",
                    );
                }}
              >
                Retire source
              </Button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function ArchitectureImport({
  data,
  changed,
}: {
  data: SourceRecord;
  changed: () => void;
}) {
  const form = useAdminForm({
    pageKey: "architecture-import",
    subjectKey: data.source.id,
    rowVersion: data.source.rowVersion,
    initial: {},
    changed,
  });
  return (
    <section>
      <h2>Simulated source update</h2>
      <p>
        Apply the provided architecture-registry example. It appends source
        observations and reopens affected conflicts; it does not overwrite
        published decisions or contact an external system.
      </p>
      <FormMessages form={form} subject="inventory source" />
      <Button
        type="button"
        disabled={!form.work.ready || form.pending}
        onClick={() =>
          void form.action(
            "importFixture",
            {},
            "The architecture fixture import is present. Review affected catalog conflicts.",
          )
        }
      >
        Apply architecture example update
      </Button>
    </section>
  );
}

export function NewSource() {
  const search = useSearchParams();
  const router = useRouter();
  const draft = search.get("draft");
  useEffect(() => {
    if (!draft) router.replace("/sources/new?draft=" + crypto.randomUUID());
  }, [draft, router]);
  return (
    <>
      <p className="breadcrumb">
        <Link href="/sources">Inventory sources</Link> / New source
      </p>
      <h1>Register an inventory source</h1>
      {draft && <SourceEditor draftId={draft} changed={() => {}} />}
    </>
  );
}

export function ObservationPage({ id }: { id: string }) {
  const result = useData<Awaited<ReturnType<typeof sourceObservation>>>(
    "/api/observations/" + id,
  );
  if (!result.data)
    return (
      <>
        <h1>Source observation</h1>
        {result.error ? (
          <Problem>{errorText(result.error)}</Problem>
        ) : (
          <p role="status">Loading the observation…</p>
        )}
      </>
    );
  const row = result.data;
  return (
    <>
      <p className="breadcrumb">
        <Link href="/sources">Inventory sources</Link> /{" "}
        <Link href={"/sources/" + row.sourceId}>Source history</Link> /{" "}
        {row.sourceRecordKey}
      </p>
      <h1>Source record {row.sourceRecordKey}</h1>
      <p>
        Observed {new Date(row.observedAt).toLocaleString()} · Immutable source
        evidence
      </p>
      <ObservedValues fields={row.normalizedFields} />
    </>
  );
}

function ObservedValues({ fields }: { fields: Record<string, unknown> }) {
  const sort = useSort({ key: "field", direction: "asc" });
  const label = (key: string) =>
    catalogFields[key as keyof typeof catalogFields] ?? key;
  const rows = sortRows(Object.entries(fields), sort.state, ([key]) =>
    label(key),
  );
  return (
    <Table fullWidth compact bordered={false}>
      <caption>Values received from this source</caption>
      <thead>
        <tr>
          <SortableHeader sortKey="field" label="Source field" sort={sort} />
          <th scope="col">Observed value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <th scope="row">{label(key)}</th>
            <td className="preserve-lines">{fieldText(value)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function SourceDefinitionFields({
  form,
}: {
  form: ReturnType<typeof useAdminForm>;
}) {
  const { metadata } = useApp();
  return (
    <>
      <Field
        name="source-name"
        label="Source name"
        value={form.work.values.name}
        onChange={(value) => form.work.change("name", value)}
      />
      <Label htmlFor="source-owner">Source owner</Label>
      <Select
        id="source-owner"
        name="owner"
        required
        value={form.work.values.owner}
        onChange={(event) => form.work.change("owner", event.target.value)}
      >
        <option value="">Choose the responsible team</option>
        {metadata.organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </Select>
      <Field
        name="freshness"
        label="Expected interval between updates (hours)"
        type="number"
        min={1}
        max={2160}
        step="1"
        hint="The dashboard uses this interval to flag information that may be out of date"
        value={form.work.values.freshness}
        onChange={(value) => form.work.change("freshness", value)}
      />
    </>
  );
}
