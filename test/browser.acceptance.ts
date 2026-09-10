import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { fieldNeed } from "./browser-model.ts";
import type { Metadata } from "../src/server/metadata";

const need =
  "Fictional build verification: the Budget Office needs to deploy its quarterly forecasting application to Colorado Azure cloud. The app uses React, Node, and PostgreSQL. Forty budget analysts need agency sign-in. It handles fictional aggregate budget totals, not personal records. Success means staff can sign in, submit and review quarterly forecasts, and restore the database from a tested backup. We need a managed environment, deployment access, monitoring, and an approved release path. We do not know which OIT service covers this.";

/* Each ordinary workflow test authenticates a FRESH visitor created
 * directly on the isolated E2E database, carrying production-shaped
 * session cookies. Two production safeguards stay untouched and honest:
 * the gate keeps its 30-attempt window (exercised for real by the
 * landing walk below, the only UI login), and the 20-per-visitor daily
 * model-call quota (models/jobs.ts) keeps one visitor per test. */
async function enter(page: Page) {
  const database = process.env.DATABASE_URL ?? "";
  const parsed = database ? new URL(database) : null;
  if (
    !parsed ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !parsed.pathname.startsWith("/one_door_e2e")
  )
    throw new Error(
      "Refusing direct visitor creation outside the isolated one_door_e2e database",
    );
  const { createVisitor } = await import("../src/workflow/requester.ts");
  const { setSessionCookies } = await import("../src/server/auth.ts");
  const { visitorId } = await createVisitor();
  const response = new Response(null);
  setSessionCookies(response, visitorId);
  const origin = new URL(process.env.E2E_BASE_URL || "http://127.0.0.1:4181");
  if (
    !["127.0.0.1", "localhost"].includes(origin.hostname) ||
    origin.port !== "4181"
  )
    throw new Error(
      "Refusing to install session cookies outside the local browser-test server on 4181",
    );
  await page.context().addCookies(
    response.headers.getSetCookie().map((header) => {
      const [pair, ...attributes] = header.split("; ");
      const equals = pair.indexOf("=");
      const maxAge = attributes
        .find((attribute) => attribute.startsWith("Max-Age="))
        ?.slice("Max-Age=".length);
      return {
        name: pair.slice(0, equals),
        value: pair.slice(equals + 1),
        domain: origin.hostname,
        path: "/",
        httpOnly: true,
        secure: attributes.includes("Secure"),
        sameSite: "Lax" as const,
        expires: Math.floor(Date.now() / 1000) + Number(maxAge ?? 28800),
      };
    }),
  );
  await page.goto("/my");
  await expect(
    page.getByRole("heading", { name: "My requests", exact: true }),
  ).toBeVisible();
}

async function browserMetadata(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/metadata");
    if (!response.ok)
      throw new Error("Browser metadata returned " + response.status);
    return response.json();
  });
}

async function checkQueuePeople(page: Page) {
  const personCell = page.locator("tbody tr").first().locator("td").nth(1);
  await expect(personCell).toBeVisible();
  const queue = await page.evaluate(async () =>
    (await fetch("/api/queue?reviewer=me&sort=waiting&dir=desc")).json(),
  );
  expect(
    await personCell.evaluate((cell) => cell.firstChild?.textContent),
  ).toBe(queue.rows[0].requesterName);
  await expect(personCell.locator("span")).toHaveText(
    queue.rows[0].organizationName,
  );
}

test("landing routes every role, keeps reviewer scope focused, and preserves the administrator queue", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Find the right help",
  );
  await page
    .getByRole("link", { name: "Open my requests", exact: true })
    .click();
  await page.getByLabel("Demo code").fill(process.env.DEMO_ACCESS_CODE!);
  await page.getByRole("button", { name: "Enter demo", exact: true }).click();
  await expect(page).toHaveURL(/\/my$/);
  await expect(
    page.getByRole("heading", { name: "My requests", exact: true }),
  ).toBeVisible();
  await page.goto("/");
  await page
    .getByRole("link", { name: "Open my review queue", exact: true })
    .click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(
    page.getByRole("navigation", { name: "Request views" }).getByRole("link"),
  ).toHaveText(["Assigned to me", "Needs a coordinator"]);
  await Promise.all([
    expect(page.locator("tbody tr").first()).toBeVisible(),
    expect(
      page.getByText(/This demo queue includes fictional example requests/),
    ).toContainText("Elena Castellanos"),
    expect(page.locator("tbody")).toContainText(
      "Unresolved information gaps: 1",
    ),
    checkQueuePeople(page),
  ]);
  await page
    .getByRole("link", { name: "Needs a coordinator", exact: true })
    .click();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  const filterWidths = await page
    .locator(".queue-filters select")
    .evaluateAll((elements) =>
      elements.map((e) => e.getBoundingClientRect().width),
    );
  expect(Math.max(...filterWidths) - Math.min(...filterWidths)).toBeLessThan(1);
  await checkAdministratorQueue(page);
});

async function checkAdministratorQueue(page: Page) {
  await page.goto("/");
  await page
    .getByRole("link", { name: "Open administrator dashboard", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "All requests", exact: true })
    .click();
  await expect(page.getByLabel("Assigned reviewer")).toHaveValue("all");
  await expect(
    page.getByRole("navigation", { name: "Request list pages" }),
  ).toHaveCount(0);
  await expect(page.locator('div[aria-busy="true"]')).toHaveCount(0);
  const rowLink = page.locator("tbody tr").first().getByRole("link").first();
  const href = await rowLink.getAttribute("href");
  await rowLink.click();
  await expect(page).toHaveURL(new RegExp("/admin/requests/"));
  await page
    .locator(".breadcrumb")
    .getByRole("link", { name: "All requests", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/requests#request-/);
  await expect(
    page.locator("tbody tr").first().getByRole("link").first(),
  ).toHaveAttribute("href", href!);
  await checkReportAlignment(page);
}

test("one visible wait leads to one saved record without requester match menus", async ({
  page,
}) => {
  await enter(page);
  await beginAssistance(page, "Slow demonstration: " + need);
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ has: page.getByRole("progressbar") }),
  ).toContainText("without a manual refresh");
  await expect(
    page.getByRole("heading", { name: "Your request", exact: true }),
  ).toBeVisible({ timeout: 120000 });
  await expect(
    page.getByRole("region", { name: "Your request", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Your request", exact: true }),
  ).toBeFocused();
  await expect(
    page.locator(
      '#requester-assets, section[aria-labelledby="suggestion-heading"]',
    ),
  ).toHaveCount(0);
  await expect(page.getByText(/governed publishing layer/)).toHaveCount(0);
  const before = await intakeWorkspace(page);
  expect(before.callsUsed).toBe(1);
  await page.reload();
  expect((await intakeWorkspace(page)).callsUsed).toBe(1);
  await checkRatingError(page);
  const result = await submitRequest(page);
  await expect(page.locator("#requester-fit-feedback, #assets")).toHaveCount(0);
  await page.goto("/review/" + result.requestId);
  expect(await fitTextWithEvidence(page)).toContain(
    "governed publishing layer",
  );
});

test("queue and catalog headings sort every row and preserve keyboard and return context", async ({
  page,
}) => {
  await enter(page);
  await page.goto("/admin/requests");
  const heading = page.getByRole("button", {
    name: "Sort by Request",
    exact: true,
  });
  await heading.focus();
  await heading.press("Enter");
  await expect(page).toHaveURL(/sort=title&dir=asc/);
  const queue = await browserRead(page, "/api/queue?reviewer=all");
  expect(queue.total).toBeGreaterThan(20);
  await expect(page.locator("tbody tr")).toHaveCount(queue.total);
  await expect(page.locator('th[aria-sort="ascending"]')).toContainText(
    "Request",
  );
  await expect(heading).toBeFocused();
  await assertTitleOrder(page, "asc");
  await heading.press("Enter");
  await expect(page).toHaveURL(/sort=title&dir=desc/);
  await assertTitleOrder(page, "desc");
  await expect(
    page.getByRole("navigation", { name: "Request list pages" }),
  ).toHaveCount(0);
  await expect(page.locator('div[aria-busy="true"]')).toHaveCount(0);
  const link = page.locator("tbody tr").first().getByRole("link").first();
  const href = await link.getAttribute("href");
  await link.click();
  await page
    .locator(".breadcrumb")
    .getByRole("link", { name: "All requests", exact: true })
    .click();
  await expect(page).toHaveURL(/sort=title&dir=desc/);
  await expect(
    page.locator("tbody tr").first().getByRole("link").first(),
  ).toHaveAttribute("href", href!);
  await page.getByRole("button", { name: "Sort by RICE", exact: true }).click();
  await expect(page).not.toHaveURL(/sort=title/);
  await checkCatalogSort(page);
});

async function assertTitleOrder(page: Page, direction: "asc" | "desc") {
  await expect
    .poll(async () => {
      const titles = await page
        .locator("tbody tr td:first-child a")
        .allTextContents();
      const ordered = [...titles].sort(
        (a, b) =>
          a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) *
          (direction === "asc" ? 1 : -1),
      );
      return (
        titles.length > 0 && JSON.stringify(titles) === JSON.stringify(ordered)
      );
    })
    .toBe(true);
}

