import {
  expect,
  test,
  type BrowserContext,
  type ElementHandle,
  type Page,
} from "@playwright/test";

const requestId = "08da46a7-a463-5b17-a589-8681f9c579ba";
let reviewerCookies: Awaited<ReturnType<BrowserContext["cookies"]>>;

// These are one reviewer's interactions; separate auth tests exercise the gate and its limits.
test.beforeAll(async ({ browser }, info) => {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  try {
    const page = await context.newPage();
    await page.goto("/review");
    await page.getByLabel("Demo code").fill(process.env.DEMO_ACCESS_CODE!);
    await page.getByRole("button", { name: "Enter demo", exact: true }).click();
    await expect(page.getByLabel("Choose view", { exact: true })).toBeVisible();
    reviewerCookies = await context.cookies();
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(reviewerCookies);
});

async function enter(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByLabel("Choose view", { exact: true })).toBeVisible();
}

async function browserRead(page: Page, path: string) {
  return page.evaluate(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(path + " returned " + response.status);
    return response.json();
  }, path);
}

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

function factorCard(page: Page, label: string) {
  return page.locator('#priority [data-factor="' + label.toLowerCase() + '"]');
}

/* The factor's editor opens from the line's Edit toggle. */
async function openFactorEditor(card: ReturnType<Page["locator"]>) {
  const toggle = card.locator("button[aria-expanded]").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}

async function expectAllQueueRows(page: Page) {
  const url = new URL(page.url());
  const query = url.searchParams;
  if (!query.has("reviewer"))
    query.set("reviewer", url.pathname.startsWith("/admin") ? "all" : "me");
  const { total } = await browserRead(page, "/api/queue?" + query);
  expect(total).toBeGreaterThan(20);
  expect(total).toBeLessThanOrEqual(100);
  await expect(page.locator("tbody tr")).toHaveCount(total);
  await expect(
    page.getByRole("navigation", { name: "Request list pages" }),
  ).toHaveCount(0);
  return total;
}

async function expectAllCatalogRows(page: Page) {
  const { items } = await browserRead(page, "/api/inventory");
  expect(items.length).toBeGreaterThan(20);
  await expect(page.locator("tbody tr")).toHaveCount(items.length);
  await expect(
    page.getByRole("navigation", { name: "Catalog pages" }),
  ).toHaveCount(0);
}

test("sortable tables start with a visible direction and plain-text column controls", async ({
  page,
}) => {
  await enter(page, "/review");
  for (const path of [
    "/review",
    "/admin/requests",
    "/catalog?state=all",
    "/dashboard?show=all",
    "/reports?dataset=seed",
  ]) {
    await page.goto(path);
    await expect(page.locator("tbody tr").first()).toBeVisible();
    const tables = page
      .locator("table")
      .filter({ has: page.locator("thead button") });
    for (const table of await tables.all()) {
      const sorted = table.locator("th[aria-sort]");
      await expect(sorted).toHaveCount(1);
      expect(
        await sorted.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      ).not.toBe("rgb(151, 212, 234)");
      await expect(sorted.locator('[aria-hidden="true"]')).toHaveText(/[↑↓]/);
      const button = sorted.getByRole("button");
      expect(
        await button.evaluate(
          (element) => getComputedStyle(element).textDecorationLine,
        ),
      ).toBe("none");
      await expect(table.locator("thead a")).toHaveCount(0);
    }
  }
});

test("desktop queues fit without scroll buttons, clipped arrows or pointer focus boxes", async ({
  page,
}) => {
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await enter(page, "/admin/requests");
    await expectAllQueueRows(page);
    const region = page.locator(".table-region [role=region]");
    expect(
      await region.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBe(0);
    await expect(
      page.getByRole("button", { name: /Scroll (left|right)/ }),
    ).toHaveCount(0);
    for (const button of await page.locator("thead button").all()) {
      await button.click();
      await expect(page.locator('div[aria-busy="true"]')).toHaveCount(0);
      await expect(button).toHaveCSS("outline-style", "none");
      const geometry = await button.evaluate((element) => {
        const heading = element.closest("th")!;
        const arrow = element
          .querySelector('[aria-hidden="true"]')!
          .getBoundingClientRect();
        const label = element.children[1].getBoundingClientRect();
        return {
          contained:
            arrow.left >= label.right &&
            arrow.right <= heading.getBoundingClientRect().right,
          clipped: heading.scrollWidth > heading.clientWidth,
        };
      });
      expect(geometry).toEqual({ contained: true, clipped: false });
    }
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("thead button:focus")).toHaveCSS(
      "outline-style",
      "solid",
    );
    await page.locator("caption").click();
    await expect(region).toHaveCSS("outline-style", "none");
    expect(
      await page
        .locator("tbody td")
        .first()
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(16);
  }
});

