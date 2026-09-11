import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { Problem, Field, SavedWorkFieldset } from "../src/ui/fields";
import { TaskRating } from "../src/ui/rating-presentation";
import { InlineChange, textChange } from "../src/ui/request-summary";
import Landing from "../src/app/page";
import { ModelWaiting } from "../src/ui/fields";
import { RequestSummary } from "../src/ui/request-summary";
import { api, prepareModel } from "../src/ui/api";
import { queueOptions, pageNumber } from "../src/server/query-options";
import { workPlan, deliveryPlanValues } from "../src/ui/review-delivery";
import { recordNavigation } from "../src/ui/request-record";
import { requestPhaseLabel } from "../src/ui/status-labels";
import { sameEditableValues } from "../src/ui/use-saved-work";
import type { RequestView } from "../src/server/request-views";
import { dashboardLink, nextOwnerLabel } from "../src/ui/dashboard";
import { reportMetrics } from "../src/server/reports";
import type { ReportMetrics } from "../src/server/reports";
import { MetricRecords } from "../src/ui/reports";
import { comparisonValue } from "../src/ui/conflict";
import { preparationNeeded } from "../src/ui/review-decisions";
import { queueRiskLabel, queueReviewer } from "../src/ui/review-queue";
import {
  simulatedClosure,
  simulatedStatusValues,
} from "../src/workflow/delivery";
import type { WorkItemView } from "../src/server/work-item";
import { workLinkLabel } from "../src/ui/work-item";
import {
  externalSystemLabels,
  isSimulatedWork,
  workClosed,
} from "../src/ui/status-labels";
import { selectedReviewSection } from "../src/ui/review-navigation";
import { catalogMatchesState } from "../src/ui/catalog";
import {
  fitClaimStatus,
  riskClaimStatus,
  fitDraftChanged,
  riskDraftChanged,
  fitDraftMissing,
  riskDraftMissing,
  assembleReviewSubmission,
  resolveAssetOutcome,
  resolveRiskOutcome,
  candidateProvenance,
  reviewClosureState,
  claimQuestionState,
  createDraftStore,
  pendingDrafts,
  failedDrafts,
  currentDraftKeys,
  fitClaimSummary,
  riskClaimText,
  fitMarker,
  riskMarker,
  completionHold,
  fitLead,
  riskLead,
} from "../src/ui/review-brief";
import { filterCatalogue } from "../src/ui/review-catalogue";
import {
  estimateProposals,
  estimateIssues,
  PriorityInvitation,
} from "../src/ui/requester-estimates";
import { queueScoreLabel } from "../src/ui/review-queue";
import {
  acceptFactorEntry,
  entryToValue,
  entryError,
  displayEstimate,
  type ReviewInputRow,
} from "../src/ui/review-input-contracts";
import {
  answerAttemptId,
  answerValueProblem,
  askKeys,
  askPayload,
  legacyAskState,
  canAnswerRow,
  earlierRiceEntries,
  priorityDecisionsFromDrafts,
  reviewedAttribution,
  factorLineValue,
  factorLineAttribution,
  factorDraftSummary,
} from "../src/ui/priority-contributions";
import type { PriorityFactorView, PriorityView } from "../src/domain/priority";
import { tableOverflow } from "../src/ui/table-scroll";
import { intakeTurnNeedsAnswer } from "../src/workflow/intake";

it("marks the rating group invalid while retaining each choice's error description", () => {
  const markup = renderToStaticMarkup(
    createElement(TaskRating, {
      value: "",
      onChange: () => {},
      invalid: true,
      onMissing: () => {},
    }),
  );
  expect(markup).toMatch(
    /<fieldset[^>]*role="radiogroup"[^>]*aria-invalid="true"/,
  );
  expect(
    markup.match(/aria-describedby="rating-hint rating-error"/g),
  ).toHaveLength(5);
  expect(markup).not.toMatch(/<input[^>]*aria-invalid/);
  expect(markup).toContain('id="rating-error"');
});

it("distinguishes legacy intake notes without hiding live imperative questions or replies", () => {
  expect(
    intakeTurnNeedsAnswer(
      { fixtureKey: "seed-note", content: "I captured the outcome." },
      false,
    ),
  ).toBe(false);
  expect(
    intakeTurnNeedsAnswer(
      { fixtureKey: "seed-question", content: "Who needs access?" },
      false,
    ),
  ).toBe(true);
  expect(
    intakeTurnNeedsAnswer(
      { fixtureKey: "seed-question", content: "Describe what you need." },
      true,
    ),
  ).toBe(true);
  expect(
    intakeTurnNeedsAnswer(
      { fixtureKey: null, content: "Describe what you need." },
      false,
    ),
  ).toBe(true);
});

it("reports only the directions with hidden table columns", () => {
  expect(tableOverflow(0, 100, 100)).toEqual({ left: false, right: false });
  expect(tableOverflow(0, 100, 200)).toEqual({ left: false, right: true });
  expect(tableOverflow(50, 100, 200)).toEqual({ left: true, right: true });
  expect(tableOverflow(100, 100, 200)).toEqual({ left: true, right: false });
  expect(tableOverflow(0.5, 100, 100.5)).toEqual({ left: false, right: false });
});

it("keeps legacy section values mapped to the current assessment", () => {
  expect(selectedReviewSection("history")).toBe("history");
  expect(selectedReviewSection("delivery")).toBe("delivery");
  for (const section of ["request", "matches", "risk", "priority", "finish"])
    expect(selectedReviewSection(section)).toBe("assessment");
  expect(selectedReviewSection("constructor")).toBe("assessment");
  expect(selectedReviewSection(null)).toBe("assessment");
});

it("finds catalog work without treating resolved conflicts or retired reviews as overdue", () => {
  const item = {
    id: "item",
    publicationState: "published" as const,
    approvalStatus: "approved" as const,
    reviewDate: "2026-09-05",
  };
  expect(catalogMatchesState(item, [], "attention", "2026-09-05")).toBe(false);
  expect(catalogMatchesState(item, [], "overdue", "2026-09-06")).toBe(true);
  expect(
    catalogMatchesState(
      { ...item, publicationState: "retired" },
      [],
      "attention",
      "2026-09-06",
    ),
  ).toBe(false);
  expect(
    catalogMatchesState(
      { ...item, publicationState: "draft" },
      [],
      "attention",
      "2026-09-05",
    ),
  ).toBe(true);
  expect(
    catalogMatchesState(
      item,
      [{ catalogItemId: "item", state: "resolved" }],
      "conflict",
      "2026-09-05",
    ),
  ).toBe(false);
  expect(
    catalogMatchesState(
      item,
      [{ catalogItemId: "item", state: "open" }],
      "attention",
      "2026-09-05",
    ),
  ).toBe(true);
  expect(catalogMatchesState(item, [], "all", "2026-09-05")).toBe(true);
});

it("keeps required work distinct from supporting work in its displayed label", () => {
  expect(workLinkLabel("required")).toBe("Required work");
  expect(workLinkLabel("supporting")).toBe("Supporting work");
  expect(workLinkLabel("delivery_work")).toBe("Delivery work");
});

it("provides a distinct landing path for each demo workflow", () => {
  const html = renderToStaticMarkup(createElement(Landing));
  for (const href of ["/my", "/review", "/dashboard"])
    expect(html).toContain('href="' + href + '"');
  for (const role of ["Requester", "Reviewer", "Administrator"])
    expect(html).toContain(role);
});

it("uses an indeterminate progress control and an automatic-result explanation", () => {
  const queued = renderToStaticMarkup(
    createElement(ModelWaiting, { status: "queued" }),
  );
  const running = renderToStaticMarkup(
    createElement(ModelWaiting, { status: "leased" }),
  );
  expect(queued).toContain("Waiting to prepare request information");
  expect(running).toContain("Preparing request information");
  expect(running).toContain(
    "Results appear here when ready, without a manual refresh.",
  );
  expect(running).toContain('role="status"');
  expect(running).toMatch(/<progress[^>]*aria-label=/);
  expect(running).not.toMatch(/<progress[^>]*value=/);
});

it("distinguishes refining a saved request from reading its first description", () => {
  for (const status of ["queued", "leased"]) {
    const html = renderToStaticMarkup(
      createElement(ModelWaiting, { status, refining: true }),
    );
    expect(html.toLowerCase()).toContain(
      status === "queued"
        ? "waiting to update request information"
        : "updating request information",
    );
    expect(html).not.toContain("Preparing request information");
  }
});

it("shows changes inline, including removals, without relying on color", () => {
  expect(textChange("Notify staff weekly.", "Notify staff daily.")).toEqual({
    prefix: "Notify staff ",
    removed: "weekly.",
    added: "daily.",
    suffix: "",
  });
  const html = renderToStaticMarkup(
    createElement(InlineChange, {
      before: "Notify staff weekly.",
      after: "Notify staff daily.",
    }),
  );
  expect(html).toMatch(/<del class="[^"]*textRemoved[^"]*">weekly\.<\/del>/);
  expect(html).toMatch(/<ins class="[^"]*textAdded[^"]*">daily\.<\/ins>/);
  expect(html).toContain("Removed: ");
  expect(html).toContain("Added: ");
  expect(
    renderToStaticMarkup(
      createElement(InlineChange, { before: "Same", after: "Same" }),
    ),
  ).toBe("Same");
  expect(
    renderToStaticMarkup(createElement(InlineChange, { after: "First draft" })),
  ).toBe("First draft");
  for (const [before, after] of [
    ["", "New"],
    ["Removed", ""],
    ["A and B", "A, B and C"],
    ["same", "same"],
  ]) {
    const parts = textChange(before, after);
    expect(parts.prefix + parts.removed + parts.suffix).toBe(before);
    expect(parts.prefix + parts.added + parts.suffix).toBe(after);
  }
});

