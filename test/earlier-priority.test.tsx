import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { RequestView } from "../src/server/request-views";
import type { ReadResult } from "../src/ui/use-data";
import { EarlierPriorityForm } from "../src/ui/priority-contributions";

const state = vi.hoisted(() => ({
  read: { path: null } as ReadResult<{
    payload?: Record<string, unknown>;
  } | null>,
  refresh: vi.fn(),
}));
vi.mock("../src/ui/shell", () => ({
  useApp: () => ({ metadata: { actors: [] } }),
}));
vi.mock("../src/ui/use-data", () => ({
  useData: () => ({ ...state.read, refresh: state.refresh }),
}));

function markup() {
  return renderToStaticMarkup(
    <EarlierPriorityForm
      data={{ record: { requestId: "request" } } as RequestView}
    />,
  );
}

beforeEach(() => {
  state.read = { path: "/api/wip", loading: false, data: null };
});

it("keeps successful absence quiet", () => {
  expect(markup()).toBe("");
});

it("reports a failed read and offers a retry", () => {
  state.read = { path: "/api/wip", error: new Error("unavailable") };
  const html = markup();
  expect(html).toContain('role="alert"');
  expect(html).toContain("Could not load your earlier estimate drafts.");
  expect(html).toContain("Retry loading");
});

it("reports loading separately from successful absence", () => {
  state.read = { path: "/api/wip", loading: true };
  expect(markup()).toContain("Loading earlier estimate drafts…");
  expect(markup()).not.toContain('role="alert"');
});

it.each(["loaded", "loading", "failed"])(
  "retains earlier entries when the read is %s",
  (status) => {
    state.read = {
      path: "/api/wip",
      data: { payload: { reach: "275", effort: "3" } },
      loading: status === "loading",
      error: status === "failed" ? new Error("unavailable") : undefined,
    };
    const html = markup();
    expect(html).toContain("Your earlier estimate drafts");
    expect(html).toContain("275");
    expect(html).toContain("3 person-months");
    expect(html.includes('role="alert"')).toBe(status === "failed");
  },
);