test("the queue opens longest-wait first and can sort by submission date", async ({
  page,
}) => {
  await enter(page, "/admin/requests");
  await expectAllQueueRows(page);
  await expect(
    page.getByRole("columnheader", { name: "Sort by Wait", exact: true }),
  ).toHaveAttribute("aria-sort", "descending");
  const days = (
    await page.locator("tbody tr td:nth-child(5)").allTextContents()
  ).map(Number);
  expect(days.every(Number.isFinite)).toBe(true);
  expect(days).toEqual([...days].sort((a, b) => b - a));
  await page
    .getByRole("button", { name: "Sort by Submitted", exact: true })
    .click();
  await expect(page).toHaveURL(/sort=submitted&dir=asc/);
  await expect(page.locator('div[aria-busy="true"]')).toHaveCount(0);
  const dates = (
    await page.locator("tbody tr td:nth-child(6)").allTextContents()
  ).map(Date.parse);
  expect(dates.every(Number.isFinite)).toBe(true);
  expect(dates).toEqual([...dates].sort((a, b) => a - b));
  await page.reload();
  await expect(
    page.getByRole("columnheader", { name: "Sort by Submitted", exact: true }),
  ).toHaveAttribute("aria-sort", "ascending");
});

test("a queue exceeding 100 results paginates in groups of 100", async ({
  page,
}) => {
  await enter(page, "/admin/requests");
  const data = await browserRead(page, "/api/queue?reviewer=all");
  const rows = Array.from({ length: 101 }, (_, index) => ({
    ...data.rows[index % data.rows.length],
    requestId: "pagination-" + index,
    title: "Pagination request " + (index + 1),
  }));
  await page.route("**/api/queue?**", (route) => {
    const current = Number(
      new URL(route.request().url()).searchParams.get("page") ?? 1,
    );
    return route.fulfill({
      json: {
        ...data,
        total: rows.length,
        pageCount: 2,
        page: current,
        rows: rows.slice((current - 1) * 100, current * 100),
      },
    });
  });
  await page.reload();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  const pages = page.getByRole("navigation", { name: "Request list pages" });
  await expect(pages).toContainText("Page 1 of 2");
  await pages.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("Pagination request 101");
  await expect(pages).toContainText("Page 2 of 2");
  await pages
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
});

async function scrollPosition(page: Page) {
  return page
    .locator(".table-region [role=region]")
    .first()
    .evaluate((element) => ({
      windowX: window.scrollX,
      windowY: window.scrollY,
      tableX: element.scrollLeft,
      tableY: element.scrollTop,
    }));
}

test("queue sort and filter retain rows and scroll while a delayed response is pending", async ({
  page,
}) => {
  await enter(page, "/admin/requests?sort=title&dir=asc");
  await expectAllQueueRows(page);
  const table = await page.locator("table").elementHandle();
  await page.locator(".table-region [role=region]").evaluate((element) => {
    element.scrollTop = 140;
    window.scrollTo(0, 160);
  });
  const position = await scrollPosition(page);
  const originalRows = await page.locator("tbody").innerText();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/queue?**", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("button", { name: "Sort by Request", exact: true })
      .evaluate((element: HTMLElement) =>
        element.focus({ preventScroll: true }),
      );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/sort=title&dir=desc/);
    await expect(
      page.getByRole("status").filter({ hasText: "Updating requests…" }),
    ).toBeVisible();
    expect(await table!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.locator("tbody")).toHaveText(originalRows, {
      useInnerText: true,
    });
    expect(await scrollPosition(page)).toEqual(position);
  } finally {
    release();
  }
  await expect(
    page.getByRole("status").filter({ hasText: "Updating requests…" }),
  ).toHaveCount(0);
  expect(await scrollPosition(page)).toEqual(position);
  expect(await table!.evaluate((element) => element.isConnected)).toBe(true);
  await page.unrouteAll({ behavior: "wait" });
  await checkFilteredQueue(page, table!);
});

async function checkFilteredQueue(
  page: Page,
  table: ElementHandle<HTMLElement | SVGElement>,
) {
  const originalRows = await page.locator("tbody").innerText();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/queue?**", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByLabel("Current RICE score", { exact: true })
      .selectOption("yes");
    await expect(
      page.getByRole("status").filter({ hasText: "Updating requests…" }),
    ).toBeVisible();
    expect(await table.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.locator("tbody")).toHaveText(originalRows, {
      useInnerText: true,
    });
  } finally {
    release();
  }
  await expect(
    page.getByRole("status").filter({ hasText: "Updating requests…" }),
  ).toHaveCount(0);
  await expect(page.locator("tbody")).not.toContainText("Not scored");
  expect(await table.evaluate((element) => element.isConnected)).toBe(true);
}

test("history navigation is quiet: legacy links land on the assessment and the return works", async ({
  page,
}) => {
  await enter(page, "/review/" + requestId + "?section=request");
  // The legacy section value lands on the assessment.
  await expect(page.locator("#fit")).toBeVisible();
  const history = page.getByRole("link", {
    name: "Request history",
    exact: true,
  });
  await history.click();
  await expect(page.locator("#history")).toBeVisible();
  // The reference view offers no link to itself and no next-action detour.
  await expect(
    page.getByRole("link", { name: "Request history", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Next: / })).toHaveCount(0);
  const region = page.getByRole("region", {
    name: "Request details",
    exact: true,
  });
  await expect(region).not.toHaveAttribute("tabindex");
  expect(
    await region.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe("none");
  await backToAssessment(page);
});

test("queue scope links distinguish pointer selection from keyboard focus", async ({
  page,
}) => {
  await enter(page, "/review");
  const scopes = page.getByRole("navigation", { name: "Request views" });
  const unassigned = scopes.getByRole("link", {
    name: "Needs a coordinator",
    exact: true,
  });
  await unassigned.click();
  await expect(unassigned).toHaveAttribute("aria-current", "page");
  await expect(unassigned).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Shift+Tab");
  const mine = scopes.getByRole("link", {
    name: "Assigned to me",
    exact: true,
  });
  await expect(mine).toBeFocused();
  await expect(mine).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(mine).toHaveAttribute("aria-current", "page");
});

test("sorting a horizontally scrolled queue keeps both table offsets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", {
    fontSizes: { standard: 32, fixed: 26 },
  });
  await enter(page, "/admin/requests");
  await expectAllQueueRows(page);
  await page.locator(".table-region [role=region]").evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
    element.scrollTop = 120;
    window.scrollTo(
      0,
      element.getBoundingClientRect().top + window.scrollY - 160,
    );
  });
  const before = await scrollPosition(page);
  expect(before.tableX).toBeGreaterThan(0);
  expect(before.tableY).toBeGreaterThan(0);
  const heading = page.getByRole("button", {
    name: "Sort by RICE",
    exact: true,
  });
  await expect(heading).toBeInViewport();
  await heading.evaluate((element: HTMLElement) =>
    element.focus({ preventScroll: true }),
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/sort=score&dir=asc/);
  await expect(page.locator('div[aria-busy="true"]')).toHaveCount(0);
  expect(await scrollPosition(page)).toEqual(before);
});