it("groups every supplied summary fact without inventing empty-field text", () => {
  const html = renderToStaticMarkup(
    createElement(RequestSummary, {
      content: {
        title: "Need",
        problem: "Deploy",
        affectedPeople: "Analysts",
        acceptanceCriteria: ["Sign in", "Restore a backup"],
        requirements: ["A database"],
        constraints: [],
        unknowns: ["Hosting owner"],
      },
    }),
  );
  for (const fact of [
    "Deploy",
    "Analysts",
    "Sign in",
    "Restore a backup",
    "A database",
    "Hosting owner",
  ])
    expect(html).toContain(fact);
  expect(html).not.toContain("No constraints recorded");
  expect(html).toContain("<li>Restore a backup</li>");
});

it("keeps a cleared summary section visible when it is part of a marked change", () => {
  const html = renderToStaticMarkup(
    createElement(RequestSummary, {
      content: {
        title: "Need",
        problem: "Deploy",
        affectedPeople: "Analysts",
        acceptanceCriteria: [],
        requirements: [],
        constraints: [],
        unknowns: [],
      },
      changedFields: ["unknowns"],
    }),
  );
  expect(html).toContain("Still unknown");
  expect(html).toContain("Changed");
  expect(html).toContain("No current entries in this list.");
  expect(html).not.toContain("Limits to work within");
});

it("keeps reviewer scope focused and administrator return links intact", () => {
  expect(queueReviewer("all", false)).toBe("me");
  expect(queueReviewer("someone-else", false)).toBe("me");
  expect(queueReviewer("unassigned", false)).toBe("unassigned");
  expect(queueReviewer(null, true)).toBe("all");
  expect(queueReviewer("someone-else", true)).toBe("someone-else");
  expect(
    recordNavigation(false, "/admin/requests?phase=review#request-r1", null),
  ).toEqual({
    href: "/admin/requests?phase=review#request-r1",
    label: "All requests",
  });
  expect(
    recordNavigation(false, "//evil.example/admin/requests", null).href,
  ).toBe("/review?");
});

it("retains last-known work status and dates when a simulated source check fails", () => {
  const prior = {
    id: "item",
    sourceStatus: "In progress",
    syncHealth: "current",
    closedAt: null,
    sourceUpdatedAt: "2026-09-01T12:00:00Z",
    lastSynchronizedAt: "2026-09-01T13:00:00Z",
  } as WorkItemView["item"];
  const failed = simulatedStatusValues(
    prior,
    {
      workItemId: "item",
      sourceStatus: "Closed",
      closed: true,
      syncHealth: "failed",
    },
    "2026-09-05T12:00:00Z",
  );
  expect(failed).toEqual({
    sourceStatus: prior.sourceStatus,
    syncHealth: "failed",
    closedAt: null,
    sourceUpdatedAt: prior.sourceUpdatedAt,
    lastSynchronizedAt: prior.lastSynchronizedAt,
  });
  expect(
    simulatedClosure("2026-09-01T12:00:00Z", true, "2026-09-05T12:00:00Z"),
  ).toBe("2026-09-01T12:00:00Z");
});

it("keeps unknown and failed risk distinct from low severity", () => {
  const facts = {
    highestSeverity: null,
    openFindings: 0,
    missingInformation: 0,
  };
  expect(queueRiskLabel({ ...facts, status: "failed" })).toBe(
    "Assessment failed",
  );
  expect(queueRiskLabel({ ...facts, status: "unassessed" })).toBe(
    "Not assessed",
  );
  expect(
    queueRiskLabel({ ...facts, status: "assessed", missingInformation: 1 }),
  ).toBe("Information missing");
  expect(
    queueRiskLabel({ ...facts, status: "assessed", highestSeverity: "low" }),
  ).toBe("Low");
  expect(
    queueOptions(
      new URLSearchParams("risk=information_gap&order=risk"),
      "actor",
    ),
  ).toMatchObject({ risk: "information_gap", sort: "risk" });
});

it("queues current inputs instead of retrying an obsolete model job", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ status: "queued" }));
  vi.stubGlobal("fetch", fetcher);
  await prepareModel(
    { jobId: "old", current: false, status: "failed" },
    { purpose: "asset_match", draftId: "draft" },
  );
  expect(fetcher.mock.calls[0][0]).toBe("/api/models");
  fetcher.mockResolvedValue(Response.json({ status: "queued" }));
  await prepareModel(
    { jobId: "current", current: true, status: "failed" },
    { purpose: "asset_match", draftId: "draft" },
  );
  expect(fetcher.mock.calls[1][0]).toBe("/api/models/current");
});

it("shows the source ownership label separately from its normalized team mapping", () => {
  expect(
    comparisonValue(
      "ownerOrganizationId",
      { owner: "Platform Enablement", ownerOrganizationId: "cloud" },
      [{ id: "cloud", name: "Cloud Platform" }],
    ),
  ).toBe("Platform Enablement\nMapped team: Cloud Platform");
  expect(
    comparisonValue("ownerOrganizationId", { ownerOrganizationId: "cloud" }, [
      { id: "cloud", name: "Cloud Platform" },
    ]),
  ).toBe("Cloud Platform");
});

it("keeps dashboard thresholds when opening a count", () => {
  const link = dashboardLink(
    new URLSearchParams("internal=8&requester=10&show=open"),
    "resolved",
  );
  expect(link).toBe("/dashboard?internal=8&requester=10&show=resolved");
});

it("rejects reversed report dates instead of reporting an empty successful measurement", async () => {
  await expect(
    reportMetrics({ fromDate: "2026-09-05", toDate: "2026-09-04" }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

afterEach(() => vi.unstubAllGlobals());

it("restores report filters without allowing an external return destination", () => {
  expect(recordNavigation(false, null, "page=2&order=score", "r1").href).toBe(
    "/review?page=2&order=score#request-r1",
  );
  expect(recordNavigation(false, "/reports?dataset=seed", null)).toEqual({
    href: "/reports?dataset=seed",
    label: "Reports",
  });
  expect(recordNavigation(false, "https://example.org", "page=2").href).toBe(
    "/review?page=2",
  );
});

it("refreshes concurrency tokens only for unchanged editable values", () => {
  expect(
    sameEditableValues({ reach: "120", _step: "3" }, { reach: "120" }),
  ).toBe(true);
  expect(
    sameEditableValues(
      { _suggestionJob: "job", _previousContent: "saved" },
      { _suggestionJob: "", _previousContent: "" },
    ),
  ).toBe(false);
  expect(
    sameEditableValues(
      { title: "A", _recordVersion: "1" },
      { title: "A", _recordVersion: "2" },
    ),
  ).toBe(true);
  expect(
    sameEditableValues(
      { title: "My unfinished edit", _recordVersion: "1" },
      { title: "Other editor", _recordVersion: "2" },
    ),
  ).toBe(false);
  expect(
    sameEditableValues(
      { title: "A", reason: "Unfinished evidence" },
      { title: "A" },
    ),
  ).toBe(false);
});

it("names the waiting party without treating the reviewer as the requester", () => {
  const data = {
    record: { waitingOnRequester: true },
    delivery: { resolution: null },
  } as RequestView;
  expect(requestPhaseLabel(data)).toBe("Waiting for requester");
});

it("offers preparation only when an assessment needs work", () => {
  const job = { status: "succeeded", current: true } as NonNullable<
    RequestView["currentJobs"]["asset_match"]
  >;
  expect(preparationNeeded(true, false, job)).toBe(false);
  expect(preparationNeeded(true, false, null)).toBe(false);
  expect(preparationNeeded(false, false, null)).toBe(true);
  expect(preparationNeeded(true, true, job)).toBe(true);
  for (const status of ["failed", "capped", "queued", "leased"] as const)
    expect(preparationNeeded(true, false, { ...job, status })).toBe(true);
  expect(preparationNeeded(true, false, { ...job, current: false })).toBe(true);
});

it("restores structured delivery values for old WIP without replacing explicit edits", () => {
  const data = {
    review: { deliveryOwnerActorId: "person", nextTask: "Check delivery" },
  } as RequestView;
  expect(deliveryPlanValues({ nextOwner: "Old handoff note" }, data)).toEqual({
    deliveryOwnerActorId: "person",
    nextTask: "Check delivery",
  });
  expect(
    deliveryPlanValues({ deliveryOwnerActorId: "", nextTask: "" }, data),
  ).toEqual({ deliveryOwnerActorId: "", nextTask: "" });
});

it("reopens the gate when an API session expires instead of hiding a failed save", async () => {
  const events: Event[] = [];
  vi.stubGlobal("window", {
    dispatchEvent: (event: Event) => events.push(event),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "DEMO_ACCESS_REQUIRED" }), {
        status: 401,
      }),
    ),
  );
  await expect(
    api("/api/wip", { payload: "retained by the form" }),
  ).rejects.toMatchObject({ code: "DEMO_ACCESS_REQUIRED", status: 401 });
  expect(events.map((event) => event.type)).toEqual([
    "one-door-session-expired",
  ]);
});

it("sends reviewer, phase, score ordering, and pagination to the shared queue", () => {
  expect(
    queueOptions(
      new URLSearchParams("reviewer=all&phase=review&order=score&page=2"),
      "a1",
    ),
  ).toEqual({
    phase: "review",
    sort: "score",
    page: 2,
  });
  expect(queueOptions(new URLSearchParams(), "a1").assigneeActorId).toBe("a1");
  expect(pageNumber("abc")).toBe(1);
  expect(pageNumber("1.5")).toBe(1);
});

it("keeps required and supporting work separate without creating blank work items", () => {
  expect(
    workPlan({
      requiredWork: " Access setup \n\nSecurity check\n",
      supportingWork: "Guidance",
    }),
  ).toEqual([
    { title: "Access setup", relationship: "required" },
    { title: "Security check", relationship: "required" },
    { title: "Guidance", relationship: "supporting" },
  ]);
});
it("names the person responsible for the current phase instead of inventing a delivery owner", () => {
  const people = [
    { id: "reviewer", displayName: "Reviewer" },
    { id: "coordinator", displayName: "Coordinator" },
  ];
  const row = {
    phase: "review" as const,
    requesterName: "Requester",
    deliveryOwnerName: null,
    nextOwner: null,
    actionNeeded: "review_assets" as const,
    coordinatorActorId: "coordinator",
    reviewTasks: [
      {
        area: "assets" as const,
        state: "pending" as const,
        assigneeActorId: "reviewer",
        completedAt: null,
        completedAssessmentId: null,
      },
    ],
  };
  expect(nextOwnerLabel(row, people)).toBe("Reviewer");
  expect(nextOwnerLabel({ ...row, reviewTasks: [] }, people)).toBe(
    "Coordinator",
  );
  expect(nextOwnerLabel({ ...row, phase: "waiting" }, people)).toBe(
    "Requester",
  );
  expect(
    nextOwnerLabel(
      {
        ...row,
        phase: "delivery",
        deliveryOwnerName: "Delivery lead",
        nextOwner: "Legacy plan",
      },
      people,
    ),
  ).toBe("Delivery lead");
  expect(
    nextOwnerLabel(
      { ...row, phase: "approved", nextOwner: "Legacy plan" },
      people,
    ),
  ).toBe("Legacy plan");
  expect(nextOwnerLabel({ ...row, phase: "delivery" }, people)).toBe(
    "Not assigned",
  );
  expect(nextOwnerLabel({ ...row, phase: "resolved" }, people)).toBeNull();
  expect(
    nextOwnerLabel(
      { ...row, reviewTasks: [], coordinatorActorId: null },
      people,
    ),
  ).toBe("Not assigned");
});

it("keeps an error message clear of the alert icon and its action inline", () => {
  const markup = renderToStaticMarkup(
    createElement(
      Problem,
      null,
      "Could not update the results. The previous results are still shown. ",
      createElement("button", { type: "button" }, "Retry loading"),
    ),
  );
  // The slim alert draws its icon over the start of the body and clears it
  // through .usa-alert__text; without that element the first word sits under
  // the icon, which is what the reviewer saw.
  expect(markup).toContain("usa-alert--slim");
  const body = markup.slice(markup.indexOf("usa-alert__body"));
  expect(body).toContain("usa-alert__text");
  expect(
    body.indexOf("usa-alert__text"),
    "the message must be inside the text element, not a bare child of the body",
  ).toBeLessThan(body.indexOf("Could not update"));
  // The action carries the class that keeps it inline instead of filling the row.
  expect(markup).toMatch(/class="usa-alert__text [^"]*problem/);
});

