import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { RequestView } from "../src/server/request-views";
import type { PriorityView } from "../src/domain/priority";
import type { useRecordForm } from "../src/ui/record-form";
import {
  createDraftStore,
  PostReviewPrioritySave,
  useFinishSend,
} from "../src/ui/review-brief";

const state = vi.hoisted(() => ({
  form: null as unknown as ReturnType<typeof useRecordForm>,
  error: vi.fn(),
  action: vi.fn(),
  click: undefined as (() => void) | undefined,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, state.error],
}));
vi.mock("../src/ui/record-form", async (original) => ({
  ...(await original<typeof import("../src/ui/record-form")>()),
  useRecordForm: () => state.form,
}));
vi.mock("@trussworks/react-uswds", async (original) => ({
  ...(await original<typeof import("@trussworks/react-uswds")>()),
  Button: (props: {
    children: ReactNode;
    onClick: () => void;
    disabled: boolean;
  }) => {
    state.click = props.onClick;
    return createElement(
      "button",
      { disabled: props.disabled },
      props.children,
    );
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.click = undefined;
  state.form = {
    work: {
      ready: true,
      values: { idempotencyKey: "readiness-check" },
      status: { kind: "loaded", message: "" },
      change: vi.fn(),
    },
    action: state.action,
  } as unknown as ReturnType<typeof useRecordForm>;
});

function incompleteRegistry(completed = false) {
  const store = createDraftStore();
  // Impact is ready to submit; Reach exists in the view but has never registered.
  store.register(
    "priority",
    "impact",
    {
      action: "replace",
      value: "2",
      basis: "time saved",
    },
    { ready: true },
  );
  const data = {
    record: { stage: completed ? "first_review_completed" : "under_review" },
    delivery: { resolution: null },
    review: { blockers: [] },
    candidates: [],
    findings: [],
    inputRequests: [],
  } as unknown as RequestView;
  const priority = {
    complete: false,
    factors: ["reach", "impact"].map((factor) => ({
      factor,
      status: "missing",
      proposals: [],
      reviewed: null,
    })),
  } as unknown as PriorityView;
  return { data, store, priority };
}

it.each([false, true])(
  "refuses first-review submission with an absent owner (complete=%s)",
  async (complete) => {
    const send = useFinishSend({
      ...incompleteRegistry(),
      form: state.form,
      setError: state.error,
      setRatingAttempted: vi.fn(),
    });
    await send(complete);
    expect(state.error).toHaveBeenLastCalledWith(
      "Drafts are still loading. Wait before recording the review.",
    );
    expect(state.action).not.toHaveBeenCalled();
    expect(state.form.work.change).not.toHaveBeenCalled();
  },
);

it("disables and refuses post-review submission with an absent owner", () => {
  const html = renderToStaticMarkup(
    <PostReviewPrioritySave {...incompleteRegistry(true)} changed={vi.fn()} />,
  );
  expect(html).toContain('disabled=""');
  expect(state.click).toBeTypeOf("function");
  state.click!();
  expect(state.error).toHaveBeenLastCalledWith(
    "Drafts are still loading. Wait before recording the review.",
  );
  expect(state.action).not.toHaveBeenCalled();
  expect(state.form.work.change).not.toHaveBeenCalled();
});