async function checkCatalogSort(page: Page) {
  await page.goto("/catalog?state=all");
  const heading = page.getByRole("button", {
    name: "Sort by Item",
    exact: true,
  });
  await heading.click();
  await expect(page).toHaveURL(/sort=name&dir=desc/);
  await assertTitleOrder(page, "desc");
  const inventory = await browserRead(page, "/api/inventory");
  expect(inventory.items.length).toBeGreaterThan(20);
  await expect(page.locator("tbody tr")).toHaveCount(inventory.items.length);
  await expect(
    page.getByRole("navigation", { name: "Catalog pages" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("columnheader", { name: "Sort by Item", exact: true }),
  ).toHaveAttribute("aria-sort", "descending");
  await assertTitleOrder(page, "desc");
}

test("a concurrent draft edit preserves entries and offers explicit recovery", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  await page
    .getByRole("button", { name: "Edit these details", exact: true })
    .click();
  await page
    .getByLabel("Request title", { exact: true })
    .fill("Retained concurrent summary");
  const result = await page.evaluate(async () => {
    const id = new URL(location.href).searchParams.get("draft");
    const draft = await (await fetch("/api/drafts/" + id)).json();
    return (
      await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftId: id,
          expectedRowVersion: draft.rowVersion,
          content: { title: "Another saved edit" },
        }),
      })
    ).status;
  });
  expect(result).toBe(200);
  await page
    .getByRole("button", { name: "Update my request", exact: true })
    .click();
  const recover = page.getByRole("button", {
    name: "Keep entries after reviewing the latest version",
    exact: true,
  });
  await expect(recover).toBeVisible();
  await expect(page.getByLabel("Request title", { exact: true })).toHaveValue(
    "Retained concurrent summary",
  );
  await recover.click();
  await page
    .getByRole("button", { name: "Update my request", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /Retained concurrent summary/ }),
  ).toBeVisible({ timeout: 120000 });
  expect((await intakeWorkspace(page)).callsUsed).toBe(2);
});

test("save and exit stays on the draft until persistence succeeds", async ({
  page,
}) => {
  await enter(page);
  await page.goto("/new");
  await expect(
    page.getByLabel("What do you need to accomplish?"),
  ).toBeEnabled();
  const draftUrl = page.url();
  await page.route("**/api/wip", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({
        status: 503,
        json: { error: { code: "UNAVAILABLE" } },
      });
    else await route.continue();
  });
  const description =
    "Fictional unsent draft whose save must finish before exit";
  await page.getByLabel("What do you need to accomplish?").fill(description);
  await page
    .getByRole("button", {
      name: "Save draft and return to my requests",
      exact: true,
    })
    .click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  expect(page.url()).toBe(draftUrl);
  await expect(page.getByLabel("What do you need to accomplish?")).toHaveValue(
    description,
  );
  await page.unroute("**/api/wip");
  await page
    .getByRole("button", {
      name: "Save draft and return to my requests",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/my$/);
  await page.reload();
  await page.getByRole("link", { name: description, exact: true }).click();
  await expect(page.getByLabel("What do you need to accomplish?")).toHaveValue(
    description,
  );
});

test("reopening an unsent edit cannot silently replace a newer save from another tab", async ({
  page,
}) => {
  await enter(page);
  await page.goto("/new");
  const field = page.getByLabel("What do you need to accomplish?");
  const exit = page.getByRole("button", {
    name: "Save draft and return to my requests",
    exact: true,
  });
  await expect(field).toBeEnabled();
  await page.route("**/api/wip", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } });
    else await route.continue();
  });
  await field.fill("My local unfinished request");
  await expect(
    page.getByRole("status").filter({
      hasText:
        "Draft save could not be confirmed. Your entries remain in this open form. Retry saving before leaving.",
    }),
  ).toBeVisible();
  const subjectKey = new URL(page.url()).searchParams.get("start")!;
  const scope = {
    actingView: "requester",
    pageKey: "start-request",
    subjectKey,
  };
  await page.unroute("**/api/wip");
  const status = await page.evaluate(async (scope) => {
    const response = await fetch("/api/wip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...scope,
        payload: { rawNeed: "Newer saved request from another tab" },
        expectedRowVersion: 0,
      }),
    });
    return response.status;
  }, scope);
  expect(status).toBe(200);
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(field).toHaveValue("My local unfinished request");
  await exit.click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        "A newer draft is already saved on the server. These changes were not saved over it.",
    }),
  ).toBeVisible();
  const current = await browserRead(
    page,
    "/api/wip?" + new URLSearchParams(scope),
  );
  expect(current.payload.rawNeed).toBe("Newer saved request from another tab");
  await expect(field).toHaveValue("My local unfinished request");
  await page
    .getByRole("button", {
      name: "Replace newer server draft with my entries",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Your draft is saved.", { exact: true }),
  ).toBeVisible();
  await exit.click();
  await expect(page).toHaveURL(/\/my$/);
});

test("the assessment leads with the need and design notes stay off the review record", async ({
  page,
}) => {
  await enter(page);
  const data = await browserRead(page, "/api/queue?reviewer=all");
  const row = data.rows.find(
    (entry: { stage: string; phase: string }) =>
      entry.stage === "under_review" && entry.phase !== "resolved",
  );
  await page.goto("/review/" + row.requestId);
  await expect(page.locator("#review-section")).toBeVisible();
  await expect(page.locator("#review-section h2").first()).toHaveText(
    "Confirmed request",
  );
  await expect(page.locator(".design-note")).toHaveCount(0);
  await page.goto("/dashboard");
  await expect(page.locator(".design-note").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Hide design notes", exact: true })
    .click();
  await expect(page.locator(".design-note").first()).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show design notes", exact: true }),
  ).toBeVisible();
});

async function beginAssistance(page: Page, description: string) {
  await page.goto("/new");
  await page.getByLabel("What do you need to accomplish?").fill(description);
  await page
    .getByLabel("Requesting agency or office")
    .selectOption({ label: "Budget Office" });
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page).toHaveURL(/draft=/);
}

async function intakeWorkspace(page: Page) {
  return page.evaluate(async () => {
    const id = new URL(location.href).searchParams.get("draft");
    const response = await fetch("/api/intake-workspace/" + id);
    if (!response.ok)
      throw new Error("Workspace read failed: " + response.status);
    return response.json();
  });
}

async function startRequest(page: Page) {
  await page.goto("/new");
  await page.getByLabel("What do you need to accomplish?").fill(need);
  await page
    .getByLabel("Requesting agency or office")
    .selectOption({ label: "Budget Office" });
  await expect(
    page.getByText("Your draft is saved.", { exact: true }),
  ).toBeVisible();
  const initialUrl = page.url();
  await page
    .getByRole("link", { name: "My requests", exact: true })
    .first()
    .click();
  await page.getByRole("link", { name: need, exact: true }).click();
  await expect(page).toHaveURL(initialUrl);
  await page.reload();
  await expect(page.getByLabel("What do you need to accomplish?")).toHaveValue(
    need,
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your request", exact: true }),
  ).toBeVisible({ timeout: 120000 });
}