it("keeps the empty detail panel for an unknown report metric", () => {
  const report = {
    reuse: { fulfilledRequestIds: [] },
    volume: {
      fulfilled: { requestIds: [] },
      submissions: { requestIds: [] },
      firstReviewsCompleted: { requestIds: [] },
    },
    closures: { requestIds: [] },
    timeToFirstReview: { records: [] },
  } as unknown as ReportMetrics;
  const markup = renderToStaticMarkup(
    createElement(MetricRecords, {
      report,
      metric: "bogus",
      index: [],
      back: "/reports",
    }),
  );
  expect(markup).toContain("No records match this measure and date range.");
});

it("treats a fixture key or a demo-minted identifier as simulated work", () => {
  expect(
    isSimulatedWork({ fixtureKey: "work:seed", externalId: "RITM1" }),
  ).toBe(true);
  expect(isSimulatedWork({ fixtureKey: null, externalId: "SIM-4" })).toBe(true);
  expect(isSimulatedWork({ fixtureKey: null, externalId: "RITM1" })).toBe(
    false,
  );
  expect(workClosed({ closedAt: null })).toBe(false);
  expect(workClosed({ closedAt: "2026-09-07T00:00:00Z" })).toBe(true);
});

it("names both simulated delivery systems in the order the select offers them", () => {
  expect(Object.entries(externalSystemLabels)).toEqual([
    ["servicenow", "ServiceNow"],
    ["azure_devops", "Azure DevOps"],
  ]);
});

it("names each claim's fate: recorded outcomes, drafts, and proposals stay distinct", () => {
  const open = { id: "c", decision: null, reason: null };
  const accepted = { id: "c", decision: "accepted", reason: null };
  const rejected = { id: "c", decision: "rejected", reason: "gap" };
  expect(fitClaimStatus(open, null)).toEqual({
    label: "Awaiting decision",
    tone: "proposed",
  });
  expect(fitClaimStatus(accepted, null)).toEqual({
    label: "Accepted",
    tone: "confirmed",
  });
  expect(fitClaimStatus(rejected, null).tone).toBe("ruled_out");
  /* A complete draft scans in its outcome's colour, still worded draft;
   * an incomplete draft keeps the neutral draft tone. */
  expect(fitClaimStatus(open, { decision: "accepted", reason: "" })).toEqual({
    label: "Draft: accepted",
    tone: "confirmed",
  });
  expect(fitClaimStatus(open, { decision: "rejected", reason: "gap" })).toEqual(
    { label: "Draft: rejected", tone: "ruled_out" },
  );
  expect(fitClaimStatus(open, { decision: "rejected", reason: "" })).toEqual({
    label: "Draft: give a reason for rejection",
    tone: "draft",
  });
  expect(
    fitClaimStatus(accepted, { decision: "accepted", reason: "" }).tone,
  ).toBe("confirmed");
});

it("treats a same-decision edit and a cleared choice as real changes", () => {
  const rejected = { id: "c", decision: "rejected", reason: "old reason" };
  expect(
    fitDraftChanged({ decision: "rejected", reason: "old reason" }, rejected),
  ).toBe(false);
  expect(
    fitDraftChanged({ decision: "rejected", reason: "new reason" }, rejected),
  ).toBe(true);
  expect(fitDraftChanged({ decision: "", reason: "" }, rejected)).toBe(true);
  expect(fitDraftMissing({ decision: "", reason: "" })).toBe(
    "Draft: choose a decision",
  );
  const overridden = {
    id: "f",
    decision: "overridden",
    finalSeverity: "high",
    decisionRationale: "why",
  };
  expect(
    riskDraftChanged(
      { decision: "overridden", severity: "high", rationale: "why" },
      overridden,
    ),
  ).toBe(false);
  expect(
    riskDraftChanged(
      { decision: "overridden", severity: "critical", rationale: "why" },
      overridden,
    ),
  ).toBe(true);
  expect(
    riskDraftChanged(
      { decision: "overridden", severity: "high", rationale: "sharper why" },
      overridden,
    ),
  ).toBe(true);
});

it("keeps risk status separate from severity and holds follow-ups open", () => {
  const finding = (decision: string | null, finalSeverity: string | null) => ({
    id: "f",
    decision,
    finalSeverity,
    decisionRationale: null,
  });
  expect(riskClaimStatus(finding("confirmed", null), null).label).toBe(
    "Confirmed",
  );
  expect(riskClaimStatus(finding("overridden", "high"), null)).toEqual({
    label: "Severity changed",
    tone: "confirmed",
  });
  expect(riskClaimStatus(finding("cleared", null), null)).toEqual({
    label: "Does not apply",
    tone: "ruled_out",
  });
  expect(riskClaimStatus(finding("follow_up_required", null), null).tone).toBe(
    "waiting",
  );
  expect(riskClaimStatus(finding(null, null), null).tone).toBe("proposed");
  /* A complete draft names the outcome it would record, marked as a draft. */
  expect(
    riskClaimStatus(finding(null, null), {
      decision: "overridden",
      severity: "critical",
      rationale: "why",
    }),
  ).toEqual({
    label: "Draft: severity changed",
    tone: "confirmed",
  });
  expect(
    riskClaimStatus(finding(null, null), {
      decision: "cleared",
      severity: "",
      rationale: "not in scope",
    }).tone,
  ).toBe("ruled_out");
  expect(
    riskClaimStatus(finding(null, null), {
      decision: "follow_up_required",
      severity: "",
      rationale: "need the basis",
    }).tone,
  ).toBe("waiting");
});

it("requires the conditional fields before a draft counts as complete", () => {
  expect(fitDraftMissing({ decision: "accepted", reason: "" })).toBeNull();
  expect(fitDraftMissing({ decision: "rejected", reason: "" })).toBe(
    "Draft: give a reason for rejection",
  );
  expect(fitDraftMissing({ decision: "rejected", reason: "gap" })).toBeNull();
  expect(
    riskDraftMissing({ decision: "confirmed", severity: "", rationale: "" }),
  ).toBeNull();
  expect(
    riskDraftMissing({ decision: "overridden", severity: "", rationale: "x" }),
  ).toBe("Draft: choose a severity");
  expect(
    riskDraftMissing({ decision: "cleared", severity: "", rationale: "" }),
  ).toBe("Draft: give a reason");
});

