import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import postgres from "postgres";

import type { RequestView } from "../src/server/request-views.ts";
import type { PriorityFactor } from "../src/domain/priority.ts";

type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
interface Person {
  context: BrowserContext;
  page: Page;
  actorId: string;
  visitorId: string;
}
let requester: Person;
let reviewer: Person;
let sql: ReturnType<typeof postgres>;
let requestFailures: Record<string, unknown>[] = [];

test.beforeAll(async ({ browser }, info) => {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (
    !databaseUrl ||
    !new URL(databaseUrl).pathname.startsWith("/one_door_e2e")
  ) {
    throw new Error(
      "Contribution browser checks require an isolated E2E_DATABASE_URL.",
    );
  }
  const baseURL = String(info.project.use.baseURL);
  if (
    !["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname) ||
    new URL(baseURL).port !== "4181"
  ) {
    throw new Error(
      "Contribution browser checks use the local browser-test server on4181.",
    );
  }
  process.env.DATABASE_URL = databaseUrl;
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const key = createHash("sha256")
    .update(baseURL + databaseUrl + (process.env.SESSION_SECRET ?? ""))
    .digest("hex")
    .slice(0, 20);
  const directory = join(
    process.cwd(),
    ".harness",
    "reviewer-contribution-auth",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, key + ".json");
  const saved = await savedCookies(path);
  requester = await authenticate(browser, baseURL, saved?.requester);
  reviewer = await authenticate(browser, baseURL, saved?.reviewer);
  expect(requester.actorId).not.toBe(reviewer.actorId);
  captureRequestFailures(requester);
  captureRequestFailures(reviewer);
  await writeFile(
    path,
    JSON.stringify({
      requester: await requester.context.cookies(),
      reviewer: await reviewer.context.cookies(),
    }),
    { mode: 0o600 },
  );
});

test.beforeEach(() => {
  requestFailures = [];
});

function requestIdentity(request: Request, person: Person) {
  const url = new URL(request.url());
  let body: Record<string, unknown> = {};
  try {
    body = request.postDataJSON() ?? {};
  } catch {
    /* GETs and aborted bodies may have no JSON. */
  }
  const input = (body.input ?? body) as Record<string, unknown>;
  return {
    method: request.method(),
    endpoint: url.pathname,
    actorId: person.actorId,
    action: body.action,
    inputKeys: Object.keys(input),
    requestId: input.requestId,
    inputRequestId: input.inputRequestId,
    responseId: input.responseId,
    expectedRowVersion: input.expectedRowVersion,
    expectedInputVersion: input.expectedInputVersion,
    pageKey: body.pageKey ?? url.searchParams.get("pageKey"),
    subjectKey: body.subjectKey ?? url.searchParams.get("subjectKey"),
  };
}

function captureRequestFailures(person: Person) {
  person.page.on("response", async (response) => {
    if (
      response.status() < 400 ||
      !new URL(response.url()).pathname.startsWith("/api/")
    )
      return;
    let error: string | undefined;
    try {
      error = (await response.json()).error;
    } catch {
      error = "Unreadable error response";
    }
    const failure = {
      ...requestIdentity(response.request(), person),
      status: response.status(),
      error,
    };
    requestFailures.push(failure);
  });
  person.page.on("requestfailed", (request) => {
    if (!new URL(request.url()).pathname.startsWith("/api/")) return;
    const failure = {
      ...requestIdentity(request, person),
      error: request.failure()?.errorText,
    };
    requestFailures.push(failure);
  });
}

async function savedCookies(
  path: string,
): Promise<{ requester: Cookies; reviewer: Cookies } | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function authenticate(
  browser: Browser,
  baseURL: string,
  cookies?: Cookies,
): Promise<Person> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
  });
  if (cookies) await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto("/my");
  const signedIn = await page.evaluate(async () => {
    const response = await fetch("/api/session");
    const body = await response.json();
    return (
      response.ok &&
      typeof body.actorId === "string" &&
      typeof body.visitorId === "string"
    );
  });
  if (!signedIn) {
    if (!process.env.DEMO_ACCESS_CODE)
      throw new Error("DEMO_ACCESS_CODE is required");
    await page.getByLabel("Demo code").fill(process.env.DEMO_ACCESS_CODE);
    await page.getByRole("button", { name: "Enter demo", exact: true }).click();
  }
  await expect(page.getByLabel("Choose view", { exact: true })).toBeVisible();
  const metadata = await read<{
    visitor: { actorId: string; visitorId: string };
  }>(page, "/api/metadata");
  return { context, page, ...metadata.visitor };
}

test.afterEach(async ({ browserName }, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach("api-failures", {
    body: Buffer.from(JSON.stringify(requestFailures, null, 2)),
    contentType: "application/json",
  });
  for (const [name, person] of Object.entries({ requester, reviewer })) {
    if (!person || person.page.isClosed()) continue;
    const path = info.outputPath(name + "-" + browserName + ".png");
    await person.page.screenshot({ path, fullPage: true });
    await info.attach(name, { path, contentType: "image/png" });
  }
});

test.afterAll(async () => {
  await Promise.all([requester?.context.close(), reviewer?.context.close()]);
  await sql?.end();
});

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await browserJson(page, path);
  expect(response.status, path).toBe(200);
  return response.body as T;
}

