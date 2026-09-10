"use client";
import { Button, Label, Select } from "@trussworks/react-uswds";
import type { getCatalogItemRecord } from "../workflow/catalog";
import { useApp } from "./shell";
import { Field } from "./fields";
import { FormMessages } from "./saved-work-presentation";
import { useAdminForm } from "./admin-form";
import styles from "./catalog-editor.module.css";

export type CatalogRecord = Awaited<ReturnType<typeof getCatalogItemRecord>>;
type Item = CatalogRecord["item"];
export interface EvidenceSource {
  sourceRecordId: string;
  sourceName: string;
  normalizedFields: Record<string, unknown>;
}
export const catalogFields = {
  name: "Item name",
  description: "What the item does",
  itemType: "Item type",
  ownerOrganizationId: "Owning team",
  capabilities: "Capabilities",
  dataClassifications: "Allowed data classifications",
  integrations: "Integrations",
  approvalStatus: "Approval status",
  reviewDate: "Review again by",
  vendor: "Vendor",
  licenseModel: "License model",
  renewalDate: "Renewal date",
};
type FieldName = keyof typeof catalogFields;
const arrays = new Set(["capabilities", "dataClassifications", "integrations"]);
const nullable = new Set(["vendor", "licenseModel", "renewalDate"]);

export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return Array.isArray(value) ? value.join("\n") : String(value);
}

/** What a new catalog item starts with; every other field starts empty. */
const creationDefaults: Partial<Record<FieldName, string>> = {
  itemType: "software",
  approvalStatus: "review_required",
};

function initialFields(item?: Item) {
  return Object.fromEntries(
    (Object.keys(catalogFields) as FieldName[]).map((key) => [
      key,
      item ? fieldText(item[key]) : (creationDefaults[key] ?? ""),
    ]),
  );
}

function storedValue(key: string, value: string) {
  if (arrays.has(key))
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  if (nullable.has(key)) return value.trim() || null;
  return value.trim();
}

export function catalogChanges(values: Record<string, string>, item?: Item) {
  const changes: Record<string, unknown> = {};
  const provenance = [];
  for (const key of Object.keys(catalogFields)) {
    const value = storedValue(key, values[key] ?? "");
    const sourceRecordId = values["source." + key];
    const rationale = values["reason." + key];
    if (sameValue(item, key, value) && !sourceRecordId && !rationale) continue;
    if (!item && omittedAtCreation(key, value)) continue;
    changes[key] = value;
    if (sourceRecordId || rationale)
      provenance.push(fieldEvidence(key, sourceRecordId, rationale));
  }
  return { changes, provenance };
}

function omittedAtCreation(key: string, value: unknown) {
  return value === null || key === "approvalStatus";
}

function unusedOptionalField(name: string, value: string, item?: Item) {
  return !item && nullable.has(name) && !value;
}

function sameValue(item: Item | undefined, key: string, value: unknown) {
  return Boolean(
    item && JSON.stringify(value) === JSON.stringify(item[key as FieldName]),
  );
}

function fieldEvidence(
  fieldName: string,
  sourceRecordId: string,
  rationale: string,
) {
  return {
    fieldName,
    ...(sourceRecordId && { sourceRecordId }),
    ...(rationale && { rationale }),
  };
}

interface Props {
  item?: Item;
  subjectKey: string;
  sources: EvidenceSource[];
  conflict?: { id: string; rowVersion: number };
  saved: (itemId: string) => void;
  close: () => void;
  refresh: () => void;
}

function editorScope(props: Props) {
  return {
    pageKey: props.conflict ? "resolve-conflict" : "catalog-entry",
    subjectKey: props.subjectKey,
    initial: {
      ...initialFields(props.item),
      _itemVersion: String(props.item?.rowVersion ?? 0),
    },
    rowVersion: props.conflict?.rowVersion ?? props.item?.rowVersion ?? 0,
    changed: props.refresh,
  };
}