it("submits only changed complete drafts and counts the incomplete ones", () => {
  const drafts: Record<string, Record<string, string>> = {
    "asset:c1": { decision: "rejected", reason: "missing sealed coverage" },
    "asset:c2": { decision: "accepted", reason: "" },
    "risk:f1": { decision: "overridden", severity: "high", rationale: "worse" },
    "risk:f2": { decision: "cleared", severity: "", rationale: "" },
  };
  const result = assembleReviewSubmission(
    [
      { id: "c1", decision: null, reason: null },
      { id: "c2", decision: "accepted", reason: null },
    ],
    [
      {
        id: "f1",
        decision: "confirmed",
        finalSeverity: null,
        decisionRationale: null,
      },
      {
        id: "f2",
        decision: null,
        finalSeverity: null,
        decisionRationale: null,
      },
      {
        id: "f3",
        decision: null,
        finalSeverity: null,
        decisionRationale: null,
      },
    ],
    (kind, id) => drafts[kind + ":" + id] ?? null,
  );
  expect(result.assetDecisions).toEqual([
    {
      candidateId: "c1",
      decision: "rejected",
      reason: "missing sealed coverage",
    },
  ]);
  expect(result.riskDecisions).toEqual([
    {
      findingId: "f1",
      decision: "overridden",
      finalSeverity: "high",
      rationale: "worse",
    },
  ]);
  expect(result.incomplete).toBe(1);
});

it("records empty-list outcomes only on the reviewer's explicit affirmation", () => {
  const affirmed = (kind: string) => (k: string, id: string) =>
    k === "outcome" && id === kind ? { affirmed: "yes" } : null;
  const silent = () => null;
  expect(resolveAssetOutcome([], silent)).toBeNull();
  expect(resolveAssetOutcome([], affirmed("asset"))).toBe("no_match");
  expect(resolveRiskOutcome([], silent)).toBe(false);
  expect(resolveRiskOutcome([], affirmed("risk"))).toBe(true);
  expect(
    resolveAssetOutcome(
      [{ id: "c1", decision: "accepted", reason: null }],
      silent,
    ),
  ).toBe("accepted");
});

it("finds catalogue entries by name, vendor, or capability and keeps provenance honest", () => {
  const entries = [
    {
      id: "a",
      name: "RedactPro",
      vendor: "GovSoft",
      description: "",
      capabilities: ["sealed records workflow"],
      publicationState: "published",
      approvalStatus: "approved",
      currentVersion: 3,
    },
    {
      id: "b",
      name: "ArchiveGate",
      vendor: null,
      description: "",
      capabilities: ["retention"],
      publicationState: "published",
      approvalStatus: "approved",
      currentVersion: 1,
    },
  ];
  expect(filterCatalogue(entries, "sealed").map((entry) => entry.id)).toEqual([
    "a",
  ]);
  expect(filterCatalogue(entries, "govsoft").map((entry) => entry.id)).toEqual([
    "a",
  ]);
  expect(filterCatalogue(entries, "")).toHaveLength(2);
  expect(filterCatalogue(entries, "zzz")).toHaveLength(0);
  const nameFor = (id: string) => (id === "a9" ? "Jordan" : "Unknown");
  expect(candidateProvenance({ id: "a" }, nameFor)).toBe(
    "From prepared matching results",
  );
  expect(
    candidateProvenance({ id: "a", proposedByActorId: "a9" }, nameFor),
  ).toBe("Added for review by Jordan");
});

it("turns requester prompts into proposals: numbers adoptable, prose as basis, junk stopped", () => {
  expect(estimateProposals({})).toEqual([]);
  expect(
    estimateProposals({
      estimateBenefit: " about 120 requests a month ",
      estimateBenefitBasis: "annual report",
      estimateDelivery: "45 days quoted",
    }),
  ).toEqual([
    {
      factor: "reach",
      estimate: {
        value: null,
        basis: "about 120 requests a month — annual report",
      },
    },
    { factor: "effort", estimate: { value: null, basis: "45 days quoted" } },
  ]);
  expect(
    estimateProposals({
      estimateReachCount: "120",
      estimateReachUnit: "requests",
      estimateReachPeriod: "per month",
      estimateBenefitBasis: "annual report",
      estimateEffortDays: "45",
      estimateDelivery: "vendor quote",
      estimateConfidenceValue: "80",
    }),
  ).toEqual([
    {
      factor: "reach",
      estimate: {
        value: 120,
        basis: "annual report",
        unit: "requests",
        period: "per month",
      },
    },
    { factor: "confidence", estimate: { value: 0.8, basis: "" } },
    { factor: "effort", estimate: { value: 2.25, basis: "vendor quote" } },
  ]);
  expect(estimateIssues({ estimateReachCount: "120" })).toHaveLength(1);
  expect(estimateIssues({ estimateEffortDays: "soon" })).toHaveLength(1);
  expect(estimateIssues({ estimateConfidenceValue: "800" })).toHaveLength(1);
  expect(
    estimateIssues({
      estimateReachCount: "120",
      estimateReachUnit: "requests",
      estimateReachPeriod: "per month",
    }),
  ).toHaveLength(0);
});

it("labels a completed review without a score as pending, never as a fixed blank", () => {
  expect(
    queueScoreLabel({ score: null, stage: "first_review_completed" }),
  ).toBe("Not ranked");
  expect(queueScoreLabel({ score: null, stage: "under_review" })).toBe(
    "Not scored",
  );
  expect(
    queueScoreLabel({ score: "43.33", stage: "first_review_completed" }),
  ).toBe("43.33");
});

it("converts people's units to stored units and back for display", () => {
  for (const [months, days] of [
    [0.01, 0.2],
    [0.07, 1.4],
    [0.3, 6],
    [3, 60],
    [12.5, 250],
  ]) {
    expect(entryToValue("effort", String(days))).toBe(months);
    expect(displayEstimate("effort", { value: months, basis: "" })).toBe(
      `${months} person-months (${days} working days)`,
    );
  }
  expect((120 * 2 * 0.8) / entryToValue("effort", "60")!).toBe(64);
  expect(entryToValue("impact", "1.50")).toBe(1.5);
  expect(displayEstimate("impact", { value: 1.5, basis: "" })).toBe("1.5");
  expect(entryToValue("confidence", "80")).toBeCloseTo(0.8, 5);
  expect(entryToValue("effort", "45")).toBeCloseTo(2.25, 5);
  expect(entryToValue("reach", "120")).toBe(120);
  expect(entryToValue("effort", "")).toBeNull();
  expect(entryToValue("effort", "abc")).toBeNull();
  expect(entryToValue("confidence", "1.5")).toBeCloseTo(0.015, 10);
  expect(entryToValue("effort", "0.1")).toBeCloseTo(0.005, 10);
  expect(displayEstimate("effort", { value: 2.25, basis: "" })).toBe(
    "2.25 person-months (45 working days)",
  );
  expect(displayEstimate("confidence", { value: 0.8, basis: "" })).toBe("80%");
  expect(displayEstimate("confidence", { value: 0.015, basis: "" })).toBe(
    "1.5%",
  );
  expect(displayEstimate("confidence", { value: 0.825, basis: "" })).toBe(
    "82.5%",
  );
  expect(displayEstimate("effort", { value: 0.85, basis: "" })).toBe(
    "0.85 person-months (17 working days)",
  );
  expect(
    displayEstimate("reach", {
      value: 120,
      basis: "",
      unit: "requests",
      period: "per month",
    }),
  ).toBe("120 requests · per month");
  expect(displayEstimate("reach", { value: null, basis: "x" })).toBe(
    "No estimate",
  );
});

it("ties a question to its decision and sends the factor only for rice", () => {
  const values = {
    factor: "effort",
    question: " Which retention rule applies? ",
    scope: "",
    expertise: "records",
    addressee: "",
  };
  expect(askPayload(values, "risk", { findingId: "f-1" }, "q-1")).toEqual({
    inputRequestId: "q-1",
    area: "risk",
    audience: "internal",
    findingId: "f-1",
    question: "Which retention rule applies?",
    expertise: "records",
  });
  expect(askPayload(values, "assets", { candidateId: "c-1" }, "q-2")).toEqual({
    inputRequestId: "q-2",
    area: "assets",
    audience: "internal",
    candidateId: "c-1",
    question: "Which retention rule applies?",
    expertise: "records",
  });
  expect(askPayload(values, "rice", undefined, "q-3")).toEqual({
    inputRequestId: "q-3",
    area: "rice",
    audience: "internal",
    factor: "effort",
    question: "Which retention rule applies?",
    expertise: "records",
  });
});