async function browserJson(page: Page, path: string, data?: unknown) {
  return page.evaluate(
    async ({ path, data }) => {
      const response = await fetch(
        path,
        data === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            },
      );
      return { status: response.status, body: await response.json() };
    },
    { path, data },
  );
}

const view = (requestId: string) =>
  read<RequestView>(
    reviewer.page,
    "/api/request-view/" + requestId + "?view=contributor",
  );

async function postSetup<T>(
  page: Page,
  path: string,
  data: unknown,
): Promise<T> {
  const response = await browserJson(page, path, data);
  expect(response.status, path).toBe(200);
  return response.body as T;
}

async function openDetails(details: Locator) {
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").first().click();
}

async function setExpanded(button: Locator, expanded: boolean) {
  if ((await button.getAttribute("aria-expanded")) !== String(expanded))
    await button.click();
  await expect(button).toHaveAttribute("aria-expanded", String(expanded));
}

function factorRow(page: Page, factor: PriorityFactor) {
  const label = factor[0].toUpperCase() + factor.slice(1) + ":";
  return page
    .locator("#priority > div")
    .filter({ has: page.getByText(label, { exact: true }) });
}

async function openFactor(page: Page, factor: PriorityFactor) {
  const row = factorRow(page, factor);
  await setExpanded(
    row.getByRole("button", {
      name: /^(Edit estimate|View estimate|Collapse estimate)$/,
    }),
    true,
  );
  return row;
}

function fitClaimButton(
  page: Page,
  candidate: RequestView["candidates"][number],
) {
  return page.locator('#fit button[data-claim="' + candidate.id + '"]');
}

function riskClaimButton(page: Page, finding: RequestView["findings"][number]) {
  return page.locator('#risk button[data-claim="' + finding.id + '"]');
}

async function expectInitialBrief(page: Page) {
  await expect(
    page.locator(
      "#priority input:visible, #priority select:visible, #priority textarea:visible",
    ),
  ).toHaveCount(0);
  for (const factor of ["reach", "impact", "confidence", "effort"])
    await expect(page.locator("#priority-action-" + factor)).not.toBeVisible();
  for (const control of ["#delivery-owner", "#nextTask", "#task-rating-4"])
    await expect(page.locator(control)).not.toBeVisible();
}

async function reviewPage(requestId: string, administrator = false) {
  await reviewer.page.goto(
    (administrator ? "/admin/requests/" : "/review/") + requestId,
  );
  await expect(
    reviewer.page.getByRole("heading", {
      name: "Confirmed request",
      exact: true,
    }),
  ).toBeVisible();
}

async function uiAction(
  page: Page,
  button: Locator,
  action: string,
  success = true,
) {
  await expect(button).toBeEnabled();
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/review/actions" &&
      response.request().postDataJSON()?.action === action,
  );
  await button.click();
  const response = await pending;
  const body = await response.json();
  expect(
    response.ok(),
    action + " status " + response.status() + " " + (body.error ?? ""),
  ).toBe(success);
  return body;
}