test("answers update the same record and later manual edits do not make a third intake call", async ({
  page,
}) => {
  await enter(page);
  await beginAssistance(page, fieldNeed);
  const question = page.getByLabel(
    "Which details are on the current paper form?",
    { exact: true },
  );
  await expect(question).toBeVisible({ timeout: 120000 });
  const url = page.url();
  await question.fill("Rock type, GPS coordinates, and sample condition");
  await page
    .getByLabel("What do other teams need to do with the findings?", {
      exact: true,
    })
    .fill("Find and view each submitted field report");
  await expect(
    page.getByText("Your draft is saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(question).toHaveValue(
    "Rock type, GPS coordinates, and sample condition",
  );
  await page
    .getByRole("button", { name: "Update my request", exact: true })
    .click();
  await expect(
    page.getByText(
      "Your answers have been added. Check the changes below, then send your request to OIT.",
      {
        exact: true,
      },
    ),
  ).toBeVisible({ timeout: 120000 });
  expect(page.url()).toBe(url);
  await expect(
    page.getByRole("region", { name: "Your request", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator("ins").first()).toBeVisible();
  await expect(page.locator(".intake-answer")).toHaveCount(0);
  expect((await intakeWorkspace(page)).callsUsed).toBe(2);
  await page
    .getByRole("button", { name: "Edit these details", exact: true })
    .click();
  await page
    .getByLabel("Request title", { exact: true })
    .fill("Field request with a final manual edit");
  await expect(
    page.getByRole("button", { name: "Update my request", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Finish editing", exact: true })
    .click();
  const result = await submitRequest(page);
  const draftId = new URL(url).searchParams.get("draft");
  const saved = await browserRead(page, "/api/intake-workspace/" + draftId);
  expect(saved.callsUsed).toBe(2);
  expect(result.title).toBe("Field request with a final manual edit");
  await expect(
    page
      .getByRole("heading", {
        name: "Original request conversation",
        exact: true,
      })
      .locator(".."),
  ).toContainText("Rock type, GPS coordinates, and sample condition");
  await checkFieldReviewerEvidence(page, result.requestId);
});

async function checkFieldReviewerEvidence(page: Page, requestId: string) {
  await page.goto("/review/" + requestId);
  // The intake transcript moved to History and stays reachable there,
  // with the recorded field-report evidence inside it.
  await openHistory(page);
  await expect(
    page.getByRole("heading", {
      name: "Original request conversation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("#history")).toContainText(
    "Find and view each submitted field report",
  );
  await backToAssessment(page);
  await expect(page.locator("#service-evaluation")).toContainText(
    "These suggestions were prepared for an earlier version of the request.",
  );
  await expect(page.locator("#service-evaluation")).toContainText(
    "Moderate suggestion",
  );
}

async function submitRequest(page: Page) {
  // The optional priority invitation stays closed and untouched. Submission
  // must still send: hidden optional fields must never carry the required
  // attribute that lets native validation abort the form silently.
  const invitation = page.getByText(
    "Add information for prioritization (optional)",
    { exact: true },
  );
  await expect(invitation).toBeVisible();
  expect(
    await invitation.evaluate((element) => element.closest("details")!.open),
  ).toBe(false);
  await page.getByRole("radio", { name: "4", exact: true }).check();
  const submission = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/intake-workspace" &&
      response.request().postDataJSON()?.action === "submit",
  );
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  const response = await submission;
  expect(response.status(), await response.text()).toBe(200);
  const result = (await response.json()) as {
    requestId: string;
    displayId: string;
    title: string;
  };
  await expect(page).toHaveURL(/\/my$/);
  await expect(page.locator("#confirmation")).toContainText(result.displayId);
  await expect(page.locator("#confirmation")).toBeInViewport();
  await page.reload();
  // Same-title records accumulate in the shared session; the new request
  // is found by identity and must still be listed under its title.
  const link = page.locator('a[href="/request/' + result.requestId + '"]');
  await expect(link).toHaveText(result.title);
  await link.click();
  await expect(
    page.getByRole("heading", { name: result.title, exact: true }),
  ).toBeVisible();
  return result;
}

test("a saved draft name appears in My requests and reopens the same unfinished edit", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  const url = page.url();
  await page
    .getByRole("button", { name: "Edit these details", exact: true })
    .click();
  await page
    .getByLabel("Request title", { exact: true })
    .fill("My renamed unfinished request");
  await page
    .getByRole("button", {
      name: "Save draft and return to my requests",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/my$/);
  await page
    .getByRole("link", { name: "My renamed unfinished request", exact: true })
    .click();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("heading", {
      name: "My renamed unfinished request",
      exact: true,
    }),
  ).toBeVisible();
  expect((await intakeWorkspace(page)).callsUsed).toBe(1);
});

test("an older saved survey choice is restored without replacing a newer choice", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  const status = await page.evaluate(async () => {
    const draftId = new URL(location.href).searchParams.get("draft");
    return (
      await fetch("/api/wip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actingView: "requester",
          pageKey: "submit-request",
          subjectKey: draftId,
          expectedRowVersion: 0,
          payload: { rating: "3" },
        }),
      })
    ).status;
  });
  expect(status).toBe(200);
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "3", exact: true }),
  ).toBeChecked();
  await page.getByRole("radio", { name: "5", exact: true }).check();
  await expect(
    page.getByText("Your draft is saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "5", exact: true }),
  ).toBeChecked();
});

test("manual list errors stay beside the field and do not start another call", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  await page
    .getByRole("button", { name: "Edit these details", exact: true })
    .click();
  const items = Array.from(
    { length: 21 },
    (_, index) => "Criterion " + index,
  ).join("\n");
  await page.getByLabel("What must be achieved", { exact: true }).fill(items);
  await page
    .getByRole("button", { name: "Update my request", exact: true })
    .click();
  const message = "What must be achieved: use up to 20 items, one per line.";
  await expect(page.getByText(message, { exact: true })).toHaveCount(2);
  await expect(
    page.getByLabel("What must be achieved", { exact: true }),
  ).toHaveValue(items);
  expect((await intakeWorkspace(page)).callsUsed).toBe(1);
});

async function clarification(page: Page, requestId: string) {
  await page.goto("/review/" + requestId);
  await settleSavedWork(page);
  const fitText = await fitTextWithEvidence(page);
  expect(fitText).toContain("governed publishing layer");
  expect(fitText).toContain(
    "A working field data source and a separately designed viewing interface",
  );
  // Undecided claims read as proposed in the prose markers.
  expect(fitText).toContain("(Awaiting decision)");
  await page
    .getByText("Ask the requester to clarify the request", { exact: true })
    .click();
  await page
    .getByLabel("What should the requester clarify?")
    .fill("What access should budget analysts have?");
  await page
    .getByRole("button", { name: "Ask for clarification", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Clarification requested. The requester's answer may revise the request.",
  );
  await page.goto("/request/" + requestId);
  await expect(
    page.getByRole("heading", { name: "Questions for you" }),
  ).toBeVisible();
  const answer =
    "Analysts may submit forecasts for their own office; budget reviewers may read every office’s aggregate forecast.";
  await page.getByLabel("Your answer", { exact: true }).fill(answer);
  await expect(
    page.getByText("Your draft is saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue(
    answer,
  );
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Clarification answer saved. OIT can resume reviewing the request.",
  );
  await page.goto("/review/" + requestId);
  await openHistory(page);
  await expect(page.locator("#history")).toContainText(answer);
}

test("a real saved request crosses requester and reviewer views", async ({
  page,
}, testInfo) => {
  await enter(page);
  await startRequest(page);
  const request = await submitRequest(page);
  await clarification(page, request.requestId);
  await backToAssessment(page);
  await riskFollowUpLoop(page, request.requestId);
  await draftPriorityEstimates(page);
  await page.screenshot({
    path: testInfo.outputPath("priority-drafts.png"),
    fullPage: false,
  });
  await finishReview(page);
  await page.reload();
  await expect(
    page.locator("#priority p").filter({ hasText: "RICE score" }),
  ).toContainText("64");
  await fulfillRequest(page);
  await page.goto("/review/" + request.requestId + "?panel=rice");
  await expect(page.locator("#completion")).toContainText(
    "First review complete",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The recorded human verdict, with its decided-by line, stays readable
  // in the claim panel after the review closes.
  const recordedRisk = await openClaimPanel(page, "#risk");
  await expect(recordedRisk).toContainText("Recorded: Confirmed");
  await expect(recordedRisk).toContainText("Decided by");
  // The resolved record is terminal and read-only: no editing, asking,
  // answering, or saving controls anywhere on the brief.
  await expect(
    page.getByLabel("How will you handle this estimate?"),
  ).toHaveCount(0);
  await expect(page.getByText(/Ask (for|about) this estimate/)).toHaveCount(0);
  await expect(page.getByText("Ask about this finding")).toHaveCount(0);
  await expect(page.getByText("Close request without fulfillment")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Record priority changes" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submit answer" })).toHaveCount(
    0,
  );
  await page.goto("/request/" + request.requestId);
  await expect(
    page
      .locator("main .record-meta + div > strong")
      .filter({ hasText: /^Closed$/ }),
  ).toBeVisible();
  await followUpDraft(page, request.requestId);
  await page.goto("/review/" + request.requestId);
  await checkRecordedEvidence(page);
  await checkMetricRecords(page, testInfo, request.displayId);
});

