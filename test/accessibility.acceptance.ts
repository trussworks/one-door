import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Result } from "axe-core";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";

const requestId = "08da46a7-a463-5b17-a589-8681f9c579ba";
let cookies: Awaited<ReturnType<BrowserContext["cookies"]>>;
let observationId: string;

function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
      "best-practice",
    ])
    .analyze();
}

function findings(results: Result[]) {
  // Element HTML can contain entered credentials; retain rule IDs and locations.
  return results.map(({ id, impact, help, helpUrl, nodes }) => ({
    id,
    impact,
    help,
    helpUrl,
    targets: nodes.map((node) => node.target),
  }));
}

async function audit(page: Page, state: string) {
  await page.evaluate(() => document.fonts.ready);
  const results = await scan(page);
  const violations = findings(results.violations);
  const path = test.info().outputPath(state + "-accessibility.json");
  await writeFile(
    path,
    JSON.stringify({
      engine: results.testEngine,
      violations,
      needsReview: findings(results.incomplete),
      passedRules: results.passes.length,
    }),
    { mode: 0o600 },
  );
  await test.info().attach(state + "-accessibility", {
    path,
    contentType: "application/json",
  });
  expect.soft(violations, state).toEqual([]);
}

async function open(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), path).toBe(true);
  await expect(page.getByLabel("Choose view", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/^(Loading|Calculating)/)).toHaveCount(0);
}

async function review(page: Page) {
  await open(page, "/review/" + requestId);
  await expect(page.locator("#fit [data-claim]").first()).toBeVisible();
  await expect(page.locator("#risk [data-claim]").first()).toBeVisible();
  await expect(
    page.getByText(
      "Drafts are still loading. Wait before recording the review.",
      {
        exact: true,
      },
    ),
  ).toHaveCount(0);
}