async function visitWhileDraftLoads(
  page: Page,
  requestId: string,
  pageKey: string,
  reveal: { controls: string[]; open?: () => Promise<void> },
) {
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const endpoint = (url: URL) =>
    url.pathname === "/api/wip" &&
    url.searchParams.get("pageKey") === pageKey &&
    url.searchParams.get("subjectKey") === requestId;
  await page.route(endpoint, async (route) => {
    arrived();
    await held;
    await route.continue();
  });
  try {
    await page.goto("/review/" + requestId);
    if (reveal.open) await reveal.open();
    await requested;
    for (const control of reveal.controls)
      await expect(page.locator(control)).toBeDisabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
}

async function ownDraftReadFinished(section: Locator) {
  await expect(section).toBeVisible();
  await expect(
    section.locator(".save-status").filter({
      hasText:
        /^(?:Loading your draft…|Drafts are still loading\. Wait before recording the review\.)$/,
    }),
  ).toHaveCount(0);
}

async function acknowledgeCurrent(section: Locator) {
  await ownDraftReadFinished(section);
  const confirmation = section.getByRole("button", {
    name: "Keep entries after reviewing the latest version",
    exact: true,
  });
  if (await confirmation.isVisible()) await confirmation.click();
}

async function adoptFactor(
  requestId: string,
  factor: PriorityFactor,
  proposalId: string,
) {
  const page = reviewer.page;
  const editor = await openFactor(page, factor);
  await page.locator("#priority-action-" + factor).selectOption("adopt");
  await page.locator("#priority-proposal-" + factor).selectOption(proposalId);
  await setExpanded(
    editor.getByRole("button", {
      name: /^(Edit estimate|View estimate|Collapse estimate)$/,
    }),
    false,
  );
  await expect(page.locator("#priority-action-" + factor)).not.toBeVisible();
  const unchanged = (await view(requestId)).priority.factors.find(
    (item) => item.factor === factor,
  );
  expect(unchanged?.reviewed?.proposalId).not.toBe(proposalId);
}

function adoptedDraftSaved(
  requestId: string,
  factor: PriorityFactor,
  proposalId: string,
) {
  return reviewer.page
    .waitForResponse((response) => {
      const request = response.request();
      if (
        new URL(response.url()).pathname !== "/api/wip" ||
        request.method() !== "POST"
      )
        return false;
      const data = request.postDataJSON();
      return (
        data.subjectKey === requestId &&
        data.pageKey === "priority-" + factor &&
        data.payload?.proposalId === proposalId &&
        data.payload?.action === "adopt"
      );
    })
    .then((response) => {
      expect(
        response.status(),
        "the selected proposal draft was persisted",
      ).toBe(200);
    });
}

function matchesDraftUrl(url: URL, requestId: string, pageKey: string) {
  return (
    url.pathname === "/api/wip" &&
    url.searchParams.get("subjectKey") === requestId &&
    url.searchParams.get("pageKey") === pageKey
  );
}

async function reloadWithOneFactorPending(
  requestId: string,
  options: {
    factor: PriorityFactor;
    otherFactor: PriorityFactor;
    formKey: string;
    saveLabel: string;
  },
) {
  const page = reviewer.page;
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const endpoint = (url: URL) =>
    matchesDraftUrl(url, requestId, "priority-" + options.factor);
  await page.route(endpoint, async (route) => {
    arrived();
    await held;
    await route.continue();
  });
  const other = page.waitForResponse((response) =>
    matchesDraftUrl(
      new URL(response.url()),
      requestId,
      "priority-" + options.otherFactor,
    ),
  );
  const form = page.waitForResponse((response) =>
    matchesDraftUrl(new URL(response.url()), requestId, options.formKey),
  );
  try {
    await page.reload();
    const [otherResponse, formResponse] = await Promise.all([other, form]);
    expect(otherResponse.status()).toBe(200);
    expect(formResponse.status()).toBe(200);
    await requested;
    await ownDraftReadFinished(page.locator("#completion"));
    await expect(
      page.getByRole("button", { name: options.saveLabel, exact: true }),
    ).toBeDisabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(factorRow(page, options.factor)).toContainText(
    "Draft: adopt proposal",
  );
}

async function reloadAfterFailedFactor(
  requestId: string,
  factor: PriorityFactor,
) {
  const page = reviewer.page;
  const endpoint = (url: URL) =>
    matchesDraftUrl(url, requestId, "priority-" + factor);
  let failedReads = 0;
  await page.route(
    endpoint,
    async (route) => {
      failedReads++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "REQUEST_FAILED" }),
      });
    },
    { times: 1 },
  );
  const failed = page.waitForResponse((response) =>
    endpoint(new URL(response.url())),
  );
  const other = page.waitForResponse((response) =>
    matchesDraftUrl(new URL(response.url()), requestId, "priority-impact"),
  );
  const form = page.waitForResponse((response) =>
    matchesDraftUrl(new URL(response.url()), requestId, "submit-brief"),
  );
  try {
    await page.reload();
    const [failedResponse, otherResponse, formResponse] = await Promise.all([
      failed,
      other,
      form,
    ]);
    expect(failedResponse.status()).toBe(503);
    expect(otherResponse.status()).toBe(200);
    expect(formResponse.status()).toBe(200);
    expect(failedReads).toBe(1);
    await expect(
      page
        .getByText(
          "Your draft could not load. Check your connection and reload to try again.",
          { exact: false },
        )
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Record progress", exact: true }),
    ).toBeDisabled();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.reload();
  await expect(factorRow(page, factor)).toContainText("Draft: adopt proposal");
  await expect(
    page.getByRole("button", { name: "Record progress", exact: true }),
  ).toBeEnabled();
}