async function checkMetricRecords(
  page: Page,
  testInfo: TestInfo,
  displayId: string,
) {
  await page.goto("/reports");
  await expect(
    page.getByRole("heading", { name: "Reports", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Requests fulfilled", exact: true })
    .click();
  const records = page.locator("#metric-records");
  await expect(records).toContainText(displayId);
  await page.screenshot({
    path: testInfo.outputPath("fulfilled-request-report.png"),
    fullPage: true,
  });
  // An unknown metric in the URL still opens the detail panel and reports that
  // the measure matched nothing, rather than hiding the panel.
  await page.goto("/reports?metric=unknown-measure");
  await expect(records).toBeVisible();
  await expect(records).toContainText("Requests included in this measure");
  await expect(records).toContainText(
    "No records match this measure and date range.",
  );
}

async function checkRecordedEvidence(page: Page) {
  await openHistory(page);
  await page.getByText("Task satisfaction ratings", { exact: true }).click();
  await expect(page.locator("#history")).toContainText(
    "Submitting the request: 4 / 5",
  );
  await expect(page.locator("#history")).toContainText(
    "Completing first review: 5 / 5",
  );
  await page
    .getByText("Recorded scores and estimates", { exact: true })
    .click();
  await page.getByText(/Score version 1: 64/).click();
  await expect(page.locator("#history")).toContainText(
    "The delivery lead estimates 60 working days.",
  );
}

async function checkDeliveryChoices(page: Page, metadata: Metadata) {
  const allowed = metadata.actors
    .filter(
      (actor) =>
        actor.kind === "persona" || actor.id === metadata.visitor.actorId,
    )
    .map((actor) => actor.id);
  const offered = await page
    .getByLabel("Delivery lead", { exact: true })
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => option.getAttribute("value")),
    );
  expect(offered).toEqual(["", ...allowed]);
}

async function finishReview(page: Page) {
  await settleSavedWork(page);
  await decideClaim(page, "#fit", "accepted");
  await decideClaim(page, "#risk", "confirmed");
  // With claim drafts standing, Actions must not claim the opposite.
  // Scoped to visible save-status rows: the collapsed coordination form
  // legitimately keeps its own idle line in the DOM.
  await expect(
    page
      .locator("#completion .save-status:visible")
      .filter({ hasText: "No draft changes." }),
  ).toHaveCount(0);
  const metadata = await browserMetadata(page);
  await openCoordination(page);
  await page
    .getByLabel("Review coordinator", { exact: true })
    .selectOption(metadata.visitor.actorId);
  await expect(
    page
      .getByLabel("Review coordinator", { exact: true })
      .locator("option:checked"),
  ).toContainText(" (you)");
  await page
    .getByRole("button", { name: "Record responsibilities", exact: true })
    .click();
  await checkUnassignCoordinator(page, metadata.visitor.actorId);
  await page
    .getByLabel("Delivery lead", { exact: true })
    .selectOption(metadata.visitor.actorId);
  await checkDeliveryChoices(page, metadata);
  await page
    .getByLabel("Next delivery task", { exact: true })
    .fill("Configure and verify the application environment.");
  await page
    .getByLabel("Required work (optional, one item per line)", { exact: true })
    .fill("Configure the environment\nVerify agency access");
  await page.getByRole("radio", { name: "5", exact: true }).check();
  const submission = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/review/actions" &&
      request.postDataJSON()?.action === "submitAssessment",
  );
  await page
    .getByRole("button", { name: "Complete first review", exact: true })
    .click();
  // One transaction carries the changed judgments, the priority drafts,
  // and the completion; there are no per-decision save endpoints.
  const payload = (await submission).postDataJSON().input;
  expect(payload.complete).toBeTruthy();
  expect(payload.assetDecisions.length).toBeGreaterThan(0);
  expect(payload.riskDecisions.length).toBeGreaterThan(0);
  expect(payload.priorityDecisions).toHaveLength(4);
  await expect(page.locator("#confirmation")).toContainText(
    "First review complete",
  );
}

async function settleSavedWork(page: Page) {
  await expect(page.getByText("Loading your draft…")).toHaveCount(0);
}

/* Role queries skip content hidden inside a closed <details>, so claim
 * cards are matched on their decision select element. */
/* A risk hold is never ownerless: the question rides with the finding, an
 * unknown reply keeps completion blocked, and a provided reply plus a
 * fresh judgment lets the review complete. */
async function riskFollowUpLoop(page: Page, requestId: string) {
  await settleSavedWork(page);
  await decideClaim(
    page,
    "#risk",
    "follow_up_required",
    "The retention basis for the fictional forecast data is unresolved.",
  );
  await page
    .getByRole("button", { name: "Record progress", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Decisions recorded. First review is still open.",
  );
  const blockers = async () =>
    (
      (await browserRead(
        page,
        "/api/request-view/" + requestId + "?view=contributor",
      )) as { review: { blockers: string[] } }
    ).review.blockers;
  expect(await blockers()).toContain("RISK_FOLLOW_UP_OPEN");

  await askRiskQuestion(
    page,
    "Which retention rule applies to the fictional forecast data?",
  );
  await answerRiskQuestion(page, {
    outcome: "unknown",
    answer: "The fictional records office has no ruling on forecast data yet.",
  });
  // An honest "not known" is an answer, never a clearance.
  expect(await blockers()).toContain("RISK_FOLLOW_UP_OPEN");

  // The same question accepts the useful evidence later; no second
  // question is needed and the earlier reply stays in the record.
  await answerRiskQuestion(page, {
    outcome: "provided",
    answer:
      "Aggregate forecast totals fall under the fictional five-year schedule.",
  });
  // The fresh judgment replaces the hold; completion happens in finishReview.
  await settleSavedWork(page);
  await decideClaim(page, "#risk", "confirmed");
}

async function askRiskQuestion(page: Page, question: string) {
  // The claim panel closes on every refresh; reopen it first, then the
  // nested ask disclosure, each only when actually closed.
  const panel = await openClaimPanel(page, "#risk");
  if (!(await panel.getByLabel("Question", { exact: true }).isVisible()))
    await panel.getByText("Ask about this finding", { exact: true }).click();
  await panel.getByLabel("Question", { exact: true }).fill(question);
  await panel
    .getByLabel(
      "Expertise needed (required for internal questions without a named person)",
      { exact: true },
    )
    .fill("records");
  // Only the named addressee can answer, so the asker names themself as
  // the known contributor to keep the loop within one session.
  const metadata = await browserMetadata(page);
  await panel
    .getByLabel("Person to ask (optional)", { exact: true })
    .selectOption(metadata.visitor.actorId);
  await panel
    .getByRole("button", { name: "Ask question", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Question submitted.",
  );
}

async function answerRiskQuestion(
  page: Page,
  reply: { outcome: "provided" | "unknown"; answer: string },
) {
  await page.reload();
  await settleSavedWork(page);
  // Acknowledged drafts never present as recovered unsent work.
  await expect(
    page.getByText("Entries recovered from this browser"),
  ).toHaveCount(0);
  // The question rides with its finding: the answer form lives in the
  // claim's panel.
  const panel = await openClaimPanel(page, "#risk");
  await panel
    .getByLabel("Can you supply the information?", { exact: true })
    .selectOption(reply.outcome);
  await panel
    .getByLabel(
      reply.outcome === "unknown"
        ? "What would help get the missing information?"
        : "Your answer",
      { exact: true },
    )
    .fill(reply.answer);
  await panel
    .getByRole("button", {
      name: /^(Submit answer|Update answer)$/,
      exact: true,
    })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Answer recorded for review.",
  );
}

const decisionVerbs: Record<string, string> = {
  accepted: "Accept option",
  rejected: "Reject option",
  confirmed: "Confirm finding",
  overridden: "Change severity",
  cleared: "Does not apply",
  follow_up_required: "Need more information",
};

/* One claim panel is open at a time: clicking the inline claim opens its
 * evidence-and-judgment panel below the paragraph. */
async function openClaimPanel(page: Page, section: string, index = 0) {
  const claim = page.locator(section + " button[data-claim]").nth(index);
  if ((await claim.getAttribute("aria-expanded")) !== "true")
    await claim.click();
  const panel = page.locator(section + " [data-claimpanel]");
  await expect(panel).toBeVisible();
  return panel;
}

async function decideClaim(
  page: Page,
  section: string,
  decision: string,
  reason?: string,
) {
  const panel = await openClaimPanel(page, section);
  await panel
    .getByRole("button", { name: decisionVerbs[decision], exact: true })
    .click();
  // Every decision except a plain confirmation needs its recorded reason.
  if (reason)
    await panel
      .getByRole("textbox", { name: /^(Reason|Why does this option not fit?)/ })
      .fill(reason);
}

async function openCoordination(page: Page) {
  await page
    .getByText("Review responsibilities (optional)", {
      exact: true,
    })
    .click();
}

async function checkUnassignCoordinator(page: Page, actorId: string) {
  await page.getByLabel("Review coordinator", { exact: true }).selectOption("");
  await page
    .getByRole("button", { name: "Record responsibilities", exact: true })
    .click();
  await page.reload();
  await openCoordination(page);
  await expect(
    page.getByLabel("Review coordinator", { exact: true }),
  ).toHaveValue("");
  await page
    .getByLabel("Review coordinator", { exact: true })
    .selectOption(actorId);
  await page
    .getByRole("button", { name: "Record responsibilities", exact: true })
    .click();
}

async function fulfillRequest(page: Page) {
  await openDelivery(page);
  // History opened from the delivery view returns to the delivery view.
  await openHistory(page);
  await page
    .getByRole("link", { name: "Return to delivery", exact: true })
    .click();
  await expect(page.locator("#delivery")).toBeVisible();
  await linkSupportingWork(page);
  await page
    .getByRole("button", { name: "Simulate handoff failure", exact: true })
    .click();
  await expect(page.locator("#delivery").getByRole("alert")).toContainText(
    "Simulated handoff failed. First review remains complete; retry the handoff.",
  );
  await page
    .getByRole("button", { name: "Simulate handoff", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Simulate closure",
      exact: true,
    }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Simulate closure", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", {
      name: "Simulate closure",
      exact: true,
    }),
  ).toHaveCount(1);
  await page.getByText("Record final outcome", { exact: true }).click();
  await page
    .getByLabel("Final outcome", { exact: true })
    .selectOption("fulfilled_new");
  await page
    .getByLabel("Outcome explanation", { exact: true })
    .fill(
      "The simulated environment and access were verified against the acceptance criteria.",
    );
  await page
    .getByRole("button", { name: "Record outcome", exact: true })
    .click();
  await expect(page.locator("#delivery").getByRole("alert")).toContainText(
    "Fulfillment cannot be recorded yet. Check required work and whether its source information is current.",
  );
  await page
    .getByRole("button", { name: "Simulate closure", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Simulate closure",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Record outcome", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Final outcome recorded",
  );
}

/* The strip is gone: History opens from the quiet header link and
 * returns via its explicit back link; Delivery opens from the
 * next-action button once post-completion work exists. */
async function openHistory(page: Page) {
  await page
    .getByRole("link", { name: "Request history", exact: true })
    .click();
  await expect(page.locator("#history")).toBeVisible();
}

async function backToAssessment(page: Page) {
  await page
    .getByRole("link", { name: "Return to review", exact: true })
    .click();
  await expect(page.locator("#fit")).toBeVisible();
}

/* The ask reveal is a deliberate action whose typed words survive
 * closing and reopening the trigger — the form hides, never unmounts. */
async function checkAskRevealKeepsDraft(page: Page) {
  const trigger = page
    .locator("#fit [data-claimpanel]")
    .getByText("Ask about this option", {
      exact: true,
    });
  await trigger.click();
  const question = page
    .locator("#fit [data-claimpanel]")
    .getByLabel("Question", { exact: true });
  await question.fill("Which sealed-record sets does the capability read?");
  await trigger.click();
  await expect(question).toBeHidden();
  await trigger.click();
  await expect(question).toHaveValue(
    "Which sealed-record sets does the capability read?",
  );
}

/* History is a reference: the assessment hides but stays mounted, the
 * title heads the reference view, and no next-action detour renders. */
async function expectHistoryIsReference(page: Page, title: string) {
  await expect(page.locator("#fit")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /^Next: / })).toHaveCount(0);
}

