import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import postgres from "postgres";
import { runWorkerLoop } from "../src/models/worker.ts";
import { browserModel, fieldNeed } from "./browser-model.ts";

export interface VisualFixture {
  capturedOn: string;
  sessions: Record<string, Awaited<ReturnType<BrowserContext["storageState"]>>>;
  drafts: Record<string, string>;
}

const target = process.env.PARITY_SETUP_URL;
const code = process.env.PARITY_ACCESS_CODE;
const database = process.env.DATABASE_URL;
const fixturePath = ".harness/visual-fixture.json";
assert.ok(
  target && ["127.0.0.1", "localhost"].includes(new URL(target).hostname),
);
assert.notEqual(
  new URL(target).port,
  "4180",
  "Never prepare visual fixtures in the live demo",
);
assert.ok(code, "PARITY_ACCESS_CODE is required");
assert.ok(
  database && new URL(database).pathname.startsWith("/one_door_parity"),
  "Use an isolated one_door_parity database",
);
assert.equal(
  existsSync(fixturePath),
  false,
  "Visual fixture already exists; preserve it for the before/after comparison",
);
const sql = postgres(database, { max: 1 });

async function read(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(path + " returned " + response.status);
      return response.json();
    },
    { path, body },
  );
}

async function session(browser: Browser) {
  const context = await browser.newContext({
    baseURL: target,
    locale: "en-US",
    timezoneId: "America/Chicago",
  });
  const page = await context.newPage();
  await page.goto("/review");
  await page.getByLabel("Demo code").fill(code!);
  await page.getByRole("button", { name: "Enter demo", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Review queue", exact: true }),
  ).toBeVisible();
  const metadata = await read(page, "/api/metadata");
  const rows =
    await sql`select id from visitors where id = ${metadata.visitor.visitorId}`;
  assert.equal(
    rows.length,
    1,
    "HTTP app and fixture worker must use the same database",
  );
  return { context, page };
}

async function begin(page: Page, description: string) {
  await page.goto("/new");
  await page.getByLabel("What do you need to accomplish?").fill(description);
  await page
    .getByLabel("Requesting agency or office")
    .selectOption({ label: "Budget Office" });
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page).toHaveURL(/draft=/);
  return new URL(page.url()).pathname + new URL(page.url()).search;
}

async function settled(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Your request", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Save draft and return to my requests",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByText(/^(Saving your draft…|Draft changes waiting to save…)$/),
  ).toHaveCount(0);
}

async function requesterFixtures(browser: Browser, fixture: VisualFixture) {
  const { context, page } = await session(browser);
  const controller = new AbortController();
  const worker = runWorkerLoop({
    provider: browserModel,
    workerId: "visual-fixture-only",
    idleDelayMs: 50,
    signal: controller.signal,
  });
  try {
    fixture.drafts.questions = await begin(page, fieldNeed);
    await settled(page);
    fixture.drafts.refined = await begin(page, fieldNeed);
    await settled(page);
    await page
      .getByLabel("Which details are on the current paper form?", {
        exact: true,
      })
      .fill("Rock type, GPS coordinates, and sample condition");
    await page
      .getByLabel("What do other teams need to do with the findings?", {
        exact: true,
      })
      .fill("Find and view each submitted field report");
    await page
      .getByRole("button", { name: "Update my request", exact: true })
      .click();
    await settled(page);
    await expect(page.locator("ins").first()).toBeVisible();
    fixture.drafts.strong = await begin(
      page,
      "Strong fit demonstration: The Budget Office needs to deploy its forecasting application to Colorado Azure with agency sign-in, a managed database, monitoring, and a tested restore path.",
    );
    await settled(page);
    await expect(
      page.locator('section[aria-labelledby="suggestion-heading"]'),
    ).toBeVisible();
  } finally {
    controller.abort();
    await worker;
  }
  fixture.drafts.waiting = await begin(page, fieldNeed);
  await expect(page.getByRole("progressbar")).toBeVisible();
  assert.equal(
    Number(
      (await sql`select count(*) from model_jobs where status='leased'`)[0]
        .count,
    ),
    0,
  );
  fixture.sessions.requester = await context.storageState();
  await context.close();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const fixture: VisualFixture = {
    capturedOn: new Date().toISOString().slice(0, 10),
    sessions: {},
    drafts: {},
  };
  const ordinary = await session(browser);
  fixture.sessions.static = await ordinary.context.storageState();
  await ordinary.context.close();
  await requesterFixtures(browser, fixture);
  await mkdir(".harness", { recursive: true });
  await writeFile(fixturePath, JSON.stringify(fixture), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Visual fixtures saved; fake worker stopped. Reuse them for both builds.",
  );
} finally {
  await browser.close();
  await sql.end();
}
