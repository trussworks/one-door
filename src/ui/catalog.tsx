"use client";
import { TableScroll } from "./table-scroll";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Label, Select, Table } from "@trussworks/react-uswds";
import type { InventoryOverview } from "../server/catalog-views";
import { PAGE_SIZE } from "../domain/pagination";
import { sortRows, type SortState } from "../domain/sorting";
import { SortableHeader, useUrlSort } from "./sort";
import { useData } from "./use-data";
import { useApp } from "./shell";
import { Field, Problem, DesignNote } from "./fields";
import { errorText } from "./api";

export const approvals = {
  approved: "Approved",
  conditional: "Conditional",
  review_required: "Needs approval",
};
export const publications = {
  draft: "Draft",
  published: "Published",
  retired: "Retired",
};

export function catalogMatchesState(
  item: Pick<
    InventoryOverview["items"][number],
    "id" | "publicationState" | "approvalStatus" | "reviewDate"
  >,
  conflicts: Pick<
    InventoryOverview["conflicts"][number],
    "catalogItemId" | "state"
  >[],
  state: string,
  today: string,
) {
  const disputed = conflicts.some(
    (conflict) =>
      conflict.catalogItemId === item.id && conflict.state !== "resolved",
  );
  const overdue =
    item.publicationState !== "retired" && item.reviewDate < today;
  if (state === "conflict") return disputed;
  if (state === "overdue") return overdue;
  if (state === "attention")
    return (
      item.publicationState !== "retired" &&
      [
        disputed,
        overdue,
        item.publicationState === "draft",
        item.approvalStatus !== "approved",
      ].some(Boolean)
    );
  return (
    state === "all" ||
    item.publicationState === state ||
    item.approvalStatus === state
  );
}

export function Catalog() {
  const source = useData<InventoryOverview>("/api/inventory");
  const search = useSearchParams();
  const router = useRouter();
  const term = search.get("q") ?? "";
  const state = search.get("state") ?? "attention";
  const today = new Date().toISOString().slice(0, 10);
  function change(key: string, value: string) {
    const params = new URLSearchParams(search);
    params.set(key, value);
    if (key !== "page") params.delete("page");
    router.replace("/catalog?" + params, { scroll: false });
  }
  const items = (source.data?.items ?? []).filter(
    (item) =>
      (item.name + " " + item.description + " " + item.capabilities.join(" "))
        .toLowerCase()
        .includes(term.toLowerCase()) &&
      catalogMatchesState(item, source.data?.conflicts ?? [], state, today),
  );
  return (
    <>
      <h1>Catalog</h1>
      <p>
        Start with entries that need approval, a review, or a source
        disagreement resolved. Published values remain available while you check
        the evidence.
      </p>
      <div className="actions">
        <Link className="usa-button" href="/catalog/new">
          Add an inventory item
        </Link>
        <Link href="/sources">Manage inventory sources</Link>
      </div>
      <CatalogFilters term={term} state={state} change={change} />
      {source.error && <Problem>{errorText(source.error)}</Problem>}
      {!source.data && !source.error && (
        <p role="status">Loading the catalog…</p>
      )}
      {source.data && (
        <>
          <CatalogCount
            count={items.length}
            clear={() =>
              router.replace("/catalog?state=all", { scroll: false })
            }
          />
          <CatalogTable items={items} conflicts={source.data.conflicts} />
        </>
      )}
      <DesignNote title="Software matching · Reconcile unaligned inventories">
        Imported observations remain separate from the approved catalog. A
        steward chooses the published values and records the evidence; a later
        source change can reopen a conflict.
      </DesignNote>
    </>
  );
}

function CatalogCount({ count, clear }: { count: number; clear: () => void }) {
  return (
    <p role="status">
      {count ? `${count} items match.` : "No entries match this view. "}
      {count === 0 && (
        <Button type="button" unstyled onClick={clear}>
          Show all catalog entries
        </Button>
      )}
    </p>
  );
}