test("an empty catalog filter retains its table, current sort and page position", async ({
  page,
}) => {
  await enter(page, "/catalog?state=all");
  const region = page.getByRole("region", {
    name: "Governed inventory",
    exact: true,
  });
  await expectAllCatalogRows(page);
  const table = await region.locator("table").elementHandle();
  await page.evaluate(() => window.scrollTo(0, 120));
  const before = {
    y: await page.evaluate(() => window.scrollY),
    height: (await region.boundingBox())!.height,
  };
  await page
    .getByLabel("Find an item", { exact: true })
    .fill("no-such-catalog-item-browser-check");
  await expect(region.locator("tbody tr")).toHaveCount(0);
  expect(await table!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(region.locator('th[aria-sort="ascending"]')).toContainText(
    "Item",
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(before.y);
  expect((await region.boundingBox())!.height).toBe(before.height);
  await page
    .getByRole("button", { name: "Show all catalog entries", exact: true })
    .click();
  await expectAllCatalogRows(page);
  expect(await table!.evaluate((element) => element.isConnected)).toBe(true);
});

test("an empty queue reports the result above its fixed-height table", async ({
  page,
}) => {
  await enter(page, "/review?phase=received");
  const status = page
    .getByRole("status")
    .filter({ hasText: "No requests match" });
  await expect(status).toBeVisible();
  const table = page.locator("table");
  expect((await status.boundingBox())!.y).toBeLessThan(
    (await table.boundingBox())!.y,
  );
  await expect(
    page.getByRole("button", {
      name: "Find requests needing a coordinator",
      exact: true,
    }),
  ).toBeVisible();
});

test("the selected sort remains visible when its column is off-screen", async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", {
    fontSizes: { standard: 32, fixed: 26 },
  });
  try {
    await enter(page, "/review?sort=score&dir=desc");
    await expectAllQueueRows(page);
    expect(
      await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      ),
    ).toBe(32);
    const heading = page.getByRole("columnheader", {
      name: "Sort by RICE",
      exact: true,
    });
    expect((await heading.boundingBox())!.x).toBeGreaterThan(
      page.viewportSize()!.width,
    );
    const status = page
      .getByRole("status")
      .filter({ hasText: "Sorted by RICE" });
    await status.scrollIntoViewIfNeeded();
    await expect(status.getByText("↓", { exact: true })).toBeInViewport();
  } finally {
    await cdp.send("Page.setFontSizes", {
      fontSizes: { standard: 16, fixed: 13 },
    });
  }
});

test("a failed queue update keeps the previous results and can be retried", async ({
  page,
}) => {
  await enter(page, "/admin/requests");
  const count = await expectAllQueueRows(page);
  const table = await page.locator("table").elementHandle();
  await page.route("**/api/queue?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "REQUEST_FAILED" }),
    }),
  );
  await page
    .getByLabel("Current RICE score", { exact: true })
    .selectOption("yes");
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  expect(await table!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.locator("tbody tr")).toHaveCount(count);
  await page.unrouteAll({ behavior: "wait" });
  await page
    .getByRole("button", { name: "Retry loading", exact: true })
    .click();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(page.locator("tbody")).not.toContainText("Not scored");
  expect(await table!.evaluate((element) => element.isConnected)).toBe(true);
});