async function openDelivery(page: Page) {
  await page.getByRole("link", { name: "Open delivery", exact: true }).click();
  await expect(page.locator("#delivery")).toBeVisible();
}

test("the assessment preserves unfinished decisions, URL context, and keyboard orientation", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  const request = await submitRequest(page);
  await page.goto(
    "/review/" + request.requestId + "?from=reviewer%3Dme%26page%3D2",
  );
  await expect(page.locator("#fit")).toBeVisible();
  await expect(page.locator("#delivery,#history")).toHaveCount(0);
  // The prepared assessment is the strong heading; the request title
  // supports it as context. Other sections keep the title as the heading.
  await expect(
    page.getByRole("heading", { name: "Review request", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".record-meta")).toContainText(request.title);
  await settleSavedWork(page);
  const claim = page.locator("#fit button[data-claim]").first();
  await claim.click();
  const reason = page.getByRole("textbox", {
    name: "Reason for accepting (optional)",
    exact: true,
  });
  await expect(reason).toBeEnabled();
  const saving = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/wip" &&
      request.method() === "POST" &&
      request.postDataJSON()?.pageKey.startsWith("asset-"),
  );
  await reason.fill(
    "Unfinished review: confirm the viewing interface before accepting.",
  );
  await openHistory(page);
  expect((await saving).postDataJSON().route).toContain(
    "/review/" + request.requestId,
  );
  await expectHistoryIsReference(page, request.title);
  await backToAssessment(page);
  // The claim is still open with the unsaved words — no reload happened.
  await expect(reason).toHaveValue(
    "Unfinished review: confirm the viewing interface before accepting.",
  );
  await page.goBack();
  await expect(page.locator("#history")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#fit")).toBeVisible();
  await page.reload();
  await claim.click();
  await expect(reason).toHaveValue(
    "Unfinished review: confirm the viewing interface before accepting.",
  );
  await checkAskRevealKeepsDraft(page);
  expect(new URL(page.url()).searchParams.get("from")).toBe(
    "reviewer=me&page=2",
  );
  await checkCatalogueSwap(page, request.title);
});

/* The catalogue opens in place of the assessment — the brief hides but
 * stays mounted — and the Back control returns to the reading. */
async function checkCatalogueSwap(page: Page, title: string) {
  const history = page.getByRole("link", {
    name: "Request history",
    exact: true,
  });
  const font = await referenceFont(history);
  const trigger = page.getByRole("button", {
    name: "Search the catalog",
    exact: true,
  });
  await trigger.scrollIntoViewIfNeeded();
  const top = await page.evaluate(() => window.scrollY);
  const url = page.url();
  await trigger.click();
  await expectCatalogFrame(page, title);
  const back = page.getByRole("button", {
    name: "Return to review",
    exact: true,
  });
  expect(await referenceFont(back)).toEqual(font);
  const searchBox = page.getByLabel("Search products and services", {
    exact: true,
  });
  await expect(searchBox).toBeFocused();
  const firstResult = page.locator("details:visible").first();
  await expect(firstResult).toBeVisible();
  expect((await firstResult.boundingBox())!.y).toBeGreaterThanOrEqual(
    (await searchBox.boundingBox())!.y +
      (await searchBox.boundingBox())!.height,
  );
  await back.click();
  await expect(page.locator("#fit")).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(url);
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - top),
    )
    .toBeLessThanOrEqual(1);
  await expect(
    page.getByLabel("Reason for accepting (optional)", { exact: true }),
  ).toHaveValue(
    "Unfinished review: confirm the viewing interface before accepting.",
  );
}

async function referenceFont(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      size: style.fontSize,
      family: style.fontFamily,
      weight: style.fontWeight,
    };
  });
}

async function expectCatalogFrame(page: Page, title: string) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      name: "Existing products and services",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Review request", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Request history", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/^Next: /)).toHaveCount(0);
  await expect(page.locator("#fit")).toBeHidden();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

test("closing without fulfillment is reachable from the open review and ends it", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  const request = await submitRequest(page);
  await page.goto("/review/" + request.requestId);
  await settleSavedWork(page);
  const trigger = page.getByRole("button", {
    name: "Close request without fulfillment",
    exact: true,
  });
  await trigger.click();
  await expect(
    page.getByText(/no longer edit its review or delivery details/),
  ).toBeVisible();
  // Cancel hides the form without closing anything.
  await page
    .getByRole("button", { name: "Cancel closure", exact: true })
    .click();
  await expect(
    page.getByLabel("Reason for closing without fulfillment", { exact: true }),
  ).toBeHidden();
  await trigger.click();
  await page
    .getByLabel("Reason for closing without fulfillment", { exact: true })
    .fill("The agency withdrew the request during the fictional pilot.");
  await page
    .getByRole("button", { name: "Close without fulfillment", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "closed without fulfillment",
  );
  await expect(page.locator("#completion")).toContainText(
    "The request was closed before first review was completed.",
  );
  await expect(
    page.getByLabel("How will you handle this estimate?"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Close without fulfillment" }),
  ).toHaveCount(0);
});

test("filing the recovered legacy question clears its trigger without a refresh", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  const request = await submitRequest(page);
  await page.goto("/review/" + request.requestId);
  await settleSavedWork(page);
  // Seed the retired form's server draft on this test's own request. A
  // real RecordForm draft always stored _recordVersion; the send derives
  // expectedRowVersion from it, so the fixture must carry it too.
  await page.evaluate(async ({ requestId }) => {
    const view = await fetch("/api/request-view/" + requestId).then((r) =>
      r.json(),
    );
    const response = await fetch("/api/wip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actingView: "contributor",
        pageKey: "ask-input",
        subjectKey: requestId,
        payload: {
          factor: "reach",
          question: "Legacy question to file from the retired form?",
          scope: "",
          expertise: "records",
          addressee: "",
          inputRequestId: "",
          _recordVersion: String(view.record.rowVersion),
        },
        expectedRowVersion: 0,
        route: "/review/" + requestId,
      }),
    });
    if (!response.ok) throw new Error("wip seed " + response.status);
  }, request);
  await page.reload();
  await settleSavedWork(page);
  const reach = page.locator('[data-factor="reach"]');
  await reach.locator("button[aria-expanded]").first().click();
  const trigger = reach.getByText("Recover your earlier unsent question", {
    exact: true,
  });
  await trigger.click();
  await reach
    .getByRole("button", { name: "Ask question", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Question submitted.",
  );
  // The live draft cleared, so the trigger is gone with no reload, and
  // the filed question stands as a thread on the factor line.
  await expect(trigger).toHaveCount(0);
  await expect(reach).toContainText(
    "Legacy question to file from the retired form?",
  );
});