it("names the recorder when someone else recorded a supplied estimate", () => {
  const names: Record<string, string> = {
    jordan: "Jordan Diaz",
    sam: "Sam Osei",
    ana: "Ana Ruiz",
  };
  const nameFor = (id: string | null) => names[id ?? ""] ?? "Unknown";
  // Old full-score row: the stored supplier did not enter it personally.
  expect(
    reviewedAttribution(
      {
        suppliedByActorId: "jordan",
        recordedByActorId: "sam",
        reviewerActorId: null,
      },
      nameFor,
    ),
  ).toBe("Supplied by Jordan Diaz · Recorded by Sam Osei");
  // Adoption: the reviewer recorded it; the reviewed-by line covers them.
  expect(
    reviewedAttribution(
      {
        suppliedByActorId: "jordan",
        recordedByActorId: "ana",
        reviewerActorId: "ana",
      },
      nameFor,
    ),
  ).toBe("Supplied by Jordan Diaz · Reviewed by Ana Ruiz");
  // All three differ: every hand is named.
  expect(
    reviewedAttribution(
      {
        suppliedByActorId: "jordan",
        recordedByActorId: "sam",
        reviewerActorId: "ana",
      },
      nameFor,
    ),
  ).toBe(
    "Supplied by Jordan Diaz · Recorded by Sam Osei · Reviewed by Ana Ruiz",
  );
  expect(
    reviewedAttribution(
      {
        suppliedByActorId: "jordan",
        recordedByActorId: "jordan",
        reviewerActorId: null,
      },
      nameFor,
    ),
  ).toBe("Supplied by Jordan Diaz");
});

it("shows only the earlier form's known fields in its own units", () => {
  expect(earlierRiceEntries(null)).toEqual([]);
  expect(earlierRiceEntries({ _recordVersion: "4", _step: "2" })).toEqual([]);
  expect(
    earlierRiceEntries({
      reach: "120",
      reachUnit: "requests",
      reachPeriod: "per month",
      confidence: "80",
      effort: "3",
      effortActorId: "0b0b0b0b-0000-0000-0000-000000000000",
      effortRationale: "The delivery lead estimated it.",
      _recordVersion: "4",
      surprise: "never shown",
      impact: 2,
    }),
  ).toEqual([
    { label: "Reach", value: "120" },
    { label: "Earlier Reach unit", value: "requests" },
    { label: "Earlier Reach period", value: "per month" },
    { label: "Confidence", value: "80%" },
    { label: "Effort", value: "3 person-months" },
    {
      label: "Explanation for earlier Effort",
      value: "The delivery lead estimated it.",
    },
  ]);
  // Unit and period are meaningful input even without a count; blanks and
  // an unresolvable attribution drop out rather than showing a raw id.
  expect(earlierRiceEntries({ reachUnit: "requests", impact: "  " })).toEqual([
    { label: "Earlier Reach unit", value: "requests" },
  ]);
  expect(
    earlierRiceEntries(
      { effortActorId: "11111111-0000-0000-0000-000000000000" },
      () => "",
    ),
  ).toEqual([]);
  expect(
    earlierRiceEntries(
      { effortActorId: "0b0b0b0b-0000-0000-0000-000000000000" },
      (id) =>
        id === "0b0b0b0b-0000-0000-0000-000000000000" ? "Devon Okafor" : "",
    ),
  ).toEqual([
    {
      label: "Person named for the earlier Effort estimate",
      value: "Devon Okafor",
    },
  ]);
});

it("keeps the attempt id for retries and mints a fresh one for a revision", () => {
  const row = (latestId: string | null, history: string[] = []) =>
    ({
      latestResponse: latestId ? { id: latestId } : null,
      responses: history.map((id) => ({ id })),
    }) as unknown as Parameters<typeof answerAttemptId>[0];
  // Reassignment edge: the stored id sits deeper in the history (asked of
  // A, then B, then A again); any recorded id means revision, fresh id.
  const reassigned = answerAttemptId(row("reply-b", ["reply-a", "reply-b"]), {
    responseId: "reply-a",
  });
  expect(reassigned).not.toBe("reply-a");
  expect(reassigned).not.toBe("reply-b");
  // A retry of an unacknowledged attempt keeps its id (idempotent replay).
  expect(answerAttemptId(row(null), { responseId: "attempt-1" })).toBe(
    "attempt-1",
  );
  expect(answerAttemptId(row("other"), { responseId: "attempt-1" })).toBe(
    "attempt-1",
  );
  // Once the stored id is the recorded latest reply, the next send is a
  // revision and must not reuse the recorded id.
  const revised = answerAttemptId(row("attempt-1"), {
    responseId: "attempt-1",
  });
  expect(revised).not.toBe("attempt-1");
  // No stored id: a fresh attempt mints one.
  expect(answerAttemptId(row(null), { responseId: "" })).toMatch(
    /[0-9a-f-]{36}/,
  );
});

it("lets the addressed person keep answering an open question after an earlier reply", () => {
  const row = (overrides: Record<string, unknown>) =>
    ({
      state: "open",
      current: true,
      assigneeActorId: null,
      latestResponse: null,
      ...overrides,
    }) as unknown as Parameters<typeof canAnswerRow>[0];
  // A replied question moves to state "answered"; the addressee can
  // still replace the reply until a decision resolves the question.
  expect(
    canAnswerRow(
      row({
        assigneeActorId: "me",
        state: "answered",
        latestResponse: { outcome: "unknown" },
      }),
      "me",
    ),
  ).toBe(true);
  expect(
    canAnswerRow(
      row({ assigneeActorId: "me", latestResponse: { outcome: "provided" } }),
      "me",
    ),
  ).toBe(true);
  // Only the named addressee answers; unassigned waits on allocation.
  expect(canAnswerRow(row({}), "me")).toBe(false);
  expect(canAnswerRow(row({ assigneeActorId: "someone-else" }), "me")).toBe(
    false,
  );
  expect(
    canAnswerRow(row({ assigneeActorId: "me", state: "resolved" }), "me"),
  ).toBe(false);
  expect(
    canAnswerRow(row({ assigneeActorId: "me", current: false }), "me"),
  ).toBe(false);
});

it("never presents a request closed before review as a completed review", () => {
  const state = (stage: string, resolved: boolean) =>
    reviewClosureState({
      record: { stage },
      delivery: { resolution: resolved ? { summary: "closed" } : null },
    } as unknown as Parameters<typeof reviewClosureState>[0]);
  expect(state("under_review", false)).toBe("open");
  expect(state("submitted", false)).toBe("open");
  expect(state("first_review_completed", false)).toBe("completed");
  expect(state("first_review_completed", true)).toBe("completed");
  expect(state("under_review", true)).toBe("closed_without_review");
  expect(state("submitted", true)).toBe("closed_without_review");
});

it("keeps reach a digits-only whole count while other factors accept decimals", () => {
  for (const junk of ["letters", "1.25", "-12", "1e3", "1.5e2", " 12"]) {
    expect(acceptFactorEntry("reach", junk)).toBe(false);
  }
  expect(acceptFactorEntry("reach", "")).toBe(true);
  expect(acceptFactorEntry("reach", "250")).toBe(true);
  expect(acceptFactorEntry("effort", "1.25")).toBe(true);
  expect(acceptFactorEntry("confidence", "82.5")).toBe(true);
  expect(acceptFactorEntry("impact", "0.25")).toBe(true);
});

it("marks no estimate field required, so the collapsed invitation never blocks the native submit", () => {
  const draft = {
    values: {},
    change: () => undefined,
  } as unknown as Parameters<typeof PriorityInvitation>[0]["draft"];
  const html = renderToStaticMarkup(
    createElement(PriorityInvitation, { draft }),
  );
  expect(html).toContain("estimateEffortDays");
  expect(html).not.toContain("required");
});

it("disables draft controls until their saved work loads", () => {
  const loading = renderToStaticMarkup(
    createElement(SavedWorkFieldset, { ready: false, children: "fields" }),
  );
  expect(loading).toContain("disabled");
  const ready = renderToStaticMarkup(
    createElement(SavedWorkFieldset, { ready: true, children: "fields" }),
  );
  expect(ready).not.toContain("disabled");
});

it("renders numeric entry fields at reading width with a decimal keyboard", () => {
  const html = renderToStaticMarkup(
    createElement(Field, {
      name: "estimateEffortDays",
      label: "If you have it in working days (optional)",
      value: "",
      onChange: () => undefined,
      inputMode: "decimal",
      narrow: true,
    }),
  );
  expect(html).toContain('inputMode="decimal"');
  expect(html).toContain("usa-input--medium");
});

it("rejects unsupported precision with an explanation, never rounding", () => {
  expect(entryError("confidence", "1.5")).toBeNull();
  expect(entryError("effort", "45")).toBeNull();
  expect(entryError("effort", "")).toBeNull();
  expect(entryError("confidence", "1.555")).toMatch(/0\.01 percent/);
  expect(entryError("effort", "0.1")).toMatch(/0\.2 days/);
  expect(entryError("effort", "8.1")).toMatch(/0\.2 days/);
  expect(entryError("reach", "120.505")).toMatch(/whole count/);
  expect(entryError("reach", "120.5")).toMatch(/whole count/);
  expect(entryError("reach", "120")).toBeNull();
  expect(estimateIssues({ estimateEffortDays: "0.1" })[0]).toMatch(/0\.2 days/);
  expect(estimateProposals({ estimateEffortDays: "0.1" })).toEqual([]);
  const row = { area: "rice", factor: "effort" } as ReviewInputRow;
  expect(
    answerValueProblem(row, { outcome: "provided", value: "0.1" }),
  ).toMatch(/0\.2 days/);
  expect(
    answerValueProblem(row, { outcome: "unknown", value: "0.1" }),
  ).toBeNull();
  const result = priorityDecisionsFromDrafts(
    {
      factors: [
        {
          factor: "effort",
          status: "missing",
          proposals: [],
          decisions: [],
          reviewed: null,
        },
      ],
      complete: false,
      scoreId: null,
      score: null,
    } as unknown as PriorityView,
    () => ({ action: "replace", value: "8.1", basis: "vendor quote" }),
  );
  expect(result.decisions).toEqual([]);
  expect(result.incomplete).toBe(1);
});