test("priority factor drafts keep entered values and reject junk or unsupported precision with the reason", async ({
  page,
}) => {
  await enter(page, "/review/" + requestId + "?section=priority");
  await expect(page.getByText("Loading your draft…")).toHaveCount(0);
  const effort = factorCard(page, "Effort");
  await openFactorEditor(effort);
  await effort
    .getByLabel("How will you handle this estimate?", { exact: true })
    .selectOption("replace");
  const days = effort.getByLabel("Total working days", { exact: true });
  const effortDraftSaved = (body: {
    pageKey?: string;
    payload?: { value?: string; basis?: string };
  }) =>
    body?.pageKey === "priority-effort" &&
    body?.payload?.value === "60" &&
    Boolean(body?.payload?.basis);
  const saved = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/wip") return false;
    const request = response.request();
    if (request.method() !== "POST") return false;
    return response.ok() && effortDraftSaved(request.postDataJSON());
  });
  await days.fill("60");
  await effort
    .getByLabel("What supports this estimate?", { exact: true })
    .fill("Fictional estimate for browser verification");
  await saved;
  await page.reload();
  await openFactorEditor(effort);
  await expect(
    effort.getByLabel("How will you handle this estimate?", { exact: true }),
  ).toHaveValue("replace");
  await expect(days).toHaveValue("60");
  // A junk entry never silently becomes a number, and an entry the stored
  // precision cannot hold is refused with the reason instead of rounded.
  await days.fill("letters");
  await expect(days).toHaveValue("letters");
  await days.fill("0.1");
  await expect(
    effort.getByText(
      "Enter more than zero and no more than 200,000 working days, in steps of 0.2 days.",
      { exact: true },
    ),
  ).toBeVisible();
  await days.fill("60");
  await expect(
    effort.getByText(
      "Enter more than zero and no more than 200,000 working days, in steps of 0.2 days.",
      { exact: true },
    ),
  ).toHaveCount(0);
  const confidence = factorCard(page, "Confidence");
  await openFactorEditor(confidence);
  await confidence
    .getByLabel("How will you handle this estimate?", { exact: true })
    .selectOption("replace");
  const percent = confidence.getByLabel("Confidence (%)", {
    exact: true,
  });
  await percent.fill("1.5");
  await expect(
    confidence.getByText(
      "Enter 0.01% to 100%, in steps of 0.01 percentage points.",
      {
        exact: true,
      },
    ),
  ).toHaveCount(0);
  await percent.fill("1.555");
  await expect(
    confidence.getByText(
      "Enter 0.01% to 100%, in steps of 0.01 percentage points.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
});

test("earlier estimate drafts report read failures and recover through retry", async ({
  page,
}) => {
  let failed = true;
  let payload: Record<string, string> | null = null;
  let pending: Promise<void> | undefined;
  await page.route("**/api/wip?**", async (route) => {
    const request = route.request();
    const query = new URL(request.url()).searchParams;
    if (
      request.method() !== "GET" ||
      query.get("actingView") !== "contributor" ||
      query.get("pageKey") !== "rice" ||
      query.get("subjectKey") !== requestId
    )
      return route.continue();
    await pending;
    const data = payload ? { payload } : null;
    return route.fulfill({
      status: failed ? 503 : 200,
      json: failed ? { error: "UNAVAILABLE" } : data,
    });
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    failed = true;
    payload = null;
    await enter(page, "/review/" + requestId + "?section=priority");
    const priority = page.locator("#priority");
    const error = priority.getByRole("alert");
    const loading = priority.getByText("Loading earlier estimate drafts…", {
      exact: true,
    });
    const earlier = priority.locator("details").filter({
      has: page.locator("summary", { hasText: "Your earlier estimate drafts" }),
    });
    await expect(error).toContainText(
      "Could not load your earlier estimate drafts.",
    );
    const reach = factorCard(page, "Reach");
    await openFactorEditor(reach);
    await expect(
      reach.getByLabel("How will you handle this estimate?", { exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBe(0);

    await test.step("a retry reports loading and successful absence", async () => {
      failed = false;
      let release!: () => void;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await error.getByRole("button", { name: "Retry loading" }).click();
      try {
        await expect(loading).toBeVisible();
      } finally {
        release();
        pending = undefined;
      }
      await expect(loading).toHaveCount(0);
      await expect(error).toHaveCount(0);
      await expect(earlier).toHaveCount(0);
    });

    failed = true;
    await page.reload();
    await expect(error).toBeVisible();
    failed = false;
    payload = { reach: "275", effort: "3" };
    await error.getByRole("button", { name: "Retry loading" }).click();
    await earlier.locator("summary").click();
    await expect(earlier).toContainText("275");
    await expect(earlier).toContainText("3 person-months");
    await expect(error).toHaveCount(0);
  }
});

test("reach keeps the whole-count entry of the retired dialog", async ({
  page,
}) => {
  await enter(page, "/review/" + requestId + "?section=priority");
  await expect(page.getByText("Loading your draft…")).toHaveCount(0);
  const reach = factorCard(page, "Reach");
  await openFactorEditor(reach);
  await reach
    .getByLabel("How will you handle this estimate?", { exact: true })
    .selectOption("replace");
  const count = reach.getByLabel("Reach count", { exact: true });
  await expect(count).toHaveAttribute("inputmode", "numeric");
  await expect(count).toHaveAttribute("pattern", "[0-9]+");
  await count.fill("250");
  await count.press("ArrowUp");
  await expect(count).toHaveValue("250");
  for (const junk of ["letters", "1.25", "-12", "1e3"]) {
    await count.fill(junk);
    await expect(count).toHaveValue("250");
  }
  // A failed draft save must not lose the entry: the browser backup
  // restores the count after reload, as the retired wizard promised.
  await page.route("**/api/wip", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } })
      : route.continue(),
  );
  await count.fill("275");
  await page.waitForTimeout(1200);
  await page.unroute("**/api/wip");
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByText("Loading your draft…")).toHaveCount(0);
  await openFactorEditor(reach);
  await expect(count).toHaveValue("275");
});