test("demo restoration requires confirmation, reports failure honestly, and retains visitor work", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  const request = await submitRequest(page);
  const before = await browserRead(
    page,
    "/api/request-view/" + request.requestId,
  );
  await changeFixtureCoordinator(page);
  await page.goto("/admin/demo");
  const restore = page.getByRole("button", {
    name: "Restore examples",
    exact: true,
  });
  const consent = page.getByRole("checkbox");
  await expect(restore).toBeDisabled();
  await page.locator('label[for="confirm-fixture-restore"]').click();
  await page.reload();
  await expect(consent).not.toBeChecked();
  await page.locator('label[for="confirm-fixture-restore"]').click();
  await checkRestoreFailure(page);
  await restore.click();
  await expect(page.locator("#confirmation")).toContainText(
    "Demo examples restored",
  );
  await expect(page.locator("#confirmation")).toBeInViewport();
  await expect(consent).not.toBeChecked();
  const after = await browserRead(
    page,
    "/api/request-view/" + request.requestId,
  );
  expect(after.record).toEqual(before.record);
  expect(after.evidence.ratings).toEqual(before.evidence.ratings);
  await expect(
    page.getByRole("link", { name: "Open the restored request queue" }),
  ).toBeVisible();
});

async function changeFixtureCoordinator(page: Page) {
  const metadata = await browserMetadata(page);
  const queue = await browserRead(page, "/api/queue?reviewer=all");
  const row = queue.rows.find(
    (entry: { fixtureKey: string | null; stage: string }) =>
      entry.fixtureKey && entry.stage === "under_review",
  );
  expect(row).toBeTruthy();
  await page.goto("/review/" + row.requestId + "?section=finish");
  await settleSavedWork(page);
  await openCoordination(page);
  await page
    .getByLabel("Review coordinator", { exact: true })
    .selectOption(metadata.visitor.actorId);
  await page
    .getByRole("button", { name: "Record responsibilities", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Review responsibilities recorded",
  );
}

async function checkRestoreFailure(page: Page) {
  await page.route("**/api/admin/actions", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "REQUEST_FAILED" }),
    }),
  );
  await page
    .getByRole("button", { name: "Restore examples", exact: true })
    .click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.locator("#confirmation")).not.toContainText(
    "Demo examples restored",
  );
  await expect(page.getByRole("checkbox")).toBeChecked();
  await page.unroute("**/api/admin/actions");
}