it("builds one decision per factor from complete drafts only", () => {
  const factorView = (factor: string, status: string) => ({
    factor,
    status,
    proposals: [],
    decisions: [],
    reviewed: null,
  });
  const priority = {
    factors: [
      factorView("reach", "proposed"),
      factorView("impact", "missing"),
      factorView("confidence", "missing"),
      factorView("effort", "proposed"),
    ],
    complete: false,
    scoreId: null,
    score: null,
  } as unknown as PriorityView;
  const drafts: Record<string, Record<string, string>> = {
    reach: { action: "adopt", proposalId: "p1" },
    impact: { action: "replace", value: "2", basis: "time saved per case" },
    confidence: { action: "replace", value: "80", basis: "" },
    effort: { action: "reject", reason: "scope changed" },
  };
  const result = priorityDecisionsFromDrafts(
    priority,
    (factor) => drafts[factor] ?? null,
  );
  expect(result.decisions).toEqual([
    { factor: "reach", action: "adopt", proposalId: "p1" },
    {
      factor: "impact",
      action: "replace",
      estimate: { value: 2, basis: "time saved per case" },
    },
    { factor: "effort", action: "reject", reason: "scope changed" },
  ]);
  expect(result.incomplete).toBe(1);
  expect(priorityDecisionsFromDrafts(null, () => null)).toEqual({
    decisions: [],
    incomplete: 0,
  });
});

it("derives a claim's question state from live rows: a reply calls for judgment, an unknown keeps waiting", () => {
  const row = (over: Record<string, unknown>) =>
    ({
      current: true,
      state: "open",
      candidateId: "c1",
      findingId: null,
      latestResponse: null,
      ...over,
    }) as unknown as ReviewInputRow;
  expect(claimQuestionState([], { candidateId: "c1" })).toBeNull();
  expect(claimQuestionState([row({})], { candidateId: "c1" })).toBe("waiting");
  expect(
    claimQuestionState(
      [row({ state: "answered", latestResponse: { outcome: "unknown" } })],
      { candidateId: "c1" },
    ),
  ).toBe("waiting");
  expect(
    claimQuestionState(
      [row({ state: "answered", latestResponse: { outcome: "provided" } })],
      { candidateId: "c1" },
    ),
  ).toBe("review_again");
  expect(
    claimQuestionState(
      [row({ state: "resolved", latestResponse: { outcome: "provided" } })],
      { candidateId: "c1" },
    ),
  ).toBeNull();
  expect(
    claimQuestionState([row({ current: false })], { candidateId: "c1" }),
  ).toBeNull();
  expect(claimQuestionState([row({})], { candidateId: "other" })).toBeNull();
});

it("lets a live draft outrank the question marker; an answered question calls a decided claim back", () => {
  const replied = [
    {
      current: true,
      state: "answered",
      candidateId: "c1",
      findingId: null,
      latestResponse: { outcome: "provided" },
    },
  ] as unknown as ReviewInputRow[];
  const candidate = { id: "c1", decision: "accepted", reason: null };
  expect(fitMarker(candidate, null, replied).label).toBe(
    "Answer available for review",
  );
  expect(
    fitMarker(candidate, { decision: "rejected", reason: "gap" }, replied)
      .label,
  ).toBe("Draft: rejected");
  expect(fitMarker(candidate, null, []).label).toBe("Accepted");
  const unknownRow = [
    {
      current: true,
      state: "answered",
      candidateId: null,
      findingId: "f1",
      latestResponse: { outcome: "unknown" },
    },
  ] as unknown as ReviewInputRow[];
  const finding = {
    id: "f1",
    decision: "confirmed",
    finalSeverity: null,
    decisionRationale: "why",
  };
  expect(riskMarker(finding, null, unknownRow).label).toBe(
    "Information needed",
  );
});

it("holds completion on real state and clears only what a complete draft can honestly clear", () => {
  const none = () => null;
  const data = {
    review: { blockers: ["ASSET_OUTCOME_PENDING", "RISK_CORPUS_STALE"] },
    candidates: [{ id: "c1", decision: null, reason: null }],
    findings: [],
    inputRequests: [],
  } as unknown as RequestView;
  expect(completionHold(data, null, none)).toEqual([
    {
      section: "fit",
      messages: [
        "the option choice remains open; accept one that fits, or reject every option with a reason.",
      ],
    },
    {
      section: "risk",
      messages: [
        "the assessment uses outdated source information and needs to be updated.",
      ],
    },
  ]);
  expect(
    completionHold(data, null, (kind: string, id: string) =>
      kind === "asset" && id === "c1"
        ? { decision: "rejected", reason: "gap" }
        : null,
    ),
  ).toEqual([
    {
      section: "risk",
      messages: [
        "the assessment uses outdated source information and needs to be updated.",
      ],
    },
  ]);
  const empty = {
    review: { blockers: ["ASSET_OUTCOME_PENDING"] },
    candidates: [],
    findings: [],
    inputRequests: [],
  } as unknown as RequestView;
  expect(completionHold(empty, null, none)).toEqual([
    {
      section: "fit",
      messages: [
        "the assessment found no options, and you still need to confirm that no existing option fits.",
      ],
    },
  ]);
  expect(
    completionHold(empty, null, (kind: string, id: string) =>
      kind === "outcome" && id === "asset" ? { affirmed: "yes" } : null,
    ),
  ).toEqual([]);
});

it("keeps an answered question holding completion until a fresh resolving judgment is drafted", () => {
  const asked = (outcome: string | null) =>
    ({
      review: { blockers: [] },
      candidates: [{ id: "c1", decision: "accepted", reason: null }],
      findings: [],
      inputRequests: [
        {
          area: "assets",
          current: true,
          state: "answered",
          candidateId: "c1",
          findingId: null,
          latestResponse: outcome ? { outcome } : null,
        },
      ],
    }) as unknown as RequestView;
  const freshDraft = (kind: string, id: string) =>
    kind === "asset" && id === "c1"
      ? { decision: "rejected", reason: "superseded" }
      : null;
  expect(completionHold(asked("provided"), null, () => null)).toEqual([
    {
      section: "fit",
      messages: [
        "one answer still needs review and a recorded decision based on that review.",
      ],
    },
  ]);
  expect(completionHold(asked("provided"), null, freshDraft)).toEqual([]);
  /* An unknown reply never clears through drafts. */
  expect(completionHold(asked("unknown"), null, freshDraft)).toEqual([
    {
      section: "fit",
      messages: ["one open question still needs a useful answer."],
    },
  ]);
  /* A follow-up draft is not a resolving judgment for a risk question. */
  const riskAsked = {
    review: { blockers: [] },
    candidates: [],
    findings: [
      {
        id: "f1",
        decision: null,
        finalSeverity: null,
        decisionRationale: null,
      },
    ],
    inputRequests: [
      {
        area: "risk",
        current: true,
        state: "answered",
        candidateId: null,
        findingId: "f1",
        latestResponse: { outcome: "provided" },
      },
    ],
  } as unknown as RequestView;
  expect(
    completionHold(riskAsked, null, (kind: string) =>
      kind === "risk"
        ? { decision: "follow_up_required", severity: "", rationale: "need" }
        : null,
    ),
  ).toEqual([
    {
      section: "risk",
      messages: [
        "one answer still needs review and a recorded decision based on that review.",
      ],
    },
  ]);
});

it("builds the prose enumeration leads", () => {
  expect(fitLead(1)).toBe("This review includes 1 existing option.");
  expect(fitLead(2)).toBe("This review includes 2 existing options.");
  expect(riskLead(1)).toBe("The assessment lists one policy finding.");
  expect(riskLead(3)).toBe("The assessment lists 3 policy findings.");
});

it("reads each factor as one line with a scannable, explicitly named draft", () => {
  const proposal = (over: Record<string, unknown> = {}) => ({
    id: "p1",
    current: true,
    source: "requester",
    suppliedByActorId: "a1",
    recordedByActorId: "a1",
    estimate: {
      value: 120,
      basis: "intake",
      unit: "requests",
      period: "per month",
    },
    ...over,
  });
  const view = (over: Record<string, unknown>) =>
    ({
      factor: "reach",
      status: "proposed",
      proposals: [],
      reviewed: null,
      ...over,
    }) as unknown as PriorityFactorView;
  const names: Record<string, string> = { a1: "Dana", a2: "Kim", a3: "Rae" };
  const nameFor = (id: string | null) => names[id ?? ""] ?? "Unknown";
  expect(factorLineValue(view({ status: "missing" }))).toBe("No estimate");
  expect(factorLineValue(view({ proposals: [proposal()] }))).toBe(
    "120 requests · per month (Awaiting review)",
  );
  expect(
    factorLineValue(view({ proposals: [proposal(), proposal({ id: "p2" })] })),
  ).toBe("Proposals awaiting review: 2");
  expect(factorLineValue(view({ status: "rejected" }))).toBe(
    "Proposal rejected",
  );
  const reviewed = {
    proposalId: "p1",
    suppliedByActorId: "a1",
    recordedByActorId: "a2",
    reviewerActorId: "a3",
    estimate: {
      value: 120,
      basis: "intake",
      unit: "requests",
      period: "per month",
    },
  };
  expect(factorLineValue(view({ reviewed }))).toBe("120 requests · per month");
  expect(factorLineAttribution(view({ reviewed }), nameFor)).toBe(
    "Supplied by Dana · Recorded by Kim · Reviewed by Rae",
  );
  expect(
    factorLineAttribution(view({ proposals: [proposal()] }), nameFor),
  ).toBe("Requester proposal · Supplied by Dana");
  expect(factorLineAttribution(view({}), nameFor)).toBeNull();
});