test("administrator notes live in the history section and the assessment stays clean", async ({
  page,
}) => {
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await enter(page, "/admin/requests/" + requestId);
    await expect(
      page.getByRole("heading", {
        name: "Confirmed request",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("New administrator note")).toHaveCount(0);
    await openHistory(page);
    await expect(
      page.getByRole("heading", { name: "Administrator notes", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("New administrator note", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBe(0);
  }
});

test("administrator notes save, survive retry and reload, and appear read-only for reviewers", async ({
  page,
}) => {
  await enter(page, "/admin/requests/" + requestId);
  await openHistory(page);
  const note = "Browser note " + crypto.randomUUID();
  const field = page.getByLabel("New administrator note", { exact: true });
  await expect(field).toBeEnabled();
  await field.fill(note);
  await page.reload();
  await expect(field).toHaveValue(note);
  const posted = page.waitForRequest((request) =>
    request.url().endsWith("/api/admin/actions"),
  );
  await page.getByRole("button", { name: "Record note", exact: true }).click();
  const payload = (await posted).postDataJSON();
  await expect(
    page.getByText("Note recorded.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(field).toHaveValue("");
  const replay = await page.evaluate(async (input) => {
    const response = await fetch("/api/admin/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  }, payload);
  expect(replay.status).toBe(200);
  expect(replay.body.id).toBe(payload.input.noteId);
  await page.goto("/review/" + requestId);
  await openHistory(page);
  const notes = page.getByRole("region", {
    name: "Recorded notes",
    exact: true,
  });
  await expect(notes.getByText(note, { exact: true })).toHaveCount(1);
  await expect(notes.locator("time").last()).toHaveAttribute("datetime", /T/);
  await expect(
    page.getByLabel("New administrator note", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(notes.getByText(note, { exact: true })).toHaveCount(1);
});

test("a late note confirmation cannot erase a draft written after reopening the section", async ({
  page,
}) => {
  await enter(page, "/admin/requests/" + requestId);
  await openHistory(page);
  const note = "Delayed browser note " + crypto.randomUUID();
  const next = "Draft after reopening " + crypto.randomUUID();
  const field = page.getByLabel("New administrator note", { exact: true });
  await expect(field).toBeEnabled();
  await field.fill(note);
  let release!: () => void;
  let stored!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    stored = resolve;
  });
  await page.route("**/api/admin/actions", async (route) => {
    const response = await route.fetch();
    stored();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("button", { name: "Record note", exact: true })
      .click();
    await committed;
    await backToAssessment(page);
    await openHistory(page);
    await expect(field).toBeEnabled();
    await field.fill(next);
  } finally {
    release();
  }
  await expect(
    page
      .getByRole("region", {
        name: "Recorded notes",
        exact: true,
      })
      .getByText(note, { exact: true }),
  ).toHaveCount(1);
  await expect(field).toHaveValue(next);
  await page.reload();
  await expect(field).toHaveValue(next);
});

test("concurrent retries create one administrator note", async ({ page }) => {
  await enter(page, "/admin/requests/" + requestId);
  const noteId = crypto.randomUUID();
  const body = "Concurrent browser note " + noteId;
  const results = await page.evaluate(
    async (input) =>
      Promise.all(
        Array.from({ length: 4 }, async () => {
          const response = await fetch("/api/admin/actions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "addAdministratorNote", input }),
          });
          return { status: response.status, note: await response.json() };
        }),
      ),
    { requestId, noteId, body },
  );
  for (const result of results) {
    expect(result.status).toBe(200);
    expect(result.note.id).toBe(noteId);
  }
  await page.goto("/review/" + requestId);
  await openHistory(page);
  await expect(
    page
      .getByRole("region", {
        name: "Recorded notes",
        exact: true,
      })
      .getByText(body, { exact: true }),
  ).toHaveCount(1);
});

type Box = { x: number; y: number; width: number; height: number };

function boxesOverlap(a: Box, b: Box): boolean {
  return !(
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y ||
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x
  );
}

/* A tap must not flash or retain pointer-only hover styling. */
async function expectRestingAfterTap(
  target: ReturnType<Page["locator"]>,
  property: "color" | "backgroundColor",
  resting: string,
  painted = target,
) {
  expect(
    await painted.evaluate(
      (element, prop) => getComputedStyle(element)[prop],
      property,
    ),
  ).toBe(resting);
  await target.tap();
  await target.page().waitForTimeout(150);
  expect(
    await painted.evaluate(
      (element, prop) => getComputedStyle(element)[prop],
      property,
    ),
  ).toBe(resting);
}

/* Both dimensions meet the 44px touch minimum (height only for wide
 * prose targets, where width is the whole line). */
async function expectTouchSize(
  target: ReturnType<Page["locator"]>,
  bothDimensions = true,
): Promise<Box> {
  const box = (await target.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  if (bothDimensions) expect(box.width).toBeGreaterThanOrEqual(44);
  return box;
}

/* elementFromPoint works in viewport coordinates: prove the measured
 * edge points are on screen before hit-testing them. */
function expectEdgePointsOnScreen(page: Page, points: number[]) {
  const viewport = page.viewportSize()!;
  for (const y of points) {
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(viewport.height);
  }
}

/* The touch styling gates on these media features; fail loudly if the
 * emulation does not provide them rather than passing vacuously. */
async function expectCoarsePointer(page: Page) {
  expect(
    await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
  ).toBe(true);
  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(
    false,
  );
}

/* The navigation anchors outside the brief meet the minimum too, and
 * the round trip works by tap. */
async function expectTouchNavigationAnchors(page: Page) {
  const history = page.getByRole("link", {
    name: "Request history",
    exact: true,
  });
  await expectTouchSize(history);
  await history.tap();
  await expect(page.locator("#history")).toBeVisible();
  const back = page.getByRole("link", {
    name: "Return to review",
    exact: true,
  });
  await expectTouchSize(back);
  await back.tap();
  await expect(page.locator("#fit")).toBeVisible();
}

async function factorAtPoint(page: Page, x: number, y: number) {
  return page.evaluate(
    ([px, py]) =>
      (
        document
          .elementFromPoint(px, py)
          ?.closest("[data-factor]") as HTMLElement | null
      )?.dataset.factor ?? null,
    [x, y],
  );
}

test("touch taps leave no pointer-hover styling and brief targets meet the touch minimum", async ({
  browser,
}, info) => {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    await context.addCookies(reviewerCookies);
    const page = await context.newPage();
    await page.goto("/review/" + requestId);
    await expect(page.getByLabel("Choose view", { exact: true })).toBeVisible();
    await expectCoarsePointer(page);
    await expect(page.getByText("Loading your draft…")).toHaveCount(0);
    const reachEdit = page
      .locator('[data-factor="reach"] button[aria-expanded]')
      .first();
    const impactEdit = page
      .locator('[data-factor="impact"] button[aria-expanded]')
      .first();
    // Priority sits below the fold at 390: bring the factor rows into
    // view BEFORE reading boxes, because elementFromPoint works in
    // viewport coordinates. Measure and hit-test before any tap opens
    // an editor and moves Impact.
    await page.locator("#priority").scrollIntoViewIfNeeded();
    await expect(reachEdit).toBeInViewport();
    await expect(impactEdit).toBeInViewport();
    const reachBox = await expectTouchSize(reachEdit);
    const impactBox = await expectTouchSize(impactEdit);
    expectEdgePointsOnScreen(page, [
      reachBox.y + reachBox.height - 2,
      impactBox.y + 2,
    ]);
    // Adjacent factor controls own disjoint boxes, and the advertised
    // edges actually hit their own control.
    expect(boxesOverlap(reachBox, impactBox)).toBe(false);
    expect(
      await factorAtPoint(
        page,
        reachBox.x + reachBox.width / 2,
        reachBox.y + reachBox.height - 2,
      ),
    ).toBe("reach");
    expect(
      await factorAtPoint(
        page,
        impactBox.x + impactBox.width / 2,
        impactBox.y + 2,
      ),
    ).toBe("impact");
    await expectRestingAfterTap(reachEdit, "color", "rgb(0, 94, 162)");
    await expectTouchNavigationAnchors(page);
    // The other measured brief controls meet the minimum too: quiet
    // summaries (height; the row is the width) and USWDS buttons.
    await expectTouchSize(
      page.getByText("Review responsibilities (optional)", {
        exact: true,
      }),
      false,
    );
    await expectTouchSize(
      page.getByRole("button", { name: "Record progress", exact: true }),
    );
    const claim = page.locator("button[data-claim]").first();
    await expect(claim).toBeVisible();
    const claimBox = await expectTouchSize(claim, false);
    // The claim's expanded hit box stays clear of the neighbouring claim.
    const second = page.locator("button[data-claim]").nth(1);
    if ((await second.count()) > 0)
      expect(boxesOverlap(claimBox, (await second.boundingBox())!)).toBe(false);
    await expectRestingAfterTap(
      claim,
      "backgroundColor",
      "rgb(238, 244, 249)",
      claim.locator(":scope > span").first(),
    );
  } finally {
    await context.close();
  }
});

/* The retired form's WIP write failed: the question exists only as the
 * controller's local backup. Seed that exact shape, keyed by scope. */
async function seedLegacyBackup(page: Page): Promise<string> {
  return page.evaluate(
    async ({ requestId }) => {
      const response = await fetch("/api/metadata");
      if (!response.ok) throw new Error("metadata " + response.status);
      const metadata = await response.json();
      const viewResponse = await fetch(
        "/api/request-view/" + requestId + "?view=contributor",
      );
      if (!viewResponse.ok)
        throw new Error("request-view " + viewResponse.status);
      const view = await viewResponse.json();
      const key = JSON.stringify({
        visitorId: metadata.visitor.visitorId,
        actingView: "contributor",
        pageKey: "ask-input",
        subjectKey: requestId,
      });
      localStorage.setItem(
        key,
        JSON.stringify({
          values: {
            factor: "reach",
            question: "Legacy reach question from the retired form?",
            scope: "",
            expertise: "records",
            addressee: "",
            inputRequestId: "",
            // A real RecordForm draft always stored _recordVersion.
            _recordVersion: String(view.record.rowVersion),
          },
          unsent: true,
        }),
      );
      return key;
    },
    { requestId },
  );
}

test("a legacy ask draft that never reached the server resurfaces from the browser backup", async ({
  page,
}) => {
  await enter(page, "/review/" + requestId);
  await expect(page.getByText("Loading your draft…")).toHaveCount(0);
  const scopeKey = await seedLegacyBackup(page);
  try {
    await page.reload();
    await expect(page.getByText("Loading your draft…")).toHaveCount(0);
    const reach = factorCard(page, "Reach");
    const effort = factorCard(page, "Effort");
    await openFactorEditor(reach);
    await openFactorEditor(effort);
    // Visible exactly once, in Reach's editor, with the saved words.
    const recovered = page.getByText("Recover your earlier unsent question", {
      exact: true,
    });
    await expect(recovered).toHaveCount(1);
    await expect(
      reach.getByText("Recover your earlier unsent question"),
    ).toBeVisible();
    await expect(
      effort.getByText("Recover your earlier unsent question"),
    ).toHaveCount(0);
    await recovered.click();
    await expect(
      reach.getByRole("textbox", {
        name: "Question",
        exact: true,
      }),
    ).toHaveValue("Legacy reach question from the retired form?");
  } finally {
    // Remove the backup this test wrote, and empty the server row the
    // controller auto-persisted from it, so later runs start clean.
    await page.evaluate(
      async ({ key, requestId }) => {
        localStorage.removeItem(key);
        const query = new URLSearchParams({
          actingView: "contributor",
          pageKey: "ask-input",
          subjectKey: requestId,
        });
        const current = await fetch("/api/wip?" + query);
        const existing = current.ok ? await current.json() : null;
        if (!existing?.payload?.question) return;
        await fetch("/api/wip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actingView: "contributor",
            pageKey: "ask-input",
            subjectKey: requestId,
            payload: { ...existing.payload, question: "" },
            expectedRowVersion: existing.rowVersion ?? 0,
            route: "/review/" + requestId,
          }),
        });
      },
      { key: scopeKey, requestId },
    );
  }
});

test("shared controls keep touch targets on delivery, history, notes, and the shell", async ({
  browser,
}, info) => {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    await context.addCookies(reviewerCookies);
    const page = await context.newPage();
    await enter(page, "/review");
    const queue = await browserRead(page, "/api/queue?reviewer=all&scored=yes");
    const scored = queue.rows.find(
      (row: { score: string | null; requestId: string }) => row.score !== null,
    );
    expect(scored?.requestId).toBeTruthy();
    for (const [section, id] of [
      ["delivery", requestId],
      ["history", scored.requestId],
    ]) {
      await enter(page, "/admin/requests/" + id + "?section=" + section);
      await expectCoarsePointer(page);
      await expect(page.locator("#" + section)).toBeVisible();
      await expect(page.getByText("Loading your draft…")).toHaveCount(0);
      await expandReferenceForms(page, section);
      await expectSharedTouchTargets(page);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBe(0);
    }
  } finally {
    await context.close();
  }
});

async function expandReferenceForms(page: Page, section: string) {
  const names =
    section === "delivery"
      ? ["Link existing work", "Record final outcome"]
      : ["Recorded scores and estimates"];
  for (const name of names) {
    const summary = page.locator("summary").filter({ hasText: name });
    await expect(summary).toBeVisible();
    await summary.click();
  }
  if (section === "history") {
    await page
      .locator("summary")
      .filter({ hasText: /^Score version/ })
      .first()
      .click();
    await expect(
      page.getByRole("region", { name: /^Estimates for score version/ }),
    ).toHaveAttribute("tabindex", "0");
    await expect(
      page.getByRole("button", { name: /^Sort by Factor/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Sort by Value/ }),
    ).toBeVisible();
  }
}

async function expectSharedTouchTargets(page: Page) {
  const targets = page.locator(
    "button:visible, select:visible, summary:visible, .app-header__brand, .usa-sidenav a",
  );
  expect(await targets.count()).toBeGreaterThan(5);
  for (const target of await targets.all()) await expectTouchSize(target);
  const skip = page.locator(".usa-skipnav");
  await skip.focus();
  await expectTouchSize(skip);
}

async function expectSeparatedButtons(group: ReturnType<Page["locator"]>) {
  const buttons = group.locator(":scope > button:visible");
  expect(await buttons.count()).toBeGreaterThanOrEqual(2);
  const boxes = await buttons.evaluateAll((elements) =>
    elements.map((element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom };
    }),
  );
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      const gap = Math.max(
        other.left - box.right,
        box.left - other.right,
        other.top - box.bottom,
        box.top - other.bottom,
      );
      expect(gap).toBeGreaterThanOrEqual(12);
    }
  }
}

async function expectCompleteSearchBorder(page: Page) {
  const search = page.getByLabel("Find an item", { exact: true });
  await expect(search).toBeVisible();
  const border = await search.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      right: style.borderRightWidth,
      left: style.borderLeftWidth,
      float: style.cssFloat,
      fits: box.right <= document.documentElement.clientWidth,
    };
  });
  expect(parseFloat(border.right)).toBeGreaterThan(0);
  expect(border.right).toBe(border.left);
  expect(border.float).toBe("none");
  expect(border.fits).toBe(true);
}