async function reloadWithPostReviewFormPending(requestId: string) {
  const page = reviewer.page;
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const endpoint = (url: URL) =>
    matchesDraftUrl(url, requestId, "post-review-priority");
  await page.route(endpoint, async (route) => {
    arrived();
    await held;
    await route.continue();
  });
  const factors = ["reach", "impact", "confidence", "effort"].map((factor) =>
    page.waitForResponse((response) =>
      matchesDraftUrl(new URL(response.url()), requestId, "priority-" + factor),
    ),
  );
  try {
    await page.reload();
    const responses = await Promise.all(factors);
    for (const response of responses) expect(response.status()).toBe(200);
    await requested;
    await expect(factorRow(page, "effort")).toContainText(
      "Draft: adopt proposal",
    );
    await expect(page.locator("#completion .save-status").first()).toHaveText(
      "Loading your draft…",
    );
    await expect(
      page.getByRole("button", {
        name: "Record priority changes",
        exact: true,
      }),
    ).toBeDisabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await ownDraftReadFinished(page.locator("#completion"));
  await expect(
    page.getByRole("button", { name: "Record priority changes", exact: true }),
  ).toBeEnabled();
}

async function recordFactor(
  factor: PriorityFactor,
  value: string,
  basis: string,
) {
  const page = reviewer.page;
  const editor = await openFactor(page, factor);
  await page.locator("#priority-action-" + factor).selectOption("replace");
  await page.locator("#priority-value-" + factor).fill(value);
  await page.locator("#priority-basis-" + factor).fill(basis);
  if (factor === "reach") {
    await page.getByLabel("Unit counted", { exact: true }).fill("staff");
    await page.getByLabel("Time period", { exact: true }).fill("next quarter");
  }
  await setExpanded(
    editor.getByRole("button", {
      name: /^(Edit estimate|View estimate|Collapse estimate)$/,
    }),
    false,
  );
  await expect(page.locator("#priority-value-" + factor)).not.toBeVisible();
}

async function submitOptionalEstimates() {
  const metadata = await read<{ organizations: Array<{ id: string }> }>(
    requester.page,
    "/api/metadata",
  );
  const draft = await postSetup<{ draftId: string }>(
    requester.page,
    "/api/drafts",
    {
      organizationId: metadata.organizations[0].id,
      rawNeed: "A fictional records rollout for 120 staff.",
      state: "ready",
      content: content("Optional estimates " + randomUUID()),
    },
  );
  await requester.page.goto("/new?draft=" + draft.draftId);
  await requester.page
    .getByText("Add information for prioritization (optional)", { exact: true })
    .click();
  await requester.page
    .locator("#estimateBenefit")
    .fill("120 staff across three offices");
  await requester.page.locator("#estimateReachCount").fill("120");
  await requester.page.locator("#estimateReachUnit").fill("staff");
  await requester.page.locator("#estimateReachPeriod").fill("next quarter");
  await requester.page
    .locator("#estimateBenefitBasis")
    .fill("Current office roster");
  await requester.page
    .locator("#estimateImprovement")
    .fill("Remove duplicate records handling");
  await requester.page.locator("#estimateImpactValue").fill("2");
  await requester.page
    .locator("#estimateImprovementBasis")
    .fill("Staff time observations");
  await expect(requester.page.locator("#estimateEffortDays")).toHaveJSProperty(
    "required",
    false,
  );
  await expect(requester.page.locator("#estimateDelivery")).toHaveValue("");
  await requester.page.getByRole("radio", { name: "4", exact: true }).check();
  const sent = requester.page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/intake-workspace" &&
      response.request().postDataJSON()?.action === "submit",
  );
  await requester.page
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  const response = await sent;
  expect(response.ok()).toBe(true);
  const submitted = (await response.json()) as { requestId: string };
  return submitted.requestId;
}

test("requester estimates stay optional and become attributed proposals the reviewer adopts", async () => {
  const requestId = await submitOptionalEstimates();
  await reviewPage(requestId);
  await expectInitialBrief(reviewer.page);
  const initial = await view(requestId);
  const savedDrafts: Promise<void>[] = [];
  for (const factor of ["reach", "impact"] as const) {
    const proposal = initial.priority.factors.find(
      (item) => item.factor === factor,
    )!.proposals[0];
    expect(proposal.suppliedByActorId).toBe(requester.actorId);
    expect(proposal.source).toBe("requester");
    savedDrafts.push(adoptedDraftSaved(requestId, factor, proposal.id));
    await adoptFactor(requestId, factor, proposal.id);
  }
  await Promise.all(savedDrafts);
  await reloadWithOneFactorPending(requestId, {
    factor: "reach",
    otherFactor: "impact",
    formKey: "submit-brief",
    saveLabel: "Record progress",
  });
  await reloadAfterFailedFactor(requestId, "reach");
  await uiAction(
    reviewer.page,
    reviewer.page.getByRole("button", {
      name: "Record progress",
      exact: true,
    }),
    "submitAssessment",
  );
  const saved = await view(requestId);
  for (const factor of ["reach", "impact"] as const) {
    const reviewed = saved.priority.factors.find(
      (item) => item.factor === factor,
    )!.reviewed;
    expect(reviewed?.suppliedByActorId).toBe(requester.actorId);
    expect(reviewed?.reviewerActorId).toBe(reviewer.actorId);
  }
  expect(saved.priority.score).toBeNull();
  expect(
    saved.priority.factors.find((item) => item.factor === "effort")?.status,
  ).toBe("missing");
});

function content(title: string) {
  return {
    title,
    problem: "A fictional office needs reviewed records handling.",
    affectedPeople: "120 staff across three offices",
    acceptanceCriteria: ["Staff can complete records work once"],
    requirements: ["Agency sign-in"],
    constraints: [],
    unknowns: [],
  };
}

