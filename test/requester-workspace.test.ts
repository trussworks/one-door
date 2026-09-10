import {
  sameEditableValues,
  savedWorkStatus,
} from "../src/ui/saved-work-controller";
import { firstReviewOpen } from "../src/ui/record-form";
import { requesterContentLabels } from "../src/ui/request-summary";
import { jobPending } from "../src/ui/status-labels";
import { afterEach, expect, it, vi } from "vitest";
import { saveStartDraft } from "../src/ui/intake";
import {
  completeContent,
  contentIssue,
  contentValues,
  intakeBase,
  submissionInput,
  workspaceState,
  workspaceHeading,
  refinementChanges,
  primaryActionLabel,
  visibleSaveWork,
  IntakeQuestions,
  type IntakeWorkspace,
} from "../src/ui/requester-workspace";
import {
  serviceFeedbackLabel,
  recordNextAction,
  ServiceEvaluation,
} from "../src/ui/request-record";
import { IntakeDialogue } from "../src/ui/record-history";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestView } from "../src/server/request-views";
import {
  intakeResultSchema,
  providerOutputSchema,
} from "../src/models/contracts";

afterEach(() => vi.unstubAllGlobals());

it("shows undecided service evidence and its freshness limits to reviewers", () => {
  const evaluation = {
    jobId: "job",
    matchesSubmission: false,
    corpusCurrent: false,
    candidates: [
      {
        id: "candidate",
        offeringId: "offering",
        name: "Field capture service",
        version: 1,
        lifecycle: "active",
        fitBand: "possible",
        coverage: ["Offline capture"],
        gaps: ["Viewing workflow needs review"],
        relatedOfferingKeys: [],
        rationale: "Useful for capture; not the whole workflow.",
        requesterDecision: null,
        reason: null,
        decidedAt: null,
      },
    ],
  } as NonNullable<RequestView["serviceEvaluation"]>;
  const html = renderToStaticMarkup(
    createElement(ServiceEvaluation, { evaluation }),
  );
  for (const text of [
    "Field capture service",
    "Offline capture",
    "Viewing workflow needs review",
    "earlier version of the request",
    "service catalog has changed",
  ])
    expect(html).toContain(text);
});

it("names the current intake task instead of asking for the description again", () => {
  const data = {
    contentComplete: true,
    questions: [],
  } as unknown as IntakeWorkspace;
  expect(workspaceHeading(data, true)).toBe("Updating your request");
  expect(workspaceHeading({ ...data, contentComplete: false }, true)).toBe(
    "Preparing your request",
  );
  expect(workspaceHeading(data, false)).toBe("Review and send your request");
  expect(workspaceHeading({ ...data, contentComplete: false }, false)).toBe(
    "Complete your request",
  );
  expect(
    workspaceHeading(
      {
        ...data,
        questions: [{ answer: null }] as IntakeWorkspace["questions"],
      },
      false,
    ),
  ).toBe("A few details will help");
});

it("shows exact intake answers and distinguishes unanswered questions", () => {
  const html = renderToStaticMarkup(
    createElement(IntakeDialogue, {
      questions: [
        {
          questionIndex: 0,
          isQuestion: true,
          turnId: "q0",
          question: "Who uses the findings?",
          answer: "Field teams\nBudget analysts",
        },
        {
          questionIndex: 1,
          isQuestion: true,
          turnId: "q1",
          question: "When are findings needed?",
          answer: null,
        },
        {
          questionIndex: 2,
          turnId: "note",
          question: "I captured the outcome.",
          answer: null,
          isQuestion: false,
        },
      ],
    }),
  );
  expect(html).toContain("Who uses the findings?");
  expect(html).toContain("Field teams\nBudget analysts");
  expect(html).toContain("No answer recorded.");
  expect(html.match(/No answer recorded\./g)).toHaveLength(1);
  expect(html).toContain("Intake note");
  expect(html).toContain("I captured the outcome.");
});

it("rejects model lists that cannot fit the submission record, including multiline items", () => {
  const content = completeContent({ affectedPeople: "Field teams" }, "Need");
  const result = { content, questions: [], services: [] };
  expect(intakeResultSchema.safeParse(result).success).toBe(true);
  expect(
    intakeResultSchema.safeParse({
      ...result,
      content: { ...content, acceptanceCriteria: Array(21).fill("Criterion") },
    }).success,
  ).toBe(false);
  expect(
    intakeResultSchema.safeParse({
      ...result,
      content: {
        ...content,
        acceptanceCriteria: Array(20).fill("One\nTwo"),
      },
    }).success,
  ).toBe(false);
  expect(providerOutputSchema("intake_interpret")).toHaveProperty(
    "properties.content",
  );
});