function CatalogFilters({
  term,
  state,
  change,
}: {
  term: string;
  state: string;
  change: (key: string, value: string) => void;
}) {
  return (
    <div className="queue-filters">
      <Field
        name="catalog-search"
        label="Find an item"
        type="search"
        required={false}
        value={term}
        onChange={(value) => change("q", value)}
      />
      <div>
        <Label htmlFor="catalog-state">Show</Label>
        <Select
          id="catalog-state"
          name="state"
          value={state}
          onChange={(event) => change("state", event.target.value)}
        >
          <option value="attention">Needs attention</option>
          <option value="all">All items</option>
          <option value="conflict">Source disagreements</option>
          <option value="overdue">Review overdue</option>
          {Object.entries(publications).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
          <option value="review_required">Needs approval</option>
          <option value="conditional">Conditional approval</option>
        </Select>
      </div>
    </div>
  );
}

const catalogColumns = [
  ["name", "Item"],
  ["state", "Publication / approval"],
  ["owner", "Owning team"],
  ["review", "Review due"],
  ["conflict", "Source disagreement"],
] as const;

type CatalogColumn = (typeof catalogColumns)[number][0];

function catalogRowValue(
  item: InventoryOverview["items"][number],
  key: CatalogColumn,
  context: CatalogSortContext,
): string | number | null {
  if (key === "name") return item.name;
  if (key === "state")
    return (
      publications[item.publicationState] + " " + approvals[item.approvalStatus]
    );
  if (key === "owner")
    return (
      context.organizations.find((org) => org.id === item.ownerOrganizationId)
        ?.name ?? null
    );
  if (key === "review") return item.reviewDate;
  return context.conflicts.filter(
    (conflict) =>
      conflict.catalogItemId === item.id && conflict.state !== "resolved",
  ).length;
}

interface CatalogSortContext {
  conflicts: InventoryOverview["conflicts"];
  organizations: Array<{ id: string; name: string }>;
}

/** The whole matching set sorts before the page slice is taken. */
export function catalogPage(
  items: InventoryOverview["items"],
  state: SortState<CatalogColumn>,
  current: number,
  context: CatalogSortContext,
) {
  return sortRows(items, state, (item, key) =>
    catalogRowValue(item, key, context),
  ).slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
}

function CatalogTable({
  items,
  conflicts,
}: {
  items: InventoryOverview["items"];
  conflicts: InventoryOverview["conflicts"];
}) {
  const query = useSearchParams();
  const router = useRouter();
  const { metadata } = useApp();
  const sort = useUrlSort<CatalogColumn>(
    "/catalog",
    catalogColumns.map(([key]) => key),
  );
  const page = Math.max(1, Math.trunc(Number(query.get("page"))) || 1);
  const setPage = (next: number) => {
    const search = new URLSearchParams(query);
    search.set("page", String(next));
    router.replace("/catalog?" + search, { scroll: false });
  };
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  return (
    <>
      <TableScroll label="Governed inventory" fixedHeight>
        <Table fullWidth compact bordered={false} striped>
          <caption>Software and infrastructure inventory</caption>
          <thead>
            <tr>
              {catalogColumns.map(([key, label]) => (
                <SortableHeader
                  key={key}
                  sortKey={key}
                  label={label}
                  sort={sort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {catalogPage(items, sort.state, current, {
              conflicts,
              organizations: metadata.organizations,
            }).map((item) => (
              <CatalogRow
                key={item.id}
                item={item}
                conflicts={conflicts}
                query={query.toString()}
              />
            ))}
          </tbody>
        </Table>
      </TableScroll>
      <CatalogPages current={current} pages={pages} setPage={setPage} />
    </>
  );
}

function CatalogPages({
  current,
  pages,
  setPage,
}: {
  current: number;
  pages: number;
  setPage: (page: number) => void;
}) {
  return (
    <>
      {pages > 1 && (
        <nav aria-label="Catalog pages" className="actions">
          <Button
            type="button"
            outline
            disabled={current === 1}
            onClick={() => setPage(current - 1)}
          >
            Previous page
          </Button>
          <span>
            Page {current} of {pages}
          </span>
          <Button
            type="button"
            outline
            disabled={current === pages}
            onClick={() => setPage(current + 1)}
          >
            Next page
          </Button>
        </nav>
      )}
    </>
  );
}

function CatalogRow({
  item,
  conflicts,
  query,
}: {
  item: InventoryOverview["items"][number];
  conflicts: InventoryOverview["conflicts"];
  query: string;
}) {
  const { metadata } = useApp();
  return (
    <tr>
      <td>
        <Link
          href={"/catalog/" + item.id + "?from=" + encodeURIComponent(query)}
        >
          {item.name}
        </Link>
        <span className="request-meta">
          {item.itemType} · Version {item.currentVersion}
        </span>
      </td>
      <td>
        {publications[item.publicationState]}
        <span className="request-meta">{approvals[item.approvalStatus]}</span>
      </td>
      <td>
        {metadata.organizations.find(
          (org) => org.id === item.ownerOrganizationId,
        )?.name ?? "Owner unavailable"}
      </td>
      <td>{item.reviewDate}</td>
      <td>
        {conflicts
          .filter(
            (conflict) =>
              conflict.catalogItemId === item.id &&
              conflict.state !== "resolved",
          )
          .map((conflict) => (
            <Link
              className="block-link"
              key={conflict.id}
              href={"/conflicts/" + conflict.id}
            >
              Review conflict
            </Link>
          ))}
      </td>
    </tr>
  );
}