async function preparedRequest(title: string, risk = false) {
  const requestId = randomUUID();
  const draftId = randomUUID();
  const revisionId = randomUUID();
  const details = content(title);
  const [organization] = await sql<
    { id: string }[]
  >`SELECT id FROM organizations WHERE active LIMIT 1`;
  await sql`INSERT INTO drafts (id, visitor_id, requester_actor_id, requesting_organization_id, raw_need, structured_content, field_origins, state, current_step, submitted_at)
    VALUES (${draftId}, ${requester.visitorId}, ${requester.actorId}, ${organization.id}, ${details.problem}, ${sql.json(details)}, '{}', 'submitted', 'submitted', now())`;
  await sql`INSERT INTO requests (id, display_id, owner_visitor_id, requester_actor_id, requesting_organization_id, source_draft_id,
    routing_state, title, problem, affected_people, acceptance_criteria, requirements, constraints, unknowns, stage)
    VALUES (${requestId}, 'OD-' || nextval('request_display_id_seq'), ${requester.visitorId}, ${requester.actorId}, ${organization.id}, ${draftId},
      'routing_requested', ${title}, ${details.problem}, ${details.affectedPeople}, ${details.acceptanceCriteria}, ${details.requirements}, '{}', '{}', 'under_review')`;
  await sql`INSERT INTO request_content_revisions (id, request_id, revision_number, content, source, authored_by_actor_id, visitor_id)
    VALUES (${revisionId}, ${requestId}, 1, ${sql.json(details)}, 'submission', ${requester.actorId}, ${requester.visitorId})`;
  await sql`UPDATE requests SET current_revision_id = ${revisionId} WHERE id = ${requestId}`;
  const { collectCorpus } = await import("../src/models/corpus.ts");
  const { withDb } = await import("../src/workflow/shared.ts");
  const hashes = await withDb(async (db) => ({
    asset: (await collectCorpus(db, "asset_match")).hash,
    risk: (await collectCorpus(db, "risk_assess")).hash,
  }));
  const assetId = randomUUID();
  const riskId = randomUUID();
  await sql`INSERT INTO asset_assessments (id, draft_id, revision_id, status, catalog_corpus_hash, origin)
    VALUES (${assetId}, ${draftId}, ${revisionId}, 'succeeded', ${hashes.asset}, 'live')`;
  await sql`INSERT INTO risk_assessments (id, draft_id, revision_id, status, policy_corpus_hash, origin)
    VALUES (${riskId}, ${draftId}, ${revisionId}, 'succeeded', ${hashes.risk}, 'live')`;
  for (const [area, capability] of [
    ["assets", "review_existing_assets"],
    ["risk", "review_risk"],
    ["rice", "estimate_delivery_effort"],
  ]) {
    await sql`INSERT INTO review_tasks (id, request_id, area, responsible_capability, state)
      VALUES (${randomUUID()}, ${requestId}, ${area}, ${capability}, 'pending')`;
  }
  if (risk) await addFinding(riskId);
  return requestId;
}

async function addFinding(assessmentId: string) {
  const [rule] = await sql<
    { id: string }[]
  >`SELECT id FROM policy_rules WHERE lifecycle = 'active' LIMIT 1`;
  await sql`INSERT INTO risk_findings (id, assessment_id, policy_rule_id, kind, evidence, proposed_severity, rationale)
    VALUES (${randomUUID()}, ${assessmentId}, ${rule.id}, 'supported_risk', 'Fictional records require policy review', 'moderate', 'Check the policy application before proceeding')`;
}

async function finishDetails() {
  await reviewer.page
    .getByLabel("Delivery lead", { exact: true })
    .selectOption(reviewer.actorId);
  await reviewer.page
    .getByLabel("Next delivery task", { exact: true })
    .fill("Arrange the scoped rollout after priority is reviewed.");
  await reviewer.page.getByRole("radio", { name: "4", exact: true }).check();
}

async function askEffort(requestId: string, question: string) {
  const factor = await openFactor(reviewer.page, "effort");
  const trigger = factor.getByRole("button", {
    name: "Ask for an estimate",
    exact: true,
  });
  await setExpanded(trigger, true);
  const ask = trigger.locator("..");
  await ask.getByLabel("Question", { exact: true }).fill(question);
  await ask
    .getByLabel(
      "Expertise needed (required for internal questions without a named person)",
      { exact: true },
    )
    .fill("Delivery estimation");
  await uiAction(
    reviewer.page,
    ask.getByRole("button", {
      name: "Ask question",
      exact: true,
    }),
    "askReviewInput",
  );
  const input = (await view(requestId)).inputRequests.find(
    (row) => row.question === question,
  );
  expect(input?.assigneeActorId).toBeNull();
  return input!;
}

async function allocateThroughDashboard(requestId: string, question: string) {
  await reviewer.page
    .getByLabel("Choose view", { exact: true })
    .selectOption("administrator");
  await reviewer.page.goto("/dashboard");
  const exception = reviewer.page.locator("li").filter({ hasText: question });
  await exception.getByRole("link").click();
  await expect(reviewer.page).toHaveURL(
    new RegExp("/admin/requests/" + requestId),
  );
  const input = (await view(requestId)).inputRequests.find(
    (row) => row.question === question,
  )!;
  await expect(
    reviewer.page.locator("#assign-input-" + input.id),
  ).toBeVisible();
  await expect(
    reviewer.page.getByRole("button", {
      name: /^(Submit answer|Update answer)$/,
      exact: true,
    }),
  ).toHaveCount(0);
  await reviewer.page
    .locator("#assign-input-" + input.id)
    .selectOption(requester.actorId);
  await uiAction(
    reviewer.page,
    reviewer.page.getByRole("button", { name: "Assign question", exact: true }),
    "assignReviewInput",
  );
  await requester.page.goto("/review");
  const current = await view(requestId);
  await requester.page
    .getByRole("link", { name: current.record.content.title, exact: true })
    .click();
  await expect(requester.page).toHaveURL(new RegExp("/review/" + requestId));
  return input.id;
}