it("identifies the list and limit before a manual edit can be sent", () => {
  const content = completeContent({ affectedPeople: "Field teams" }, "Need");
  expect(contentIssue(content)).toBeNull();
  expect(
    contentIssue({
      ...content,
      acceptanceCriteria: Array(21).fill("Criterion"),
    }),
  ).toEqual({
    field: "acceptanceCriteria",
    message: "What must be achieved: use up to 20 items, one per line.",
  });
  expect(contentIssue({ ...content, constraints: ["x".repeat(501)] })).toEqual({
    field: "constraints",
    message:
      "Limits to work within: keep each line to 500 characters or fewer.",
  });
});

it("saves a changed description and agency before retrying an existing draft", async () => {
  const prior = {
    draftId: "draft",
    rowVersion: 3,
    rawNeed: "Old need",
    organizationId: "old-agency",
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(prior))
    .mockResolvedValueOnce(Response.json({ ...prior, rowVersion: 4 }));
  vi.stubGlobal("fetch", fetcher);
  await saveStartDraft(
    { draftId: "draft", rawNeed: "Changed need", organizationId: "new-agency" },
    "creation-key",
  );
  expect(fetcher.mock.calls[1][0]).toBe("/api/drafts");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    draftId: "draft",
    expectedRowVersion: 3,
    rawNeed: "Changed need",
    organizationId: "new-agency",
  });
});

it("does not rewrite an unchanged draft before assistance", async () => {
  const values = {
    draftId: "draft",
    rawNeed: "Need",
    organizationId: "agency",
  };
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ ...values, rowVersion: 5 }));
  vi.stubGlobal("fetch", fetcher);
  expect((await saveStartDraft(values, "creation-key")).rowVersion).toBe(5);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("manual fallback preserves the requester words and does not invent requirements", () => {
  const content = completeContent(
    { requirements: ["Offline", null, 2] },
    "Field need",
  );
  expect(content.problem).toBe("Field need");
  expect(content.title).toBe("New request");
  expect(content.affectedPeople).toBe("");
  expect(content.requirements).toEqual(["Offline"]);
  expect(content.acceptanceCriteria).toEqual([]);
  expect(content.constraints).toEqual([]);
});

it("allows one refinement and hides suggestions when words or answers change", () => {
  const content = completeContent({}, "Original need");
  const data = {
    content,
    canPrepare: true,
    job: { status: "succeeded", current: true },
    questions: [{ questionIndex: 0, answer: null }],
    suggestion: { jobId: "job" },
  } as IntakeWorkspace;
  const values = contentValues(content);
  expect(workspaceState(data, values)).toMatchObject({
    changed: false,
    refine: false,
    suggestion: data.suggestion,
  });
  const edits = { ...values, "answer-0": "More business facts" };
  expect(workspaceState(data, edits)).toMatchObject({
    changed: true,
    refine: true,
    suggestion: null,
  });
  expect(workspaceState({ ...data, canPrepare: false }, edits)).toMatchObject({
    changed: true,
    refine: false,
    suggestion: null,
  });
  expect(
    workspaceState({ ...data, job: { ...data.job!, status: "failed" } }, edits)
      .refine,
  ).toBe(false);
  expect(primaryActionLabel(false, false)).toBe("Send request");
  expect(primaryActionLabel(false, true)).toBe("Update my request");
});

it("marks changed fields only, including a resolved unknown", () => {
  const before = completeContent({ unknowns: ["Audience"] }, "Need");
  const after = { ...before, affectedPeople: "Field teams", unknowns: [] };
  expect(refinementChanges(JSON.stringify(before), after)).toEqual([
    "affectedPeople",
    "unknowns",
  ]);
  expect(refinementChanges("not-json", after)).toEqual([]);
  expect(refinementChanges(JSON.stringify(after), after)).toEqual([]);
});

it("sends only unanswered questions, so prior answers do not fill the next round's limit", () => {
  const content = completeContent({}, "Need");
  const data = {
    content,
    canPrepare: false,
    suggestion: null,
    questions: [
      { questionIndex: 0, answer: "Already recorded" },
      { questionIndex: 1, answer: null },
    ],
  } as IntakeWorkspace;
  expect(
    workspaceState(data, {
      ...contentValues(content),
      "answer-0": "Already recorded",
      "answer-1": "Late answer",
    }).answers,
  ).toEqual([{ questionIndex: 1, answer: "Late answer" }]);
});