it("keeps the action and changed estimate visible in factor drafts", () => {
  expect(
    factorDraftSummary("reach", {
      action: "reject",
      reason: "Scope excludes this population.",
    }),
  ).toBe("Draft: reject proposal");
  expect(factorDraftSummary("reach", { action: "" })).toBeNull();
  expect(
    factorDraftSummary("reach", { action: "adopt", proposalId: "p1" }),
  ).toBe("Draft: adopt proposal");
  expect(factorDraftSummary("reach", { action: "adopt", proposalId: "" })).toBe(
    "Draft: choose a proposal to adopt",
  );
  expect(factorDraftSummary("reach", { action: "reject", reason: "" })).toBe(
    "Draft: give a reason for rejection",
  );
  expect(
    factorDraftSummary("effort", {
      action: "replace",
      value: "45",
      basis: "team sizing",
    }),
  ).toBe("Draft: use 2.25 person-months (45 working days)");
  expect(
    factorDraftSummary("reach", { action: "replace", value: "120", basis: "" }),
  ).toBe("Draft: estimate change incomplete or invalid");
});

it("builds inline claim text from the specific coverage or rule title, never the boilerplate rationale alone", () => {
  const generic =
    "The catalog capability covers a material part of the confirmed request.";
  expect(
    fitClaimSummary({
      rationale: generic,
      coverage: [
        "Batch redaction before release",
        "OCR confidence checks on scans",
        "Text-layer output for publication",
      ],
    }),
  ).toBe(
    "Coverage reported in preparation: Batch redaction before release; OCR confidence checks on scans; and one more requirement in the details",
  );
  expect(
    fitClaimSummary({ rationale: generic, coverage: ["Batch redaction"] }),
  ).toBe("Coverage reported in preparation: Batch redaction");
  /* With no coverage there is nothing more specific to say; the stored
   * rationale shows as-is rather than a manufactured summary. */
  expect(fitClaimSummary({ rationale: generic, coverage: [] })).toBe(generic);
  const boilerplate =
    "The rule applies to a material requirement or constraint in the confirmed request.";
  expect(
    riskClaimText({
      rationale: boilerplate,
      ruleTitle: "Distributed documents are remediated before release",
    }),
  ).toBe("Distributed documents are remediated before release");
  expect(riskClaimText({ rationale: boilerplate, ruleTitle: null })).toBe(
    boilerplate,
  );
  expect(riskClaimText({ rationale: boilerplate })).toBe(boilerplate);
  /* A substantive rationale — a condition or a negative conclusion — must
   * reach the inline claim verbatim; coverage and title stand in only for
   * the known filler. Anything else would hide the qualification behind a
   * positive summary until the claim is clicked. */
  const conditional =
    "Cannot be used until the vendor agreement covers sealed records.";
  expect(
    fitClaimSummary({
      rationale: conditional,
      coverage: ["Batch redaction before release"],
    }),
  ).toBe(conditional);
  const negative =
    "Vendor processing of sealed records is unsafe until an addendum is signed.";
  expect(
    riskClaimText({
      rationale: negative,
      ruleTitle: "Distributed documents are remediated before release",
    }),
  ).toBe(negative);
});

it("keeps the readiness sentence agreeing with the submit guard when a recorded choice is cleared", () => {
  /* The recorded acceptance cleared the blocker, so only the incomplete
   * changed draft stands between the form and a refused submit. */
  const data = {
    review: { blockers: [] },
    candidates: [{ id: "c1", decision: "accepted", reason: null }],
    findings: [],
    inputRequests: [],
  } as unknown as RequestView;
  const cleared = (kind: string, id: string) =>
    kind === "asset" && id === "c1" ? { decision: "", reason: "" } : null;
  expect(completionHold(data, null, cleared)).toEqual([
    {
      section: "fit",
      messages: [
        "unfinished option edits need to be completed or restored to their earlier values.",
      ],
    },
  ]);
  expect(completionHold(data, null, () => null)).toEqual([]);
  /* An incomplete priority draft holds completion the same way. */
  const priority = {
    complete: false,
    score: null,
    factors: [
      { factor: "reach", status: "missing", proposals: [], reviewed: null },
    ],
  } as unknown as PriorityView;
  expect(
    completionHold(data, priority, (kind: string, id: string) =>
      kind === "priority" && id === "reach"
        ? { action: "replace", value: "", basis: "" }
        : null,
    ),
  ).toEqual([
    {
      section: "priority",
      messages: [
        "one estimate draft is incomplete; finish it or restore its earlier values.",
      ],
    },
  ]);
});

it("requires every current owner before submission and ignores retired owners", () => {
  const store = createDraftStore();
  const required = new Set(["asset:c1", "priority:reach"]);
  expect(pendingDrafts(store.registry, required)).toBe(2);
  store.register("risk", "retired", {}, { ready: false, failed: true });
  expect(pendingDrafts(store.registry, required)).toBe(2);
  expect(failedDrafts(store.registry, required)).toBe(0);
  store.register("asset", "c1", {}, { ready: true });
  expect(pendingDrafts(store.registry, required)).toBe(1);
  store.register("priority", "reach", {}, { ready: false, failed: true });
  expect(pendingDrafts(store.registry, required)).toBe(1);
  expect(failedDrafts(store.registry, required)).toBe(1);
  store.register("priority", "reach", {}, { ready: true });
  expect(pendingDrafts(store.registry, required)).toBe(0);
  expect(failedDrafts(store.registry, required)).toBe(0);
});

it("tracks each draft owner's readiness so a loading owner blocks the submission boundary", () => {
  const store = createDraftStore();
  const start = store.version();
  store.register("asset", "c1", { decision: "" }, { ready: false });
  const registered = store.version();
  expect(registered).toBeGreaterThan(start);
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(1);
  /* Same values, readiness flips: the boundary must still hear about it. */
  store.register("asset", "c1", { decision: "" }, { ready: true });
  expect(store.version()).toBeGreaterThan(registered);
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(0);
  /* An identical re-registration stays quiet. */
  const settled = store.version();
  store.register("asset", "c1", { decision: "" }, { ready: true });
  expect(store.version()).toBe(settled);
  expect(
    pendingDrafts(
      new Map([
        ["a", { ready: true }],
        ["b", { ready: false }],
        ["c", { ready: false }],
      ]),
      ["a", "b", "c"],
    ),
  ).toBe(2);
});

it("holds the boundary while a loading owner's defaults would silently drop its saved draft", () => {
  /* Poincare's reproduction through the actual helpers: a factor whose
   * saved work has not loaded publishes its initial defaults, so the
   * assembly sees no draft, no incompleteness, and no hold — the
   * readiness count is the only guard against the silent omission. */
  const store = createDraftStore();
  const priority = {
    complete: false,
    score: null,
    factors: [
      { factor: "reach", status: "proposed", proposals: [], reviewed: null },
      { factor: "impact", status: "proposed", proposals: [], reviewed: null },
    ],
  } as unknown as PriorityView;
  const empty = {
    action: "",
    proposalId: "",
    value: "",
    unit: "",
    period: "",
    basis: "",
    reason: "",
  };
  /* Reach's saved draft exists server-side but has not loaded: the owner
   * publishes defaults with ready false. Impact's draft is live. */
  store.register("priority", "reach", empty, { ready: false });
  store.register(
    "priority",
    "impact",
    { ...empty, action: "replace", value: "2", basis: "time saved" },
    { ready: true },
  );
  const draftFor = (kind: string, id: string) =>
    store.registry.get(kind + ":" + id)?.values ?? null;
  const work = priorityDecisionsFromDrafts(priority, (factor) =>
    draftFor("priority", factor),
  );
  expect(work.decisions).toEqual([
    {
      factor: "impact",
      action: "replace",
      estimate: { value: 2, basis: "time saved" },
    },
  ]);
  expect(work.incomplete).toBe(0);
  const data = {
    review: { blockers: [] },
    candidates: [],
    findings: [],
    inputRequests: [],
  } as unknown as RequestView;
  expect(completionHold(data, priority, draftFor as never)).toEqual([]);
  /* Every counter reads clean, so only the readiness gate blocks. */
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(1);
  store.register("priority", "reach", empty, { ready: true });
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(0);
});

it("prunes retired owners and names failed loads at the boundary", () => {
  const store = createDraftStore();
  store.register("risk", "old-finding", { decision: "" }, { ready: false });
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(1);
  /* A refreshed assessment replaced the finding; the retired owner must
   * not hold the boundary forever. */
  const data = {
    record: { stage: "under_review" },
    delivery: { resolution: null },
    assetAssessment: { status: "succeeded" },
    riskAssessment: { status: "succeeded" },
    candidates: [{ id: "c1" }],
    findings: [{ id: "new-finding" }],
  } as unknown as RequestView;
  const keys = currentDraftKeys(data, null);
  expect(keys.has("risk:new-finding")).toBe(true);
  const registered = store.version();
  store.retain(keys);
  expect(store.version()).toBeGreaterThan(registered);
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(0);
  /* A failed owner counts as pending and as failed until it reloads. */
  store.register(
    "asset",
    "c1",
    { decision: "" },
    { ready: false, failed: true },
  );
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(1);
  expect(failedDrafts(store.registry, store.registry.keys())).toBe(1);
  const failedAt = store.version();
  store.register(
    "asset",
    "c1",
    { decision: "" },
    { ready: true, failed: false },
  );
  expect(store.version()).toBeGreaterThan(failedAt);
  expect(failedDrafts(store.registry, store.registry.keys())).toBe(0);
  /* Retaining the current set leaves current owners untouched. */
  const settled = store.version();
  store.retain(keys);
  expect(store.version()).toBe(settled);
});