async function firstReviewEvidence(requestId: string) {
  const ratings = await sql<
    { count: number }[]
  >`SELECT count(*)::int AS count FROM task_completions WHERE request_id = ${requestId} AND task_type = 'contributor_first_review'`;
  const tasks =
    await sql`SELECT area, completed_assessment_id, completed_at FROM review_tasks WHERE request_id = ${requestId} AND area IN ('assets', 'risk') ORDER BY area`;
  return { ratings: ratings[0].count, tasks: [...tasks] };
}

async function affirmEmptyAssessments(requestId: string) {
  await expect(reviewer.page.locator("#completion")).toContainText(
    "In Existing options, the assessment found no options, and you still need to confirm that no existing option fits.",
  );
  await expect(reviewer.page.locator("#completion")).toContainText(
    "In Policy findings, the assessment reported no findings; confirm that you have checked the result.",
  );
  await expect(
    reviewer.page.getByRole("button", {
      name: "Complete first review",
      exact: true,
    }),
  ).toBeDisabled();
  expect((await view(requestId)).record.stage).toBe("under_review");
  await reviewer.page
    .getByRole("checkbox", {
      name: "I checked and found no existing option that meets the need.",
      exact: true,
    })
    .check();
  await reviewer.page
    .getByRole("checkbox", {
      name: "I checked the assessment and found no policy findings to review.",
      exact: true,
    })
    .check();
}

async function completeWithPendingPriority(requestId: string) {
  await visitWhileDraftLoads(reviewer.page, requestId, "submit-brief", {
    controls: ["#delivery-owner", "#nextTask", "#task-rating-4"],
    open: () => affirmEmptyAssessments(requestId),
  });
  await finishDetails();
  await recordFactor("reach", "120", "Confirmed staff roster");
  await recordFactor("impact", "2", "Staff time study");
  await recordFactor(
    "confidence",
    "80",
    "Evidence covers the deployment scope",
  );
  const question =
    "How many working days cover all three offices? " + randomUUID();
  await askEffort(requestId, question);
  const inputId = await allocateThroughDashboard(requestId, question);
  await reviewPage(requestId);
  const reach = await openFactor(reviewer.page, "reach");
  await expect(reviewer.page.locator("#priority-action-reach")).toHaveValue(
    "replace",
  );
  await setExpanded(
    reach.getByRole("button", {
      name: /^(Edit estimate|View estimate|Collapse estimate)$/,
    }),
    false,
  );
  await reviewer.page
    .locator("#completion")
    .getByRole("button", {
      name: "Keep entries after reviewing the latest version",
      exact: true,
    })
    .click();
  await uiAction(
    reviewer.page,
    reviewer.page.getByRole("button", {
      name: "Complete first review",
      exact: true,
    }),
    "submitAssessment",
  );
  await expect(
    reviewer.page.getByText("First review complete.", {
      exact: true,
    }),
  ).toBeVisible();
  const completed = await view(requestId);
  expect(completed.priority.score).toBeNull();
  return inputId;
}

async function answerEffort(requestId: string, inputId: string) {
  await requester.page.reload();
  await requester.page
    .locator("#answer-text-" + inputId)
    .fill("Engineering checked 40 working days for all three offices.");
  await requester.page.locator("#answer-value-" + inputId).fill("40");
  await requester.page
    .locator("#answer-basis-" + inputId)
    .fill("Current scoped engineering estimate");
  await uiAction(
    requester.page,
    requester.page.getByRole("button", {
      name: /^(Submit answer|Update answer)$/,
      exact: true,
    }),
    "answerReviewInput",
  );
  const answered = await view(requestId);
  const input = answered.inputRequests.find((row) => row.id === inputId)!;
  expect(input.latestResponse?.respondentActorId).toBe(requester.actorId);
  expect(input.state).toBe("answered");
  expect(answered.priority.score).toBeNull();
  return input.latestResponse!.contributionId!;
}

test("empty assessments need affirmation and missing priority survives review until an addressed contributor answers", async () => {
  const requestId = await preparedRequest("Pending priority " + randomUUID());
  const inputId = await completeWithPendingPriority(requestId);
  const before = await firstReviewEvidence(requestId);
  expect(before.ratings).toBe(1);
  const proposalId = await answerEffort(requestId, inputId);
  await reviewPage(requestId);
  await expect(reviewer.page.locator('input[name="rating"]')).toHaveCount(0);
  await expect(
    reviewer.page.locator('[id^="fit-decision-"], [id^="brief-risk-"]'),
  ).toHaveCount(0);
  const savedDraft = adoptedDraftSaved(requestId, "effort", proposalId);
  await adoptFactor(requestId, "effort", proposalId);
  await savedDraft;
  await reloadWithOneFactorPending(requestId, {
    factor: "effort",
    otherFactor: "impact",
    formKey: "post-review-priority",
    saveLabel: "Record priority changes",
  });
  await reloadWithPostReviewFormPending(requestId);
  await acknowledgeCurrent(reviewer.page.locator("#completion"));
  await uiAction(
    reviewer.page,
    reviewer.page.getByRole("button", {
      name: "Record priority changes",
      exact: true,
    }),
    "submitAssessment",
  );
  const final = await view(requestId);
  expect(final.priority.score).toBe(96);
  expect(final.inputRequests.find((row) => row.id === inputId)?.state).toBe(
    "resolved",
  );
  expect(await firstReviewEvidence(requestId)).toEqual(before);
});