it("keeps requester preference distinct from reviewer routing", () => {
  expect(serviceFeedbackLabel("accepted", false)).toContain(
    "OIT decides whether",
  );
  expect(serviceFeedbackLabel("rejected", false)).toContain(
    "does not meet the need",
  );
});

it("does not ask a requester to perform the reviewer's next action", () => {
  const data = {
    status: { actionNeeded: "review_assets" },
    record: { openClarificationId: null },
    delivery: { resolution: null },
  } as RequestView;
  expect(recordNextAction(data, false)).toBe("Next: Review existing options");
  expect(recordNextAction(data, true)).toBe("OIT has the next task.");
  expect(
    recordNextAction(
      { ...data, record: { ...data.record, openClarificationId: "question" } },
      true,
    ),
  ).toBe("Answer the open clarification.");
});

it("shows an unconfirmed feedback save ahead of an already-saved request", () => {
  const request = { status: savedWorkStatus.saved };
  const failed = { status: savedWorkStatus.failed };
  const pending = { status: savedWorkStatus.queued };
  expect(visibleSaveWork(request, failed)).toBe(failed);
  expect(visibleSaveWork(request, pending)).toBe(pending);
  expect(visibleSaveWork(failed, request)).toBe(failed);
});

it("keeps every saved-work message a requester can read", () => {
  expect(savedWorkStatus.saved.message).toBe("Your draft is saved.");
  expect(savedWorkStatus.queued.message).toBe("Draft changes waiting to save…");
  expect(savedWorkStatus.saving.message).toBe("Saving your draft…");
  expect(savedWorkStatus.conflict.message).toBe(
    "A newer draft is already saved on the server. These changes were not saved over it.",
  );
  expect(savedWorkStatus.failed.message).toBe(
    "Draft save could not be confirmed. Your entries remain in this open form. Retry saving before leaving.",
  );
  expect(savedWorkStatus.recovered.message).toBe(
    "Entries recovered from this browser's backup. Their server save is unconfirmed.",
  );
  expect(savedWorkStatus.loaded.message).toBe("Your saved draft has loaded.");
  expect(savedWorkStatus.idle.message).toBe("No draft changes.");
  expect(savedWorkStatus.loading.message).toBe("Loading your draft…");
  expect(savedWorkStatus.loadFailed.message).toBe(
    "Your draft could not load. Check your connection and reload to try again.",
  );
});

it("ranks a load failure and a conflict with the other save failures", () => {
  const saved = { status: savedWorkStatus.saved };
  expect(visibleSaveWork(saved, { status: savedWorkStatus.conflict })).toEqual({
    status: savedWorkStatus.conflict,
  });
  expect(
    visibleSaveWork(saved, { status: savedWorkStatus.loadFailed }),
  ).toEqual({ status: savedWorkStatus.loadFailed });
  // Recovered unsent work outranks a saved request, as the message did.
  expect(visibleSaveWork(saved, { status: savedWorkStatus.recovered })).toEqual(
    {
      status: savedWorkStatus.recovered,
    },
  );
  // A quiet load note never displaces a saved request.
  expect(visibleSaveWork(saved, { status: savedWorkStatus.loaded })).toEqual({
    status: savedWorkStatus.saved,
  });
});

const workspaceData = {
  draft: { draftId: "draft-1", rowVersion: 4 },
  job: { jobId: "job-1" },
  content: {},
  suggestion: { jobId: "job-1" },
} as unknown as Parameters<typeof intakeBase>[0]["data"];

const savedValues = (values: Record<string, string>) =>
  ({ values }) as unknown as Parameters<typeof intakeBase>[0]["requestDraft"];

const answers = [
  { questionIndex: 0, answer: "  kept  " },
  { questionIndex: 1, answer: "   " },
];

it("sends the preparation payload without a rating, key or suggestion", () => {
  expect(
    intakeBase({
      data: workspaceData,
      requestDraft: savedValues({ _recordVersion: "4" }),
      content: { problem: "need" } as never,
      answers,
    }),
  ).toEqual({
    draftId: "draft-1",
    expectedRowVersion: 4,
    content: { problem: "need" },
    answers: [{ questionIndex: 0, answer: "  kept  " }],
    jobId: "job-1",
  });
});