test("zoomed tables expose hidden columns and keep the review task in focus", async ({
  page,
}) => {
  await enter(page);
  const cdp = await page.context().newCDPSession(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await cdp.send("Page.setFontSizes", {
    fontSizes: { standard: 32, fixed: 26 },
  });
  try {
    await page.goto("/review?reviewer=unassigned");
    const region = page.getByRole("region", {
      name: "Request list",
      exact: true,
    });
    await expect(
      page.getByText("More columns to the right", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Scroll (left|right)/ }),
    ).toHaveCount(0);
    await region.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => region.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBe(0);
    await page.goto(
      "/review/5d07dde5-1ad6-57af-ae31-8f94f616a51b?section=risk",
    );
    await expect(page.locator("#risk")).toBeVisible();
    await expect(page.locator(".record-meta")).toContainText(
      "Fictional example",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBe(0);
  } finally {
    await cdp.send("Page.setFontSizes", {
      fontSizes: { standard: 16, fixed: 13 },
    });
  }
});

async function linkSupportingWork(page: Page) {
  await page.getByText("Link existing work", { exact: true }).click();
  const picker = page.getByLabel("Work item", { exact: true });
  await expect(picker).toBeEnabled();
  const option = await picker
    .locator("option")
    .evaluateAll((elements) =>
      elements
        .find(
          (element) =>
            element.getAttribute("value") &&
            !element.textContent?.startsWith("SIM-"),
        )
        ?.getAttribute("value"),
    );
  expect(option).toBeTruthy();
  await picker.selectOption(option!);
  await page
    .getByLabel("Role in fulfillment", { exact: true })
    .selectOption("supporting");
  await page
    .getByRole("button", { name: "Link work item", exact: true })
    .click();
  await expect(page.locator("#confirmation")).toContainText(
    "Work item linked.",
  );
  await page.reload();
  await expect(page.locator("#delivery")).toContainText("No (supporting)");
}

async function followUpDraft(page: Page, parentId: string) {
  await page
    .getByRole("link", { name: "Start a follow-up request", exact: true })
    .click();
  await expect(page.getByText(/This is a follow-up request/)).toBeVisible();
  const newNeed =
    "A separate request for quarterly-report export, related to the completed deployment.";
  await page.getByLabel("What do you need to accomplish?").fill(newNeed);
  await page
    .getByLabel("Requesting agency or office")
    .selectOption({ label: "Budget Office" });
  await page
    .getByRole("button", {
      name: "Save draft and return to my requests",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/my$/);
  await page.getByRole("link", { name: newNeed, exact: true }).click();
  await expect(page.getByText(/This is a follow-up request/)).toBeVisible();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page).toHaveURL(/draft=/);
  const parent = await page.evaluate(
    async (id) =>
      (await fetch("/api/request-view/" + id + "?view=requester")).json(),
    parentId,
  );
  expect(parent.followUps).toHaveLength(0);
  expect(parent.delivery.resolution).not.toBeNull();
  await page.goto("/request/" + parentId);
}

/* Panels open one at a time, so the sweep opens every claim once and
 * accumulates the section text with each panel's evidence included. */
async function fitTextWithEvidence(page: Page): Promise<string> {
  await expect(page.locator("#fit")).toBeVisible();
  let text = await page.locator("#fit").innerText();
  const claims = page.locator("#fit button[data-claim]");
  const count = await claims.count();
  for (let index = 0; index < count; index++) {
    await openClaimPanel(page, "#fit", index);
    text += "\n" + (await page.locator("#fit").innerText());
  }
  return text;
}

function factorCard(page: Page, label: string) {
  return page.locator('#priority [data-factor="' + label.toLowerCase() + '"]');
}

/* The factor's editor opens from the line's Edit toggle. */
async function openFactorEditor(card: Locator) {
  const toggle = card.locator("button[aria-expanded]").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}

async function draftFactor(
  page: Page,
  label: string,
  spec: { valueLabel: string; value: string; basis: string },
) {
  const card = factorCard(page, label);
  await openFactorEditor(card);
  await card
    .getByLabel("How will you handle this estimate?", { exact: true })
    .selectOption("replace");
  await card.getByLabel(spec.valueLabel, { exact: true }).fill(spec.value);
  if (label === "Reach") {
    await card
      .getByLabel("Unit counted", { exact: true })
      .fill("Budget analysts");
    await card.getByLabel("Time period", { exact: true }).fill("Next quarter");
  }
  await card
    .getByLabel("What supports this estimate?", { exact: true })
    .fill(spec.basis);
}

/** 120 reach × 2 impact × 0.8 confidence ÷ 3 person-months (60 working
 * days) = 64. The drafts submit together with the review decisions. */
async function draftPriorityEstimates(page: Page) {
  await settleSavedWork(page);
  await draftFactor(page, "Reach", {
    valueLabel: "Reach count",
    value: "120",
    basis: "The fictional program roster lists 120 analysts.",
  });
  await draftFactor(page, "Impact", {
    valueLabel: "Impact value",
    value: "2",
    basis:
      "Analysts can complete the quarterly forecast without duplicate entry.",
  });
  await draftFactor(page, "Confidence", {
    valueLabel: "Confidence (%)",
    value: "80",
    basis: "A program lead reviewed the estimates.",
  });
  await draftFactor(page, "Effort", {
    valueLabel: "Total working days",
    value: "60",
    basis: "The delivery lead estimates 60 working days.",
  });
}

test("a steward creates, revises, publishes, and retires an inventory item", async ({
  page,
}) => {
  await enter(page);
  await page.goto("/catalog");
  await page.getByRole("link", { name: "Add an inventory item" }).click();
  const name = "Browser-check catalog item " + Date.now();
  await fillCatalogDraft(page, name);
  await page
    .getByRole("button", { name: "Save catalog entry", exact: true })
    .click();
  await expect(page).toHaveURL(/\/catalog\/[a-f0-9-]+$/);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Revise the entry", exact: true })
    .click();
  await page
    .getByLabel("Approval status", { exact: true })
    .selectOption("approved");
  await page
    .getByLabel("Evidence for approval status", { exact: true })
    .fill("The steward approved this fictional test item.");
  await page
    .getByRole("button", { name: "Save catalog entry", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Publish approved item" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Publish approved item" }).click();
  await expect(page.locator("#confirmation")).toContainText(
    "Catalog item published",
  );
  await page.reload();
  await expect(
    page.getByText("Published · Approved · Version 2", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Retire item", exact: true }).click();
  await expect(page.locator("#confirmation")).toContainText(
    "Catalog item retired",
  );
  await page.reload();
  await expect(
    page.getByText("Retired · Approved · Version 2", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Field-decision history" }),
  ).toBeVisible();
});

async function fillCatalogDraft(page: Page, name: string) {
  await page.getByLabel("Item name", { exact: true }).fill(name);
  await page
    .getByLabel("What the item does", { exact: true })
    .fill("Tracks fictional assignments for an automated acceptance check.");
  await page
    .getByLabel("Owning team", { exact: true })
    .selectOption({ label: "Budget Office" });
  await page
    .getByLabel("Capabilities", { exact: true })
    .fill("Track assignments");
  await page
    .getByLabel("Allowed data classifications", { exact: true })
    .fill("Public");
  await page.getByLabel("Review again by", { exact: true }).fill("2026-12-31");
  for (const field of [
    "item name",
    "what the item does",
    "item type",
    "owning team",
    "capabilities",
    "allowed data classifications",
    "integrations",
    "review again by",
  ])
    await page
      .getByLabel("Evidence for " + field, { exact: true })
      .fill("Verified by the steward for this fictional browser test.");
}

async function checkReportAlignment(page: Page) {
  await page.goto("/reports");
  await expect(page.locator("table").first()).toBeVisible();
  const tops = await page
    .locator(".queue-filters input,.queue-filters select")
    .evaluateAll((elements) =>
      elements.map((e) => e.getBoundingClientRect().top),
    );
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
}

async function checkRatingError(page: Page) {
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page.locator("#rating-error")).toHaveText(
    "Choose a rating from 1 to 5 to complete this task.",
  );
  await expect(page.locator(".rating-error-summary")).toContainText(
    "Choose a rating from 1 to 5 to complete this task.",
  );
}

test("one strong suggestion is optional, saved, and never becomes routing approval", async ({
  page,
}) => {
  await enter(page);
  await beginAssistance(page, "Strong fit demonstration: " + need);
  const choice = page.getByLabel("Does this sound like what you want?", {
    exact: true,
  });
  await expect(choice).toBeVisible({ timeout: 120000 });
  await expect(
    page.locator('section[aria-labelledby="suggestion-heading"]'),
  ).toHaveCount(1);
  await expect(choice).toHaveValue("cleared");
  await choice.selectOption("accepted");
  const draftId = new URL(page.url()).searchParams.get("draft");
  await page
    .getByRole("button", {
      name: "Save draft and return to my requests",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/my$/);
  await page.locator('a[href*="' + draftId + '"]').click();
  await expect(choice).toHaveValue("accepted");
  await choice.selectOption("cleared");
  const request = await submitRequest(page);
  const record = await browserRead(
    page,
    "/api/request-view/" + request.requestId + "?view=contributor",
  );
  expect(record.record.routingState).toBe("routing_requested");
  expect(
    record.serviceChoices.every(
      (choice: { selected: boolean }) => !choice.selected,
    ),
  ).toBe(true);
  expect(
    record.serviceChoices.some(
      (item: { requesterDecision: string }) =>
        item.requesterDecision === "cleared",
    ),
  ).toBe(true);
});

async function browserRead(page: Page, path: string) {
  return page.evaluate(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(path + " returned " + response.status);
    return response.json();
  }, path);
}

test("declining a strong suggestion preserves the reason and requires a confirmed save", async ({
  page,
}) => {
  await enter(page);
  await beginAssistance(page, "Strong fit demonstration: " + need);
  const choice = page.getByLabel("Does this sound like what you want?", {
    exact: true,
  });
  await expect(choice).toBeVisible({ timeout: 120000 });
  await choice.selectOption("rejected");
  await page.getByRole("radio", { name: "4", exact: true }).check();
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(
    page.getByLabel("What is missing?", { exact: true }),
  ).toBeFocused();
  const reason = "We also need an approval process before deployment.";
  await page.getByLabel("What is missing?", { exact: true }).fill(reason);
  await page.route("**/api/wip", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } });
    else await route.continue();
  });
  await choice.selectOption("accepted");
  await choice.selectOption("rejected");
  await page
    .getByRole("button", {
      name: "Save draft and return to my requests",
      exact: true,
    })
    .click();
  await expect(page.locator("main").getByRole("alert").first()).toBeVisible();
  await expect(choice).toHaveValue("rejected");
  await page.unroute("**/api/wip");
  const draftId = new URL(page.url()).searchParams.get("draft");
  await page
    .getByRole("button", {
      name: "Save draft and return to my requests",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/my$/);
  await page.locator('a[href*="' + draftId + '"]').click();
  await expect(
    page.getByLabel("What is missing?", { exact: true }),
  ).toHaveValue(reason);
  const request = await submitRequest(page);
  await page.goto("/review/" + request.requestId);
  await expect(page.locator("#fit")).toContainText(reason);
});

test("two failed attempts leave a saved request that can be sent without assistance", async ({
  page,
}) => {
  await enter(page);
  const raw =
    "Fail assistance: field teams need to record observations offline.";
  await beginAssistance(page, raw);
  const retry = page.getByRole("button", {
    name: "Try assistance again",
    exact: true,
  });
  await expect
    .poll(async () => (await intakeWorkspace(page)).callsUsed)
    .toBe(2);
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByText(/We couldn’t prepare your request automatically/),
  ).toBeVisible();
  await expect(
    page.getByLabel("Problem to solve", { exact: true }),
  ).toHaveValue(raw);
  await page
    .getByLabel("Request title", { exact: true })
    .fill("Offline observations");
  await page.getByLabel("Who is affected", { exact: true }).fill("Field teams");
  const result = await submitRequest(page);
  expect(result.title).toBe("Offline observations");
});

test("no page scrolls sideways on a phone and every wide table keeps a labelled scroll region", async ({
  page,
}) => {
  await enter(page);
  // Measured before the fix at this width: the dashboard document was 67px
  // wider than its viewport and the reports document 7px, because three tables
  // rendered outside a TableScroll region. Two are always present; the
  // satisfaction table on /reports appears only for some measures, so the
  // wrapper has to be on the call site rather than on the visible page.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/dashboard", "/reports", "/review", "/catalog", "/my"]) {
    await page.goto(path);
    await expect(page.getByLabel("Choose view")).toBeVisible();
    if (path === "/my")
      await expect(
        page.getByRole("heading", { name: "My requests", exact: true }),
      ).toBeVisible();
    else
      await expect(page.locator("main table tbody tr").first()).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      `${path} must not scroll the page sideways`,
    ).toBe(0);
    // Containment must come from a region a keyboard can reach, never from
    // clipped or dropped data.
    const tables = await page.evaluate(() => {
      const all = [...document.querySelectorAll("main table")];
      return {
        total: all.length,
        rows: document.querySelectorAll("main table tbody tr").length,
        outsideRegion: all.filter(
          (table) => table.closest('[role="region"][tabindex="0"]') === null,
        ).length,
      };
    });
    expect(
      tables.outsideRegion,
      `${path} renders a table outside a scroll region`,
    ).toBe(0);
    if (tables.total > 0) expect(tables.rows).toBeGreaterThan(0);
  }
  await page.goto("/dashboard");
  const sourceRegion = page.getByRole("region", {
    name: "Source health",
    exact: true,
  });
  await expect(sourceRegion).toBeVisible();
  await expect(
    page
      .locator(".table-region")
      .filter({ has: sourceRegion })
      .getByText(/More columns/),
  ).toBeVisible();
  await page.goto("/reports?dataset=seed&metric=requester");
  const satisfaction = page.getByRole("region", {
    name: "Satisfaction responses",
    exact: true,
  });
  await expect(satisfaction.locator("tbody tr").first()).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBe(0);
});