async function addCatalogueOption(requestId: string) {
  const catalogue = await read<Array<{ id: string; name: string }>>(
    reviewer.page,
    "/api/catalog",
  );
  const item = catalogue[0];
  await reviewer.page
    .getByRole("button", { name: "Search the catalog", exact: true })
    .click();
  await expect(
    reviewer.page.getByRole("heading", {
      name: "Existing products and services",
      exact: true,
    }),
  ).toBeVisible();
  await reviewer.page
    .getByLabel("Search products and services", { exact: true })
    .fill(item.name);
  const result = reviewer.page
    .locator("details")
    .filter({ hasText: item.name })
    .first();
  await openDetails(result);
  await addCatalogResultAndReturn(result);
  const candidate = (await view(requestId)).candidates.find(
    (row) => row.catalogItemId === item.id,
  )!;
  expect(candidate.decision).toBeNull();
  expect(candidate.proposedByActorId).toBe(reviewer.actorId);
  const claim = fitClaimButton(reviewer.page, candidate);
  await expect(claim).toContainText(candidate.name);
  await expect(claim).toContainText(candidate.rationale);
  await expect(claim.locator("..")).toContainText("Awaiting decision");
  await setExpanded(claim, true);
  await reviewer.page
    .locator("#fit")
    .getByRole("button", { name: "Reject option", exact: true })
    .click();
  await reviewer.page
    .locator("#fit-reason-" + candidate.id)
    .fill("This catalogue option cannot satisfy the stated deployment need.");
  await setExpanded(claim, false);
  await expect(claim.locator("..")).toContainText("Draft: rejected");
  await expect(
    reviewer.page.locator("#fit-decision-" + candidate.id),
  ).not.toBeVisible();
  await expect(
    reviewer.page.locator("#fit-reason-" + candidate.id),
  ).not.toBeVisible();
  expect(
    (await view(requestId)).candidates.find((row) => row.id === candidate.id)
      ?.decision,
  ).toBeNull();
  return candidate.id;
}

async function addCatalogResultAndReturn(result: Locator) {
  const page = result.page();
  let delayedWrites = 0;
  const delayDraft = async (route: Route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      request.postDataJSON().pageKey === "catalogue-search"
    ) {
      delayedWrites += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  };
  await page.route("**/api/wip", delayDraft);
  try {
    await uiAction(
      page,
      result.getByRole("button", { name: "Add for review", exact: true }),
      "addReviewCandidate",
    );
    await expect(
      page.getByRole("button", { name: "Search the catalog", exact: true }),
    ).toBeFocused();
    expect(delayedWrites).toBeGreaterThan(0);
  } finally {
    await page.unroute("**/api/wip", delayDraft);
  }
}

async function askRisk(requestId: string, findingId: string, question: string) {
  const finding = (await view(requestId)).findings.find(
    (row) => row.id === findingId,
  )!;
  const claim = riskClaimButton(reviewer.page, finding);
  await setExpanded(claim, true);
  await reviewer.page
    .locator("#risk")
    .getByRole("button", { name: "Need more information", exact: true })
    .click();
  await reviewer.page
    .locator("#brief-rationale-" + findingId)
    .fill("A policy owner must confirm whether this rule applies.");
  await setExpanded(claim, false);
  await expect(
    reviewer.page.locator("#brief-risk-" + findingId),
  ).not.toBeVisible();
  await expect(
    reviewer.page.locator("#brief-rationale-" + findingId),
  ).not.toBeVisible();
  expect(
    (await view(requestId)).findings.find((row) => row.id === findingId)
      ?.decision,
  ).toBeNull();
  await acknowledgeCurrent(reviewer.page.locator("#completion"));
  const submitted = reviewer.page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/review/actions" &&
      request.postDataJSON()?.action === "submitAssessment",
  );
  await uiAction(
    reviewer.page,
    reviewer.page.getByRole("button", {
      name: "Record progress",
      exact: true,
    }),
    "submitAssessment",
  );
  const input = (await submitted).postDataJSON().input;
  expect(input.assetDecisions).toHaveLength(1);
  expect(input.assetDecisions[0].decision).toBe("rejected");
  expect(input.riskDecisions).toHaveLength(1);
  expect(input.riskDecisions[0]).toMatchObject({
    findingId,
    decision: "follow_up_required",
  });
  await setExpanded(claim, true);
  const trigger = reviewer.page.locator("#risk").getByRole("button", {
    name: "Ask about this finding",
    exact: true,
  });
  await setExpanded(trigger, true);
  const ask = trigger.locator("..");
  await ask.getByLabel("Question", { exact: true }).fill(question);
  await ask
    .getByLabel("Person to ask (optional)", { exact: true })
    .selectOption(requester.actorId);
  await acknowledgeCurrent(ask);
  await uiAction(
    reviewer.page,
    ask.getByRole("button", { name: "Ask question", exact: true }),
    "askReviewInput",
  );
  return (await view(requestId)).inputRequests.find(
    (row) => row.question === question,
  )!;
}