test.beforeAll(async ({ browser }, info) => {
  const origin = new URL(info.project.use.baseURL!);
  const database = new URL(process.env.DATABASE_URL!);
  expect(["localhost", "127.0.0.1"]).toContain(origin.hostname);
  expect(origin.port).toBe("4181");
  expect(["localhost", "127.0.0.1"]).toContain(database.hostname);
  expect(database.pathname).toMatch(/^\/one_door_e2e/);
  const sql = postgres(database.href, { max: 1 });
  try {
    const [observation] =
      await sql`SELECT id FROM inventory_source_records ORDER BY id LIMIT 1`;
    observationId = observation.id;
  } finally {
    await sql.end();
  }
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
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

test("axe detects an inaccessible control and clears after its repair", async ({
  page,
}) => {
  await page.setContent(
    '<!doctype html><html lang="en"><title>Test page</title><main><h1>Test page</h1><button></button></main></html>',
  );
  expect((await scan(page)).violations.map((rule) => rule.id)).toContain(
    "button-name",
  );
  await page.locator("button").evaluate((button) => {
    button.textContent = "Submit";
  });
  expect((await scan(page)).violations).toEqual([]);
});

test("public landing and access-code error are accessible", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await audit(page, "landing");
  await page.goto("/my");
  await expect(page.getByLabel("Demo code")).toBeVisible();
  await audit(page, "gate");
  await page.getByLabel("Demo code").fill("invalid-code");
  await page.getByRole("button", { name: "Enter demo", exact: true }).click();
  await expect(page.locator("main .usa-alert--error")).toBeVisible();
  await audit(page, "gate-error");
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

test("administrator notes and expanded history", async ({ page }) => {
  await open(page, "/admin/requests/" + requestId + "?section=history");
  await expect(
    page.getByRole("heading", { name: "Administrator notes", exact: true }),
  ).toBeVisible();
  for (const summary of await page
    .locator("#history > details > summary")
    .all()) {
    await summary.click();
  }
  await audit(page, "expanded-administrator-history");
});

const routes = [
  ["request list", "/my"],
  ["intake form", "/new"],
  ["review queue", "/review?reviewer=all"],
  ["administrator queue", "/admin/requests?reviewer=all"],
  ["catalog", "/catalog?state=all"],
  ["catalog editor", "/catalog/new"],
  ["catalog record", "/catalog/046748b4-b5b0-55c0-a7bb-5f2fa31920b3"],
  ["inventory sources", "/sources"],
  ["source editor", "/sources/new"],
  ["source record", "/sources/0f6b2709-2d76-568f-a34b-75675a7e82b7"],
  ["source conflict", "/conflicts/31555de3-af98-5609-aac1-1a4a0fa9d632"],
  ["work item", "/work-items/2765cd78-a44b-5fb9-af23-bdf272a4d3f8"],
  ["administrator record", "/admin/requests/" + requestId],
  ["dashboard", "/dashboard?show=all"],
  ["reports", "/reports?dataset=seed"],
  ["delivery", "/review/" + requestId + "?section=delivery"],
  ["history", "/review/" + requestId + "?section=history"],
];
for (const [name, path] of routes) {
  test(name, async ({ page }) => {
    await open(page, path);
    await audit(page, name);
  });
}

test("review choices, questions, and catalog search", async ({ page }) => {
  await review(page);
  await audit(page, "review");
  const fit = page.locator("#fit [data-claim]").first();
  await fit.click();
  const panel = page.locator("#fit [data-claimpanel]");
  await expect(panel).toBeVisible();
  await audit(page, "option-open");
  await panel
    .getByRole("button", { name: "Ask about this option", exact: true })
    .click();
  await audit(page, "option-question");
  await page
    .getByRole("button", { name: "Search the catalog", exact: true })
    .click();
  await expect(
    page.getByLabel("Search products and services", { exact: true }),
  ).toBeFocused();
  await audit(page, "review-catalog");
  await page
    .getByRole("button", { name: "Return to review", exact: true })
    .click();
  await expect(fit).toHaveAttribute("aria-expanded", "true");
  await page.locator("#risk [data-claim]").first().click();
  const risk = page.locator("#risk [data-claimpanel]");
  await expect(risk).toBeVisible();
  await audit(page, "finding-open");
  await risk
    .getByRole("button", { name: "Ask about this finding", exact: true })
    .click();
  await audit(page, "finding-question");
});

test("estimate editor, coordination, and closure form", async ({ page }) => {
  await review(page);
  const reach = page.locator('#priority [data-factor="reach"]');
  await reach.locator("button[aria-expanded]").first().click();
  await reach.locator("#priority-action-reach").selectOption("replace");
  await audit(page, "estimate-replacement");
  await reach
    .getByRole("button", { name: /Ask (for|about).*estimate/ })
    .click();
  await audit(page, "estimate-question");
  await reach.locator("#priority-action-reach").selectOption("");
  await page
    .getByText("Review responsibilities (optional)", { exact: true })
    .click();
  await audit(page, "coordination");
  await page
    .getByRole("button", {
      name: "Close request without fulfillment",
      exact: true,
    })
    .click();
  await audit(page, "closure-form");
  await page
    .getByRole("button", { name: "Cancel closure", exact: true })
    .click();
});

test("source observation", async ({ page }) => {
  await open(page, "/observations/" + observationId);
  await audit(page, "observation");
});

async function browserRequest(page: Page, path: string, input?: unknown) {
  return page.evaluate(
    async ({ path, input }) => {
      const response = await fetch(
        path,
        input === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
            },
      );
      if (!response.ok) throw new Error(path + " returned " + response.status);
      return response.json();
    },
    { path, input },
  );
}

test("requester's own record", async ({ page }) => {
  await open(page, "/my");
  const metadata = await browserRequest(page, "/api/metadata");
  const draft = await browserRequest(page, "/api/drafts", {
    organizationId: metadata.organizations[0].id,
    rawNeed: "A fictional office needs records handling.",
    state: "ready",
    content: {
      title: "Accessibility test request",
      problem: "A fictional office needs records handling.",
      affectedPeople: "120 office staff",
      acceptanceCriteria: ["Staff can find their records"],
      requirements: ["Agency sign-in"],
      constraints: [],
      unknowns: [],
    },
  });
  const request = await browserRequest(page, "/api/requests", {
    draftId: draft.draftId,
    expectedRowVersion: draft.rowVersion,
    rating: 4,
    idempotencyKey: crypto.randomUUID(),
  });
  await open(page, "/request/" + request.requestId);
  await audit(page, "requester-record");
});

test("phone review with a coarse pointer", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await context.addCookies(cookies);
    const page = await context.newPage();
    await review(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    await audit(page, "phone-review");
    await page.locator("#risk [data-claim]").first().click();
    await audit(page, "phone-finding");
  } finally {
    await context.close();
  }
});

test("completion form and missing-rating error", async ({ page }) => {
  await review(page);
  await page.locator("#fit [data-claim]").first().click();
  await page
    .locator("#fit")
    .getByRole("button", { name: "Accept option", exact: true })
    .click();
  for (const claim of await page.locator("#risk [data-claim]").all()) {
    await claim.click();
    await page
      .locator("#risk [data-claimpanel]")
      .getByRole("button", { name: "Confirm finding", exact: true })
      .click();
  }
  await expect(page.getByLabel("Delivery lead", { exact: true })).toBeVisible();
  await expect(page.getByRole("radiogroup")).toBeVisible();
  await audit(page, "completion-ready");
  await page
    .getByRole("button", { name: "Complete first review", exact: true })
    .click();
  await expect(page.locator("#rating-error")).toBeVisible();
  await expect(page.getByRole("radiogroup")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await audit(page, "rating-error");
});