export function CatalogEditor(props: Props) {
  const form = useAdminForm(editorScope(props));
  const editingState = conflictEditingState(props, form);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const payload = catalogChanges(form.work.values, props.item);
    const result = await sendCatalogChange(props, form, payload);
    if (result?.catalogItemId) props.saved(result.catalogItemId);
  }
  return (
    <section>
      <h2>
        {props.conflict
          ? "Choose the values OIT should use"
          : "Catalog entry and evidence"}
      </h2>
      <p>
        Record the source or verification behind each changed value. A saved
        revision becomes a draft and is excluded from new matches until it is
        published again.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset
          className="usa-fieldset"
          disabled={!form.work.ready || form.pending}
        >
          {(Object.keys(catalogFields) as FieldName[])
            .filter((key) => props.item || key !== "approvalStatus")
            .map((name) => (
              <CatalogField
                key={name}
                name={name}
                item={props.item}
                form={form}
                sources={props.sources}
              />
            ))}
          <FormMessages
            form={editingState}
            subject={props.conflict ? "source conflict" : "catalog item"}
          />
          <div className="actions">
            <Button type="submit" disabled={editingState.stale}>
              {props.conflict ? "Save resolution" : "Save catalog entry"}
            </Button>
            <Button
              type="button"
              outline
              onClick={() =>
                void form.work
                  .flush()
                  .then(props.close)
                  .catch(() => {})
              }
            >
              Save draft and close
            </Button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function conflictEditingState(
  props: Props,
  form: ReturnType<typeof useAdminForm>,
) {
  const itemVersion = props.item?.rowVersion ?? 0;
  return {
    ...form,
    stale:
      form.stale ||
      Boolean(
        props.conflict && Number(form.work.values._itemVersion) < itemVersion,
      ),
    acknowledge: () => {
      form.acknowledge();
      form.work.change("_itemVersion", String(itemVersion));
    },
  };
}

function sendCatalogChange(
  props: Props,
  form: ReturnType<typeof useAdminForm>,
  payload: ReturnType<typeof catalogChanges>,
) {
  if (props.conflict)
    return form.action(
      "resolveConflict",
      {
        conflictId: props.conflict.id,
        itemExpectedRowVersion: Number(form.work.values._itemVersion),
        ...payload,
      },
      "Source conflict resolved. The selected values and their evidence are saved.",
    );
  if (props.item)
    return form.action(
      "reviseCatalogItem",
      { catalogItemId: props.item.id, ...payload },
      "Catalog revision saved with its field evidence.",
    );
  return form.action(
    "addCatalogItem",
    {
      itemKey: "item-" + props.subjectKey,
      ...payload.changes,
      provenance: payload.provenance,
    },
    "Catalog draft created. Review and approve it before publication.",
  );
}

function CatalogField({
  name,
  item,
  form,
  sources,
}: {
  name: FieldName;
  item?: Item;
  form: ReturnType<typeof useAdminForm>;
  sources: EvidenceSource[];
}) {
  const value = form.work.values[name] ?? "";
  const changed =
    !item ||
    JSON.stringify(storedValue(name, value)) !== JSON.stringify(item[name]);
  const selected = sources.find(
    (source) => source.sourceRecordId === form.work.values["source." + name],
  );
  const supported =
    selected &&
    JSON.stringify(selected.normalizedFields[name]) ===
      JSON.stringify(storedValue(name, value));
  return (
    <div className={styles.catalogField}>
      <ItemValue
        name={name}
        value={value}
        change={(next) => form.work.change(name, next)}
      />
      <div className={styles.fieldEvidence}>
        {sources.length > 0 && (
          <>
            <Label htmlFor={"source-" + name}>Use evidence from</Label>
            <Select
              id={"source-" + name}
              name={"source-" + name}
              value={form.work.values["source." + name] ?? ""}
              onChange={(event) => {
                const source = sources.find(
                  (entry) => entry.sourceRecordId === event.target.value,
                );
                form.work.change("source." + name, event.target.value);
                if (source)
                  form.work.change(
                    name,
                    fieldText(source.normalizedFields[name]),
                  );
              }}
            >
              <option value="">Explain the verification below</option>
              {sources
                .filter((source) => source.normalizedFields[name] !== undefined)
                .map((source) => (
                  <option
                    key={source.sourceRecordId}
                    value={source.sourceRecordId}
                  >
                    {source.sourceName}
                  </option>
                ))}
            </Select>
          </>
        )}
        <Field
          name={"evidence-" + name}
          label={"Evidence for " + catalogFields[name].toLowerCase()}
          multiline
          required={
            changed && !supported && !unusedOptionalField(name, value, item)
          }
          hint="Name who verified this value, or explain why it differs from the cited source"
          value={form.work.values["reason." + name] ?? ""}
          onChange={(next) => form.work.change("reason." + name, next)}
        />
      </div>
    </div>
  );
}

function ItemValue({
  name,
  value,
  change,
}: {
  name: FieldName;
  value: string;
  change: (value: string) => void;
}) {
  const { metadata } = useApp();
  const options: Record<string, Array<[string, string]>> = {
    itemType: [
      ["software", "Software"],
      ["infrastructure", "Infrastructure"],
      ["platform", "Platform"],
    ],
    approvalStatus: [
      ["approved", "Approved"],
      ["conditional", "Conditional"],
      ["review_required", "Needs approval"],
    ],
    ownerOrganizationId: metadata.organizations.map((org) => [
      org.id,
      org.name,
    ]),
  };
  if (options[name])
    return (
      <div>
        <Label htmlFor={"value-" + name}>{catalogFields[name]}</Label>
        <Select
          id={"value-" + name}
          name={name}
          value={value}
          required
          onChange={(event) => change(event.target.value)}
        >
          <option value="">Choose a value</option>
          {options[name].map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
      </div>
    );
  return (
    <Field
      name={"value-" + name}
      label={catalogFields[name]}
      value={value}
      onChange={change}
      type={name === "reviewDate" || name === "renewalDate" ? "date" : "text"}
      multiline={name === "description" || arrays.has(name)}
      required={!nullable.has(name) && !arrays.has(name)}
      hint={arrays.has(name) ? "Enter one value per line" : undefined}
    />
  );
}