async function answerRisk(
  inputId: string,
  outcome: "unknown" | "provided",
  answer: string,
) {
  await requester.page
    .locator("#answer-outcome-" + inputId)
    .selectOption(outcome);
  await requester.page.locator("#answer-text-" + inputId).fill(answer);
  await uiAction(
    requester.page,
    requester.page.getByRole("button", {
      name: /^(Submit answer|Update answer)$/,
      exact: true,
    }),
    "answerReviewInput",
  );
}

async function expectCompletedClaimsReadOnly(
  requestId: string,
  candidateId: string,
  findingId: string,
) {
  await finishDetails();
  await acknowledgeCurrent(reviewer.page.locator("#completion"));
  await uiAction(
    reviewer.page,
    reviewer.page.getByRole("button", {
      name: "Complete first review",
      exact: true,
    }),
    "submitAssessment",
  );
  const completed = await view(requestId);
  expect(completed.record.stage).toBe("first_review_completed");
  const candidate = completed.candidates.find((row) => row.id === candidateId)!;
  const finding = completed.findings.find((row) => row.id === findingId)!;
  const fit = reviewer.page.locator("#fit");
  const risk = reviewer.page.locator("#risk");
  await setExpanded(fitClaimButton(reviewer.page, candidate), true);
  await expect(fit).toContainText("Rejected");
  await expect(
    fit.locator("p").filter({ hasText: candidate.reason! }),
  ).toBeVisible();
  await expect(
    reviewer.page.locator("#fit-decision-" + candidateId),
  ).toHaveCount(0);
  await expect(
    fit.getByRole("button", { name: "Reject option", exact: true }),
  ).toHaveCount(0);
  await expect(
    fit.getByRole("button", { name: "Accept option", exact: true }),
  ).toHaveCount(0);
  await setExpanded(riskClaimButton(reviewer.page, finding), true);
  await expect(risk).toContainText(finding.rule);
  await expect(risk.getByText(finding.rule, { exact: true })).toBeVisible();
  await expect(reviewer.page.locator("#brief-risk-" + findingId)).toHaveCount(
    0,
  );
  for (const name of [
    "Confirm finding",
    "Change severity",
    "Finding does not apply",
    "Need more information",
  ])
    await expect(risk.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await expect(
    reviewer.page.getByRole("button", {
      name: "Record progress",
      exact: true,
    }),
  ).toHaveCount(0);
}

async function expectRiskReply(
  requestId: string,
  finding: RequestView["findings"][number],
  answer: string,
) {
  await reviewPage(requestId);
  await setExpanded(riskClaimButton(reviewer.page, finding), true);
  await expect(reviewer.page.locator("#risk")).toContainText(answer);
}

test("manual discovery is not approval and a risk answer clears its hold only after a fresh judgment", async () => {
  const requestId = await preparedRequest(
    "Risk evidence " + randomUUID(),
    true,
  );
  await reviewPage(requestId);
  const candidateId = await addCatalogueOption(requestId);
  const finding = (await view(requestId)).findings[0];
  const findingId = finding.id;
  const question =
    "Does this policy apply to the proposed scope? " + randomUUID();
  const input = await askRisk(requestId, findingId, question);
  expect(
    (await view(requestId)).candidates.find((row) => row.id === candidateId)
      ?.decision,
  ).toBe("rejected");
  await visitWhileDraftLoads(
    requester.page,
    requestId,
    "answer-input-" + input.id,
    {
      controls: ["#answer-outcome-" + input.id, "#answer-text-" + input.id],
      open: () => setExpanded(riskClaimButton(requester.page, finding), true),
    },
  );
  await answerRisk(
    input.id,
    "unknown",
    "The policy owner needs to check the scope.",
  );
  expect((await view(requestId)).review.blockers).toContain(
    "RISK_FOLLOW_UP_OPEN",
  );
  await expectRiskReply(
    requestId,
    finding,
    "The policy owner needs to check the scope.",
  );
  await requester.page.reload();
  await setExpanded(riskClaimButton(requester.page, finding), true);
  await answerRisk(
    input.id,
    "provided",
    "The policy owner confirms the rule applies to this scope.",
  );
  const replied = await view(requestId);
  expect(replied.inputRequests.find((row) => row.id === input.id)?.state).toBe(
    "answered",
  );
  expect(replied.review.blockers).toContain("RISK_FOLLOW_UP_OPEN");
  await reviewPage(requestId);
  const claim = riskClaimButton(reviewer.page, finding);
  await setExpanded(claim, true);
  await reviewer.page
    .locator("#risk")
    .getByRole("button", { name: "Confirm finding", exact: true })
    .click();
  await reviewer.page
    .locator("#brief-rationale-" + findingId)
    .fill("Policy owner confirmed the scope in the recorded reply.");
  await acknowledgeCurrent(reviewer.page.locator("#completion"));
  await uiAction(
    reviewer.page,
    reviewer.page.getByRole("button", {
      name: "Record progress",
      exact: true,
    }),
    "submitAssessment",
  );
  const reviewed = await view(requestId);
  expect(reviewed.inputRequests.find((row) => row.id === input.id)?.state).toBe(
    "resolved",
  );
  expect(reviewed.review.blockers).not.toContain("RISK_FOLLOW_UP_OPEN");
  expect(reviewed.findings[0].decisionActorId).toBe(reviewer.actorId);
  await expectCompletedClaimsReadOnly(requestId, candidateId, findingId);
});
