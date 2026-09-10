import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Metadata } from "../src/server/metadata";
import type { RequestView } from "../src/server/request-views";

let cookies: Awaited<ReturnType<BrowserContext["cookies"]>>;

test.beforeAll(async ({ browser }, info) => {
  const url = new URL(String(info.project.use.baseURL));
  const database = new URL(process.env.E2E_DATABASE_URL ?? "https://missing");
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "4181" ||
    !database.pathname.startsWith("/one_door_e2e")
  )
    throw new Error(
      "Review boundary checks require the isolated browser server",
    );
  const context = await browser.newContext({ baseURL: url.origin });
  try {
    const page = await context.newPage();
    await page.goto("/review");
    await page.getByLabel("Demo code").fill(process.env.DEMO_ACCESS_CODE!);
    await page.getByRole("button", { name: "Enter demo", exact: true }).click();
    await expect(page.getByLabel("Choose view", { exact: true })).toBeVisible();
    cookies = await context.cookies();
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

async function json<T>(page: Page, path: string, body?: unknown): Promise<T> {
  const result = await page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(
        path,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
  expect(result.status, path + ": " + JSON.stringify(result.body)).toBe(200);
  return result.body as T;
}

async function newRequest(page: Page) {
  await page.goto("/review");
  const metadata = await json<Metadata>(page, "/api/metadata");
  const content = {
    title: "Review boundary " + randomUUID().slice(0, 8),
    problem: "Provide an approved forecasting workspace with agency sign-in.",
    affectedPeople: "Budget Office analysts",
    acceptanceCriteria: ["A saved forecast can be recovered after an outage"],
    requirements: ["Staff must use agency sign-in"],
    constraints: [
      "Only fictional aggregate data may be used in the demonstration",
    ],
    unknowns: ["The delivery team's estimate is not yet available"],
  };
  const draft = await json<{ draftId: string; rowVersion: number }>(
    page,
    "/api/drafts",
    {
      creationKey: randomUUID(),
      organizationId: metadata.organizations[0].id,
      rawNeed:
        "Original wording retained for the boundary check: " + content.problem,
      content,
      state: "ready",
    },
  );
  const request = await json<{ requestId: string }>(page, "/api/requests", {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating: 4,
    idempotencyKey: randomUUID(),
  });
  await page.goto("/review/" + request.requestId);
  await expect(page.locator("#fit [data-claim]")).toHaveCount(1);
  await expect(page.locator("#risk [data-claim]")).toHaveCount(1);
  await expect(
    page.getByText(
      /^(?:Loading your draft…|Drafts are still loading\. Wait before recording the review\.)$/,
    ),
  ).toHaveCount(0);
  return { ...request, metadata, content };
}

function view(page: Page, requestId: string) {
  return json<RequestView>(
    page,
    "/api/request-view/" + requestId + "?view=contributor",
  );
}

function history(page: Page) {
  return page.getByRole("link", { name: "Request history", exact: true });
}

async function factorAsk(page: Page, factor: "reach" | "effort") {
  const row = page.locator('#priority [data-factor="' + factor + '"]');
  const edit = row.locator("button[aria-expanded]").first();
  if ((await edit.getAttribute("aria-expanded")) !== "true") await edit.click();
  const ask = row.getByRole("button", {
    name: /Ask (for an|about this) estimate/,
  });
  if ((await ask.getAttribute("aria-expanded")) !== "true") await ask.click();
  return ask.locator("..");
}

async function fileQuestion(page: Page, form: ReturnType<Page["locator"]>) {
  const acknowledge = form.getByRole("button", {
    name: "Keep entries after reviewing the latest version",
    exact: true,
  });
  if (await acknowledge.isVisible()) await acknowledge.click();
  const sent = page.waitForResponse(
    (item) =>
      item.url().endsWith("/api/review/actions") &&
      item.request().postDataJSON()?.action === "askReviewInput",
  );
  await form.getByRole("button", { name: "Ask question", exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  return response.request().postDataJSON().input;
}

test("the prose assessment exposes request facts and retains an unsaved judgment through History", async ({
  page,
}) => {
  const request = await newRequest(page);
  await expect(
    page.getByRole("navigation", { name: "Request review sections" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Delivery", exact: true }),
  ).toHaveCount(0);
  const need = page.locator("#need");
  await expect(need.locator("details")).toHaveCount(0);
  for (const fact of [
    ...request.content.acceptanceCriteria,
    ...request.content.requirements,
    ...request.content.constraints,
    ...request.content.unknowns,
  ])
    await expect(need.getByText(fact, { exact: true })).toBeVisible();
  const data = await view(page, request.requestId);
  const riskLine = page.locator("#risk [data-claim]").locator("..");
  await expect(riskLine).not.toContainText(data.findings[0].ruleCode);
  await page.route("**/api/wip", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"UNAVAILABLE"}',
    }),
  );
  await page.locator("#fit [data-claim]").click();
  await page
    .getByRole("button", { name: "Reject option", exact: true })
    .click();
  const reason = page.getByLabel("Why does this option not fit?", {
    exact: true,
  });
  await reason.fill("This option does not provide the forecasting workflow.");
  await history(page).click();
  await expect(
    page.getByRole("heading", { name: "Request history", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(reason).toBeVisible();
  await expect(reason).toHaveValue(
    "This option does not provide the forecasting workflow.",
  );
  await history(page).click();
  await page.getByRole("link", { name: /Return to review/ }).click();
  await expect(reason).toHaveValue(
    "This option does not provide the forecasting workflow.",
  );
  expect(
    (await view(page, request.requestId)).candidates[0].decision,
  ).toBeNull();
});

test("early closure needs a reason and a deliberate send without opening delivery", async ({
  page,
}) => {
  const { requestId } = await newRequest(page);
  const close = page.getByRole("button", {
    name: "Close request without fulfillment",
    exact: true,
  });
  await close.click();
  const reason = page.getByLabel("Reason for closing without fulfillment", {
    exact: true,
  });
  const send = page.getByRole("button", {
    name: "Close without fulfillment",
    exact: true,
  });
  await expect(send).toBeDisabled();
  await reason.fill("The requester withdrew this duplicate proposal.");
  await page
    .getByRole("button", { name: "Cancel closure", exact: true })
    .click();
  expect((await view(page, requestId)).delivery.resolution).toBeNull();
  await close.click();
  await expect(reason).toHaveValue(
    "The requester withdrew this duplicate proposal.",
  );
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/api/review/actions") &&
      item.request().postDataJSON()?.action === "resolveRequest",
  );
  await send.click();
  expect((await response).status()).toBe(200);
  await expect(
    page.getByText(/closed before first review was completed/),
  ).toBeVisible();
  const closed = await view(page, requestId);
  expect(closed.record.stage).not.toBe("first_review_completed");
  expect(closed.delivery.resolution?.outcome).toBe(
    "closed_without_fulfillment",
  );
  expect(closed.delivery.resolution?.reason).toBe(
    "The requester withdrew this duplicate proposal.",
  );
  await expect(page.locator("#priority input, #priority select")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Record progress", exact: true }),
  ).toHaveCount(0);
});

async function completeJudgments(page: Page, actorId: string) {
  await page.locator("#fit [data-claim]").click();
  await page
    .getByRole("button", { name: "Accept option", exact: true })
    .click();
  await page.locator("#risk [data-claim]").click();
  await page
    .getByRole("button", { name: "Confirm finding", exact: true })
    .click();
  await page.locator("#delivery-owner").selectOption(actorId);
  await page
    .locator("#nextTask")
    .fill("Confirm the rollout scope with the program team.");
  await page.locator("#completion #task-rating-4").check();
  await page
    .getByRole("button", { name: "Complete first review", exact: true })
    .click();
  await expect(
    page.getByText("First review complete.", { exact: true }),
  ).toBeVisible();
}

test("delivery is a later action and its History reference returns to delivery while priority stays reachable", async ({
  page,
}) => {
  const { requestId, metadata } = await newRequest(page);
  await completeJudgments(page, metadata.visitor.actorId);
  const completed = await view(page, requestId);
  expect(completed.priority?.score).toBeNull();
  await expect(page.locator('#priority [data-factor="effort"]')).toBeVisible();
  await page.getByRole("link", { name: "Open delivery", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Delivery and outcome", exact: true }),
  ).toBeVisible();
  await history(page).click();
  await page.getByRole("link", { name: /Return to delivery/i }).click();
  await expect(
    page.getByRole("heading", { name: "Delivery and outcome", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Return to review/ }).click();
  await expect(
    page.getByRole("button", { name: "Record priority changes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Complete first review",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator("#priority")).toContainText(
    "incomplete and editable",
  );
  await checkMissingAndClosedPriority(page, requestId);
});

async function checkMissingAndClosedPriority(page: Page, requestId: string) {
  const path = "**/api/request-view/" + requestId + "?view=contributor";
  await page.route(path, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, priority: null } });
  });
  await page.reload();
  await expect(page.locator("#priority")).toContainText(
    "Current priority information could not load.",
  );
  await expect(page.locator("#priority")).not.toContainText("editable");
  await expect(
    page.getByRole("button", { name: "Record priority changes", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#completion")).not.toContainText(
    "You can still complete the priority estimates.",
  );
  await page.unroute(path);
  const current = await view(page, requestId);
  await json(page, "/api/review/actions", {
    action: "resolveRequest",
    input: {
      requestId,
      expectedRowVersion: current.record.rowVersion,
      outcome: "closed_without_fulfillment",
      summary: "The fictional initiative was withdrawn before prioritization.",
      reason: "No delivery work is needed.",
    },
  });
  await page.reload();
  await expect(page.locator("#priority")).toContainText("Not scored");
  await expect(page.locator("#priority")).not.toContainText("editable");
  await expect(
    page.getByRole("button", { name: "Record priority changes", exact: true }),
  ).toHaveCount(0);
}

async function checkQuestionFields(
  reach: ReturnType<Page["locator"]>,
  actorId: string,
) {
  await expect(reach.getByLabel("Question", { exact: true })).toHaveJSProperty(
    "required",
    true,
  );
  await expect(
    reach.getByLabel("Scope or assumptions (optional)", { exact: true }),
  ).toHaveJSProperty("required", false);
  const expertise = reach.getByLabel(
    "Expertise needed (required for internal questions without a named person)",
    { exact: true },
  );
  const person = reach.getByLabel("Person to ask (optional)", { exact: true });
  await expect(expertise).toHaveJSProperty("required", true);
  await person.selectOption(actorId);
  await expect(expertise).toHaveJSProperty("required", false);
  await person.selectOption("");
  await expect(expertise).toHaveJSProperty("required", true);
}

test("estimate questions retain separate drafts and cannot be sent against another factor", async ({
  page,
}) => {
  const { requestId, metadata } = await newRequest(page);
  await expect(
    page.getByRole("button", { name: /Ask (for an|about this) estimate/ }),
  ).toHaveCount(0);
  const reach = await factorAsk(page, "reach");
  await checkQuestionFields(reach, metadata.visitor.actorId);
  await reach
    .getByLabel("Question", { exact: true })
    .fill("How many staff will use the forecast workspace?");
  await reach
    .getByLabel(
      "Expertise needed (required for internal questions without a named person)",
      { exact: true },
    )
    .fill("Program operations");
  await page
    .locator(
      '#priority [data-factor="reach"] > button[aria-expanded], #priority [data-factor="reach"] button[aria-expanded]',
    )
    .first()
    .click();
  const effort = await factorAsk(page, "effort");
  await effort
    .getByLabel("Question", { exact: true })
    .fill("How many working days does the agreed rollout need?");
  await effort
    .getByLabel(
      "Expertise needed (required for internal questions without a named person)",
      { exact: true },
    )
    .fill("Delivery estimation");
  const restored = await factorAsk(page, "reach");
  await expect(restored.getByLabel("Question", { exact: true })).toHaveValue(
    "How many staff will use the forecast workspace?",
  );
  const ids = await page
    .locator(
      "#priority input[id], #priority textarea[id], #priority select[id]",
    )
    .evaluateAll((fields) => fields.map((field) => field.id));
  expect(new Set(ids).size).toBe(ids.length);
  const first = await fileQuestion(page, restored);
  expect(first.factor).toBe("reach");
  expect(first.question).toBe(
    "How many staff will use the forecast workspace?",
  );
  const remaining = await factorAsk(page, "effort");
  await expect(remaining.getByLabel("Question", { exact: true })).toHaveValue(
    "How many working days does the agreed rollout need?",
  );
  await remaining
    .getByRole("button", {
      name: "Keep entries after reviewing the latest version",
      exact: true,
    })
    .click();
  const second = await fileQuestion(page, remaining);
  expect(second.factor).toBe("effort");
  expect(second.inputRequestId).not.toBe(first.inputRequestId);
  const data = await view(page, requestId);
  expect(
    data.inputRequests.filter((row) =>
      [first.inputRequestId, second.inputRequestId].includes(row.id),
    ),
  ).toHaveLength(2);
});

test("an earlier question saved only in this browser keeps its factor and disappears after filing", async ({
  page,
}) => {
  const { requestId, metadata } = await newRequest(page);
  const data = await view(page, requestId);
  const inputRequestId = randomUUID();
  const values = {
    factor: "reach",
    question: "Which staff roster covers the planned rollout?",
    scope: "The approved rollout only",
    expertise: "Program operations",
    addressee: "",
    inputRequestId,
    _recordVersion: String(data.record.rowVersion),
  };
  await page.evaluate(
    ({ scope, values }) => {
      localStorage.setItem(
        JSON.stringify(scope),
        JSON.stringify({ values, unsent: true, rowVersion: 0 }),
      );
    },
    {
      scope: {
        visitorId: metadata.visitor.visitorId,
        actingView: "contributor",
        pageKey: "ask-input",
        subjectKey: requestId,
      },
      values,
    },
  );
  await page.reload();
  const reach = page.locator('#priority [data-factor="reach"]');
  await reach.locator("button[aria-expanded]").first().click();
  const resume = reach.getByRole("button", {
    name: "Recover your earlier unsent question",
    exact: true,
  });
  await expect(resume).toBeVisible();
  await resume.click();
  const form = resume.locator("..");
  await expect(form.getByLabel("Question", { exact: true })).toHaveValue(
    values.question,
  );
  await factorAsk(page, "effort");
  await expect(
    page.locator('#priority [data-factor="effort"]').getByRole("button", {
      name: "Recover your earlier unsent question",
      exact: true,
    }),
  ).toHaveCount(0);
  const input = await fileQuestion(page, form);
  expect(input.factor).toBe("reach");
  expect(input.inputRequestId).toBe(inputRequestId);
  expect(input.question).toBe(values.question);
  await expect(resume).toHaveCount(0);
  await page.reload();
  await page
    .locator('#priority [data-factor="reach"] button[aria-expanded]')
    .first()
    .click();
  await expect(
    page.getByRole("button", {
      name: "Recover your earlier unsent question",
      exact: true,
    }),
  ).toHaveCount(0);
});