it("retires empty-outcome and completed-review owners without losing active priority drafts", () => {
  const store = createDraftStore();
  const empty = {
    record: { stage: "under_review" },
    delivery: { resolution: null },
    assetAssessment: { status: "succeeded" },
    riskAssessment: { status: "succeeded" },
    candidates: [],
    findings: [],
  } as unknown as RequestView;
  const priority = {
    complete: false,
    factors: [{ factor: "reach" }],
  } as unknown as PriorityView;
  const pendingEstimate = { action: "adopt", proposalId: "reach-proposal" };
  store.register("outcome", "asset", {}, { ready: false });
  store.register("outcome", "risk", {}, { ready: false });
  store.register("priority", "reach", pendingEstimate, { ready: true });
  store.retain(currentDraftKeys(empty, priority));
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(2);

  const populated = {
    ...empty,
    candidates: [{ id: "c1" }],
    findings: [{ id: "f1" }],
  } as unknown as RequestView;
  store.register("asset", "c1", {}, { ready: true });
  store.register("risk", "f1", {}, { ready: true });
  store.retain(currentDraftKeys(populated, priority));
  expect([...store.registry.keys()].sort()).toEqual([
    "asset:c1",
    "priority:reach",
    "risk:f1",
  ]);
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(0);

  store.register("risk", "f1", {}, { ready: false });
  const completed: RequestView = {
    ...populated,
    record: { ...populated.record, stage: "first_review_completed" },
  };
  store.retain(currentDraftKeys(completed, priority));
  expect([...store.registry.keys()]).toEqual(["priority:reach"]);
  expect(store.registry.get("priority:reach")?.values).toEqual(pendingEstimate);
  expect(pendingDrafts(store.registry, store.registry.keys())).toBe(0);
  expect(
    currentDraftKeys(completed, { ...priority, complete: true }).size,
  ).toBe(0);
  expect(
    currentDraftKeys(
      {
        ...completed,
        delivery: { ...completed.delivery, resolution: {} },
      } as RequestView,
      priority,
    ).size,
  ).toBe(0);
});

it("gives every ask its own draft owner and never reuses the retired generic key", () => {
  /* Four factor forms once shared the "ask-input" key: one draft bled
   * across factors and a send could retarget a question typed for
   * another factor. Each ask now owns a distinct key and id prefix,
   * and the retired generic key is never produced — the legacy draft
   * rests untouched under it. */
  expect(askKeys(undefined, "reach")).toEqual({
    pageKey: "ask-input-reach",
    prefix: "ask-reach-",
  });
  expect(askKeys(undefined, "impact")).toEqual({
    pageKey: "ask-input-impact",
    prefix: "ask-impact-",
  });
  expect(askKeys({ candidateId: "c1" }, undefined)).toEqual({
    pageKey: "ask-input-c1",
    prefix: "ask-c1-",
  });
  expect(askKeys({ findingId: "f1" }, undefined)).toEqual({
    pageKey: "ask-input-f1",
    prefix: "ask-f1-",
  });
  const produced = [
    askKeys(undefined, "reach"),
    askKeys(undefined, "impact"),
    askKeys(undefined, "confidence"),
    askKeys(undefined, "effort"),
    askKeys({ candidateId: "c1" }, undefined),
  ];
  expect(new Set(produced.map((k) => k.pageKey)).size).toBe(produced.length);
  expect(produced.every((k) => k.pageKey !== "ask-input")).toBe(true);
});

it("reads the brief's need facts in one column while the requester keeps the grid", () => {
  const content = {
    title: "T",
    problem: "P",
    affectedPeople: "A",
    acceptanceCriteria: ["done"],
    requirements: ["req"],
    constraints: [],
    unknowns: [],
  };
  const brief = renderToStaticMarkup(
    createElement(RequestSummary, { content, singleColumn: true }),
  );
  const requester = renderToStaticMarkup(
    createElement(RequestSummary, { content }),
  );
  expect(brief).toContain("singleColumn");
  expect(requester).not.toContain("singleColumn");
});

it("recovers the legacy ask draft under its own factor, never reassigned", () => {
  expect(legacyAskState({ question: "" })).toBeNull();
  expect(legacyAskState({ factor: "reach", question: "   " })).toBeNull();
  expect(
    legacyAskState({ factor: "reach", question: "Legacy reach question?" }),
  ).toEqual({ home: "reach", known: true, storedFactor: "reach" });
  /* The old form initialized its picker to effort; a draft without a
   * stored factor keeps that original meaning. */
  expect(legacyAskState({ factor: "", question: "No factor stored?" })).toEqual(
    { home: "effort", known: true, storedFactor: "" },
  );
  /* Explicit junk is surfaced for correction, never silently relabeled. */
  expect(legacyAskState({ factor: "speed", question: "Junk factor?" })).toEqual(
    { home: "effort", known: false, storedFactor: "speed" },
  );
});

it("groups unfinished edits with the decisions in their own sections", () => {
  const data = {
    review: {
      blockers: [
        "ASSET_OUTCOME_PENDING",
        "RISK_FINDINGS_UNDECIDED",
        "RISK_OUTCOME_PENDING",
      ],
    },
    candidates: [{ id: "c1", decision: null, reason: null }],
    findings: [
      {
        id: "f1",
        decision: null,
        finalSeverity: null,
        decisionRationale: null,
      },
    ],
    inputRequests: [],
  } as unknown as RequestView;
  const needs = completionHold(
    data,
    null,
    (kind): Record<string, string> | null => {
      if (kind === "asset") return { decision: "rejected", reason: "" };
      if (kind === "risk")
        return { decision: "overridden", severity: "high", rationale: "" };
      return null;
    },
  );
  expect(needs.map((need) => need.section)).toEqual(["fit", "risk"]);
  expect(needs.map((need) => need.messages.length)).toEqual([1, 1]);
  expect(needs[0].messages[0]).toContain("unfinished edits");
  expect(needs[1].messages[0]).toContain("draft edits");
  const fitOnly = {
    ...data,
    review: { blockers: ["ASSET_OUTCOME_PENDING"] },
    findings: [],
    candidates: [
      ...data.candidates,
      { id: "c2", decision: null, reason: null },
    ],
  } as unknown as RequestView;
  expect(
    completionHold(fitOnly, null, (kind, id) =>
      kind === "asset" && id === "c1"
        ? { decision: "accepted", reason: "" }
        : null,
    ),
  ).toEqual([]);
});

it("shows preparation rather than asking for decisions on an unavailable result", () => {
  const data = {
    review: {
      blockers: [
        "ASSET_ASSESSMENT_MISSING",
        "ASSET_OUTCOME_PENDING",
        "RISK_CORPUS_STALE",
        "RISK_RULE_RETIRED",
      ],
    },
    candidates: [],
    findings: [],
    inputRequests: [
      {
        area: "assets",
        current: true,
        state: "open",
        candidateId: null,
        findingId: null,
        latestResponse: null,
      },
    ],
  } as unknown as RequestView;
  expect(completionHold(data, null, () => null)).toEqual([
    { section: "fit", messages: ["a current assessment is still needed."] },
    {
      section: "risk",
      messages: [
        "a cited policy rule has been retired, so the assessment needs to be updated.",
      ],
    },
  ]);
});

it("describes the question once when a finding is already waiting on that question", () => {
  const data = {
    review: { blockers: ["RISK_FOLLOW_UP_OPEN"] },
    candidates: [],
    findings: [
      {
        id: "f1",
        decision: "follow_up_required",
        finalSeverity: null,
        decisionRationale: "Need evidence",
      },
    ],
    inputRequests: [
      {
        area: "risk",
        current: true,
        state: "answered",
        candidateId: null,
        findingId: "f1",
        latestResponse: { outcome: "unknown" },
      },
    ],
  } as unknown as RequestView;
  expect(completionHold(data, null, () => null)).toEqual([
    {
      section: "risk",
      messages: ["one open question still needs a useful answer."],
    },
  ]);
  data.inputRequests[0].latestResponse!.outcome = "provided";
  expect(completionHold(data, null, () => null)).toEqual([
    {
      section: "risk",
      messages: [
        "one answer still needs review and a recorded decision based on that review.",
      ],
    },
  ]);
  expect(
    completionHold(data, null, (kind) =>
      kind === "risk"
        ? {
            decision: "confirmed",
            rationale: "Evidence reviewed",
            severity: "",
          }
        : null,
    ),
  ).toEqual([]);
});

it("keeps untouched missing priority estimates out of completion work", () => {
  const data = {
    review: { blockers: [] },
    candidates: [],
    findings: [],
    inputRequests: [],
  } as unknown as RequestView;
  const priority = {
    complete: false,
    score: null,
    factors: [
      { factor: "reach", status: "missing", proposals: [], reviewed: null },
    ],
  } as unknown as PriorityView;
  expect(completionHold(data, priority, () => null)).toEqual([]);
  expect(
    completionHold(data, priority, (kind) =>
      kind === "priority" ? { action: "replace", value: "2", basis: "" } : null,
    ).map((need) => need.section),
  ).toEqual(["priority"]);
});