test("standalone search and wrapped review buttons retain their boundaries", async ({
  page,
}) => {
  await enter(page, "/catalog");
  for (const width of [1440, 1000, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectCompleteSearchBorder(page);
  }
  await enter(page, "/review/" + requestId);
  await expect(page.locator("#fit")).toBeVisible();
  await expect(page.getByText("Loading your draft…")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Search the catalog", exact: true }),
  ).toBeVisible();
  for (const section of ["fit", "risk"]) {
    const claim = page.locator("#" + section + " button[data-claim]").first();
    await claim.click();
    const panel = page.locator(
      '[data-claimpanel="' + (await claim.getAttribute("data-claim")) + '"]',
    );
    await expect(panel).toBeVisible();
    const group = panel.locator("fieldset > div").filter({
      has: page.locator("button[aria-pressed]"),
    });
    for (const width of [1440, 1000, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectSeparatedButtons(group);
    }
  }
  const progress = page.getByRole("button", {
    name: "Record progress",
    exact: true,
  });
  await expect(progress).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete first review", exact: true }),
  ).toBeVisible();
  await expectSeparatedButtons(progress.locator(".."));
});

test("policy findings occupy separate rows with their severity and status", async ({
  page,
}) => {
  await enter(page, "/review/" + requestId);
  const claims = page.locator("#risk button[data-claim]");
  await expect(claims.first()).toBeVisible();
  expect(await claims.count()).toBeGreaterThan(1);
  for (const width of [1440, 700, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    let previousBottom = 0;
    for (const claim of await claims.all()) {
      const row = claim.locator("..");
      await expect(row.locator(":scope > button[data-claim]")).toHaveCount(1);
      await expect(claim.locator(":scope > span")).toHaveCount(3);
      const box = (await row.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(previousBottom);
      previousBottom = box.y + box.height;
    }
  }
  const first = claims.first();
  await first.click();
  const panel = page.locator(
    '[data-claimpanel="' + (await first.getAttribute("data-claim")) + '"]',
  );
  await expect(panel).toBeVisible();
  const firstBox = (await first.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  const nextBox = (await claims.nth(1).locator("..").boundingBox())!;
  expect(panelBox.y).toBeGreaterThanOrEqual(firstBox.y + firstBox.height);
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(nextBox.y);
  await claims.nth(1).click();
  await expect(page.locator("#risk [data-claimpanel]")).toHaveCount(1);
  await expect(panel).toHaveCount(0);
});

async function expectTrailingStatus(claim: ReturnType<Page["locator"]>) {
  const layout = await claim.evaluate((button) => {
    const label = button.querySelector(":scope > span:first-child")!;
    const status = button.querySelector(":scope > span:last-child")!;
    const fragments = Array.from(label.getClientRects());
    const last = fragments.at(-1)!;
    const marker = status.getBoundingClientRect();
    const available = button.getBoundingClientRect().right - last.right;
    return {
      wrapped: fragments.length > 1,
      fits: available >= marker.width + 8,
      sameLine: marker.top < last.bottom && marker.bottom > last.top,
    };
  });
  if (layout.wrapped && layout.fits) expect(layout.sameLine).toBe(true);
  return layout.wrapped && layout.fits;
}

test("options use one introduction and keep fitting statuses on the last text line", async ({
  page,
}) => {
  await enter(page, "/review");
  const queue = await browserRead(
    page,
    "/api/queue?reviewer=all&q=legal%20hold",
  );
  const record = queue.rows.find(
    (row: { fixtureKey: string | null }) =>
      row.fixtureKey === "request:public-records-legal-hold",
  );
  expect(record).toBeTruthy();
  await enter(page, "/review/" + record.requestId);
  await expect(
    page.getByText("This review includes 2 existing options.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#fit > ul > li")).toHaveCount(2);
  const claims = page.locator("#fit button[data-claim]");
  let wrappedStatusChecked = false;
  for (const width of [1440, 1000, 700, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const claim of await claims.all()) {
      await expect(claim).toHaveAccessibleName(/Awaiting decision/);
      const checked = await expectTrailingStatus(claim);
      wrappedStatusChecked ||= checked;
    }
  }
  expect(wrappedStatusChecked).toBe(true);
  const first = claims.first();
  await first.focus();
  await first.press("Enter");
  await expect(page.locator("#fit [data-claimpanel]")).toBeVisible();
  await first.press("Space");
  await expect(page.locator("#fit [data-claimpanel]")).toHaveCount(0);
});

test("completion guidance names and links only the sections with remaining work", async ({
  page,
}) => {
  await enter(page, "/review");
  const queue = await browserRead(
    page,
    "/api/queue?reviewer=all&q=legal%20hold",
  );
  const record = queue.rows.find(
    (row: { fixtureKey: string | null }) =>
      row.fixtureKey === "request:public-records-legal-hold",
  );
  expect(record).toBeTruthy();
  await enter(page, "/review/" + record.requestId);
  const completion = page.locator("#completion");
  await expect(
    completion.getByText("Needed to complete review", { exact: true }),
  ).toBeVisible();
  const fit = completion.getByRole("link", {
    name: "Existing options",
    exact: true,
  });
  await expect(fit).toHaveAttribute("href", "#fit-heading");
  await expect(
    completion.getByRole("link", { name: "Policy findings", exact: true }),
  ).toHaveCount(0);
  await expect(completion).toContainText("In Policy findings,");
  await expect(
    completion.getByRole("link", { name: "Priority estimates", exact: true }),
  ).toHaveCount(0);
  await expect(completion).not.toContainText("A question closes only when");
  await fit.focus();
  await fit.press("Enter");
  await expect(page.locator("#fit-heading")).toBeFocused();
  const reach = factorCard(page, "Reach");
  await openFactorEditor(reach);
  const action = reach.locator("#priority-action-reach");
  await action.selectOption("replace");
  await expect(
    completion.getByRole("link", { name: "Priority estimates", exact: true }),
  ).toHaveAttribute("href", "#priority-heading");
  await action.selectOption("");
  await expect(
    completion.getByRole("link", { name: "Priority estimates", exact: true }),
  ).toHaveCount(0);
});