test("a failed queue refresh keeps its rows and presents a readable retry action", async ({
  page,
}) => {
  await enter(page);
  await page.goto("/review");
  await expect(page.locator("tbody tr").first()).toBeVisible();
  const before = await page.locator("tbody tr").allTextContents();
  await page.route("**/api/queue**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "REQUEST_FAILED" }),
    }),
  );
  await page
    .getByRole("link", { name: "Needs a coordinator", exact: true })
    .click();
  const alert = page.locator('.usa-alert[role="alert"]');
  await expect(alert).toContainText(
    "The queue could not be refreshed. Previously loaded requests are still shown.",
  );
  expect(await page.locator("tbody tr").allTextContents()).toEqual(before);
  const message = alert.locator(".usa-alert__text");
  await expect(message).toBeVisible();
  const geometry = await message.evaluate((element) => {
    const box = element.closest(".usa-alert__body")!;
    const icon = getComputedStyle(box, "::before");
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    return {
      textLeft:
        range.getBoundingClientRect().left - box.getBoundingClientRect().left,
      iconRight: Number.parseFloat(icon.left) + Number.parseFloat(icon.width),
      alertWidth: box.getBoundingClientRect().width,
    };
  });
  expect(Number.isFinite(geometry.iconRight)).toBe(true);
  expect(geometry.textLeft).toBeGreaterThanOrEqual(geometry.iconRight);
  const retry = alert.getByRole("button", {
    name: "Retry loading",
    exact: true,
  });
  expect((await retry.boundingBox())!.width).toBeLessThan(
    geometry.alertWidth / 2,
  );
  await page.unroute("**/api/queue**");
  await retry.click();
  await expect(alert).toHaveCount(0);
  const filtered = await page.evaluate(async () =>
    (await fetch("/api/queue?reviewer=unassigned")).json(),
  );
  expect(filtered.rows.length).toBeGreaterThan(0);
  expect(
    filtered.rows.every(
      (row: { coordinatorActorId: string | null }) =>
        row.coordinatorActorId === null,
    ),
  ).toBe(true);
});

/**
 * Holds autosave responses for the two workspace drafts until released, and
 * records every business request issued meanwhile, so a request that escaped
 * before its saves finished is observable rather than merely late.
 */
async function holdWorkspaceSaves(page: Page, draftId: string) {
  const saved: string[] = [];
  const issued: string[] = [];
  const held: Array<() => void> = [];
  let holding = true;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/intake-workspace" &&
      request.method() === "POST"
    )
      issued.push(request.postDataJSON()?.action ?? "unknown");
  });
  await page.route("**/api/wip", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const scope = request.postDataJSON() as {
      pageKey?: string;
      subjectKey?: string;
    };
    // Only the two drafts this workspace writes count as its saves.
    const mine =
      scope.pageKey === "requester-submission" ||
      (scope.pageKey === "requester-requirements" &&
        (scope.subjectKey ?? "").startsWith(draftId));
    if (!mine || !holding) return route.continue();
    await new Promise<void>((resolve) => held.push(resolve));
    await route.continue();
    saved.push(scope.pageKey ?? "");
  });
  return {
    heldCount: () => held.length,
    savedScopes: () => [...saved],
    issued: () => [...issued],
    release: async () => {
      holding = false;
      for (const resume of held.splice(0)) resume();
    },
  };
}

test("a submission saves both drafts before it sends, then announces and navigates", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  const draftId = new URL(page.url()).searchParams.get("draft") ?? "";

  const workspace = await intakeWorkspace(page);
  const savedProblem = (workspace as { content: { problem: string } }).content
    .problem;

  // The hold goes in before any edit. A draft flushes 450ms after its last
  // change, so an edit made first is already saved when the submission runs.
  const holds = await holdWorkspaceSaves(page, draftId);

  // Both drafts must be dirty while the form stays on its submit branch.
  // workspaceState reads refine from changedContent against the saved content,
  // so editing a field and restoring it advances the requirements draft
  // without making the workspace treat the request as changed.
  await page
    .getByRole("button", { name: "Edit these details", exact: true })
    .click();
  const problemField = page.getByLabel("Problem to solve");
  await problemField.fill(savedProblem + " ");
  await problemField.fill(savedProblem);
  await page
    .getByRole("button", { name: "Finish editing", exact: true })
    .click();
  await page.getByRole("radio", { name: "4", exact: true }).check();
  const submission = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/intake-workspace" &&
      response.request().postDataJSON()?.action === "submit",
  );
  await page.getByRole("button", { name: "Send request", exact: true }).click();

  // Both drafts are held, and no submission escapes while they are.
  await expect
    .poll(() => holds.heldCount(), { timeout: 20000 })
    .toBeGreaterThanOrEqual(2);
  expect(holds.issued()).toEqual([]);
  await holds.release();

  const response = await submission;
  expect(response.status(), await response.text()).toBe(200);
  expect(new Set(holds.savedScopes())).toEqual(
    new Set(["requester-requirements", "requester-submission"]),
  );
  expect(holds.issued()).toEqual(["submit"]);

  const payload = response.request().postDataJSON() as {
    input: { idempotencyKey?: string; rating?: number };
  };
  expect(payload.input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(payload.input.rating).toBe(4);

  const result = (await response.json()) as { displayId: string };
  await expect(page).toHaveURL(/\/my$/);
  await expect(page.locator("#confirmation")).toContainText(result.displayId);

  // The key that was sent is the one the submission draft holds.
  const finish = (await browserRead(
    page,
    "/api/wip?" +
      new URLSearchParams({
        actingView: "requester",
        pageKey: "requester-submission",
        subjectKey: draftId,
      }),
  )) as { payload?: Record<string, string> } | null;
  expect(finish?.payload?.idempotencyKey).toBe(payload.input.idempotencyKey);
});

test("a preparation saves the previous-content snapshot and the key before it sends", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  const draftId = new URL(page.url()).searchParams.get("draft") ?? "";

  // run() stores the workspace content as it stood before this preparation,
  // which is the provider's structured content rather than the typed need.
  const before = (await intakeWorkspace(page)) as {
    content: Record<string, unknown>;
  };

  // The hold goes in before the edit, so the requirements save is still
  // outstanding when the preparation flushes both drafts.
  const holds = await holdWorkspaceSaves(page, draftId);
  await page
    .getByRole("button", { name: "Edit these details", exact: true })
    .click();
  await page
    .getByLabel("Problem to solve")
    .fill(String(before.content.problem) + " Restore drills are recorded.");
  const prepared = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/intake-workspace" &&
      response.request().postDataJSON()?.action === "prepare",
  );
  await page
    .getByRole("button", { name: "Update my request", exact: true })
    .click();

  await expect
    .poll(() => holds.heldCount(), { timeout: 20000 })
    .toBeGreaterThanOrEqual(2);
  expect(holds.issued()).toEqual([]);
  await holds.release();

  const response = await prepared;
  expect(response.status(), await response.text()).toBe(200);
  expect(holds.issued()).toEqual(["prepare"]);

  // Preparation carries no rating and no key in its payload.
  const payload = response.request().postDataJSON() as {
    input: Record<string, unknown>;
  };
  expect(payload.input.rating).toBeUndefined();
  expect(payload.input.idempotencyKey).toBeUndefined();
  expect(payload.input.draftId).toBe(draftId);

  // The submission draft holds the key and the exact snapshot of the content
  // as it stood before this preparation.
  const finish = (await browserRead(
    page,
    "/api/wip?" +
      new URLSearchParams({
        actingView: "requester",
        pageKey: "requester-submission",
        subjectKey: draftId,
      }),
  )) as { payload?: Record<string, string> } | null;
  expect(finish?.payload?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  const snapshot = JSON.parse(
    finish?.payload?._previousContent ?? "null",
  ) as Record<string, unknown>;
  expect(snapshot).toEqual(before.content);

  // Preparation stays on the draft. #confirmation is a permanent live region,
  // so its emptiness is what shows no announcement was made.
  await expect(page).not.toHaveURL(/\/my$/);
  await expect(page.locator("#confirmation")).toHaveText("");
});

test("a refused submission keeps the requester on the draft and reloads it", async ({
  page,
}) => {
  await enter(page);
  await startRequest(page);
  await page.getByRole("radio", { name: "4", exact: true }).check();

  // One refusal, then the route is released so the reload after the failure
  // reads the real workspace rather than a stubbed one.
  let refused = false;
  await page.route("**/api/intake-workspace", async (route) => {
    if (refused || route.request().postDataJSON()?.action !== "submit")
      return route.continue();
    refused = true;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "INTERNAL", message: "refused" }),
    });
  });

  const reloaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/api/intake-workspace/") &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await reloaded;

  // A failure refreshes in place: no announcement, no navigation.
  await expect(page).not.toHaveURL(/\/my$/);
  await expect(page.locator("#confirmation")).toHaveText("");
  await expect(
    page.getByRole("button", { name: "Send request", exact: true }),
  ).toBeEnabled();
});