it("sends the chosen key on submission, not whatever the draft holds", () => {
  const input = submissionInput({
    data: workspaceData,
    requestDraft: savedValues({ _recordVersion: "4" }),
    submissionDraft: savedValues({
      rating: "5",
      idempotencyKey: "stale-key",
      _suggestionJob: "job-1",
      suggestionDecision: "accepted",
      suggestionReason: "",
    }),
    content: { problem: "need" } as never,
    answers,
    suggestion: { jobId: "job-1" } as never,
    idempotencyKey: "chosen-key",
  });
  expect(input.idempotencyKey).toBe("chosen-key");
  expect(input.rating).toBe(5);
  expect(input.suggestionJobId).toBe("job-1");
  expect(input.suggestionDecision).toBe("accepted");
  // An empty reason is sent as undefined rather than as an empty string.
  expect(input.suggestionReason).toBeUndefined();
});

it("omits the suggestion when the draft answers a different job", () => {
  const input = submissionInput({
    data: workspaceData,
    requestDraft: savedValues({ _recordVersion: "4" }),
    submissionDraft: savedValues({ rating: "3", _suggestionJob: "job-0" }),
    content: {} as never,
    answers: [],
    suggestion: { jobId: "job-1" } as never,
    idempotencyKey: "chosen-key",
  });
  expect("suggestionJobId" in input).toBe(false);
  expect(input.rating).toBe(3);
});

it("closes review editing once a first review finishes or a delivery resolves", () => {
  const open = {
    delivery: { resolution: null },
    record: { stage: "in_review" },
  } as unknown as Parameters<typeof firstReviewOpen>[0];
  expect(firstReviewOpen(open)).toBe(true);
  expect(
    firstReviewOpen({
      ...open,
      record: { stage: "first_review_completed" },
    } as typeof open),
  ).toBe(false);
  expect(
    firstReviewOpen({
      ...open,
      delivery: { resolution: "fulfilled" },
    } as unknown as typeof open),
  ).toBe(false);
});

it("treats a queued or leased job as still pending, and nothing else", () => {
  expect(jobPending("queued")).toBe(true);
  expect(jobPending("leased")).toBe(true);
  for (const status of ["succeeded", "failed", "capped", undefined])
    expect(jobPending(status)).toBe(false);
});

it("ignores concurrency and navigation keys when comparing edits", () => {
  const base = { problem: "same", _recordVersion: "4", _step: "2" };
  expect(
    sameEditableValues(base, {
      ...base,
      _recordVersion: "9",
      _step: "0",
    }),
  ).toBe(true);
  // Suggestion and snapshot metadata still count as edits.
  expect(sameEditableValues(base, { ...base, _suggestionJob: "job-1" })).toBe(
    false,
  );
  expect(sameEditableValues(base, { ...base, _previousContent: "{}" })).toBe(
    false,
  );
  expect(sameEditableValues(base, { ...base, problem: "changed" })).toBe(false);
});

it("returns no refinement changes when the snapshot cannot be decoded", () => {
  const current = completeContent({ problem: "now" }, "");
  expect(refinementChanges("not json", current)).toEqual([]);
  expect(refinementChanges("null", current)).toEqual([]);
  // A decodable snapshot is compared even when it holds no fields, which is
  // how an empty older draft reports every field as newly filled in.
  expect(refinementChanges("{}", current)).toContain("problem");
});

it("keeps the requester wording distinct from the reviewer history wording", () => {
  expect(requesterContentLabels).toEqual({
    title: "Request title",
    problem: "Problem to solve",
    affectedPeople: "Who is affected",
    acceptanceCriteria: "What must be achieved",
    requirements: "What the solution must do",
    constraints: "Limits to work within",
    unknowns: "Still unknown",
  });
});

it("asks about the requester's work, never about an internal draft binding", () => {
  const data = {
    questions: [
      {
        turnId: "t1",
        questionIndex: 0,
        question: "Which teams use it?",
        answer: null,
      },
    ],
  } as unknown as IntakeWorkspace;
  const form = {
    requestDraft: { values: {}, change: () => {} },
  } as unknown as Parameters<typeof IntakeQuestions>[0]["form"];
  const markup = renderToStaticMarkup(
    createElement(IntakeQuestions, { data, form }),
  );
  expect(markup).toContain("About your work");
  // A binding rename must never reach rendered copy.
  expect(markup).not.toMatch(/requestDraft|submissionDraft/);
});
