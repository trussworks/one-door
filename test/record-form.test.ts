import { beforeEach, expect, it, vi } from "vitest";
import type { RequestView } from "../src/server/request-views";
import {
  savedWorkStatus,
  type SavedWorkStatus,
} from "../src/ui/saved-work-controller";

const state = vi.hoisted(() => ({
  ready: false,
  status: { kind: "loading", message: "" } as SavedWorkStatus,
  values: { _recordVersion: "1", idempotencyKey: "pending-key" },
  busy: { current: false },
  setBusy: vi.fn(),
  setError: vi.fn(),
  flush: vi.fn(),
  change: vi.fn(),
  api: vi.fn(),
  changed: vi.fn(),
  announce: vi.fn(),
  recorded: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useContext: () => ({ busy: state.busy, setBusy: state.setBusy }),
  useState: (initial: unknown) => [initial, state.setError],
}));
vi.mock("../src/ui/shell", () => ({
  useApp: () => ({
    metadata: { visitor: { visitorId: "visitor", actorId: "actor" } },
    announce: state.announce,
  }),
}));
vi.mock("../src/ui/use-saved-work", () => ({
  useSavedWork: () => ({
    ready: state.ready,
    status: state.status,
    values: state.values,
    flush: state.flush,
    change: state.change,
  }),
}));
vi.mock("../src/ui/api", async (original) => ({
  ...(await original<typeof import("../src/ui/api")>()),
  api: state.api,
}));

import { useRecordForm } from "../src/ui/record-form";

beforeEach(() => {
  vi.resetAllMocks();
  state.ready = false;
  state.status = savedWorkStatus.loading;
  state.busy.current = false;
  state.flush.mockResolvedValue(undefined);
  state.api.mockResolvedValue({ rowVersion: 2 });
  state.setBusy.mockImplementation((busy: boolean) => {
    state.busy.current = busy;
  });
});

function recordForm() {
  const data = {
    record: { requestId: "request", displayId: "OD-test", rowVersion: 1 },
  } as RequestView;
  return useRecordForm({
    data,
    pageKey: "post-review-priority",
    initial: {},
    changed: state.changed,
  });
}

it.each([savedWorkStatus.loading, savedWorkStatus.loadFailed])(
  "does not dispatch a record action while its own saved work is $kind",
  async (status) => {
    state.status = status;
    const form = recordForm();
    const result = await form.action(
      "submitAssessment",
      { priorityDecisions: [] },
      "Recorded.",
      state.recorded,
    );
    expect(result).toBe(false);
    expect(state.setError).toHaveBeenLastCalledWith(status.message);
    for (const effect of [
      state.flush,
      state.api,
      state.recorded,
      state.change,
      state.changed,
      state.announce,
      state.setBusy,
    ]) {
      expect(effect).not.toHaveBeenCalled();
    }
  },
);

it("records through the actual send path once its own saved work has loaded", async () => {
  state.ready = true;
  state.status = savedWorkStatus.loaded;
  const order: string[] = [];
  state.flush.mockImplementation(async () => {
    order.push("flush");
  });
  state.api.mockImplementation(async () => {
    order.push("api");
    return { rowVersion: 2 };
  });
  state.recorded.mockImplementation(() => {
    order.push("recorded");
  });
  state.changed.mockImplementation(() => {
    order.push("refresh");
  });
  state.announce.mockImplementation(() => {
    order.push("announce");
  });
  const result = await recordForm().action(
    "submitAssessment",
    { priorityDecisions: [] },
    "Recorded.",
    state.recorded,
  );
  expect(result).toBe(true);
  expect(state.api).toHaveBeenCalledExactlyOnceWith("/api/review/actions", {
    action: "submitAssessment",
    input: {
      requestId: "request",
      expectedRowVersion: 1,
      priorityDecisions: [],
    },
  });
  expect(state.change).toHaveBeenCalledWith("_recordVersion", "2");
  expect(order).toEqual([
    "flush",
    "api",
    "recorded",
    "flush",
    "refresh",
    "announce",
  ]);
  expect(state.setBusy.mock.calls).toEqual([[true], [false]]);
  expect(state.busy.current).toBe(false);
});
