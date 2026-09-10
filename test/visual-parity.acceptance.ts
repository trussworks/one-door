import { readFileSync } from "node:fs";
import { test, expect, type Browser, type Page } from "@playwright/test";
import type { VisualFixture } from "./visual-fixture";

const fixture = JSON.parse(
  readFileSync(".harness/visual-fixture.json", "utf8"),
) as VisualFixture;
const request = "08da46a7-a463-5b17-a589-8681f9c579ba";
const screens = [
  ["landing", "/", "Find the right help. Keep your request moving."],
  ["my", "/my", "My requests"],
  ["new", "/new", "Describe what you need"],
  ["queue", "/review", "Review queue"],
  ["queue-sorted", "/review?sort=title&dir=asc", "Review queue"],
  ["admin-queue", "/admin/requests", "All requests"],
  ["demo", "/admin/demo", "Demo controls"],
  [
    "assessment",
    "/review/" + request + "?section=assessment",
    "Confirmed request",
  ],
  [
    "delivery",
    "/review/" + request + "?section=delivery",
    "Delivery and outcome",
  ],
  ["history", "/review/" + request + "?section=history", "Request history"],
  ["catalog", "/catalog", "Catalog"],
  [
    "catalog-record",
    "/catalog/046748b4-b5b0-55c0-a7bb-5f2fa31920b3",
    "Publication and review",
  ],
  [
    "conflict",
    "/conflicts/31555de3-af98-5609-aac1-1a4a0fa9d632",
    "Resolve source disagreement",
  ],
  ["sources", "/sources", "Inventory sources"],
  ["source", "/sources/0f6b2709-2d76-568f-a34b-75675a7e82b7", "Import history"],
  [
    "work",
    "/work-items/2765cd78-a44b-5fb9-af23-bdf272a4d3f8",
    "Related requests",
  ],
  ["dashboard", "/dashboard", "Dashboard"],
  ["reports", "/reports", "Reports"],
  [
    "report-detail",
    "/reports?metric=submissions",
    "Requests included in this measure",
  ],
] as const;

async function open(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), path + " must return a page").toBe(true);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText(/^(Loading|Calculating)/)).toHaveCount(0);
  await expect(page.locator("main .usa-alert--error")).toHaveCount(0);
}

async function context(
  browser: Browser,
  baseURL: string | undefined,
  session?: string,
) {
  expect(
    fixture.capturedOn,
    "Recreate fixtures on the baseline build for a new date",
  ).toBe(new Date().toISOString().slice(0, 10));
  return browser.newContext({
    baseURL,
    storageState: session ? fixture.sessions[session] : undefined,
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "America/Chicago",
  });
}

async function capture(page: Page, name: string, fontSize: number) {
  expect(
    await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
  ).toBe(fontSize);
  expect(
    await page.evaluate(() => matchMedia("(max-width: 60em)").matches),
  ).toBe(fontSize === 32);
  await expect.soft(page).toHaveScreenshot(name + ".png", {
    fullPage: true,
    animations: "disabled",
    mask: [page.getByRole("progressbar")],
  });
  expect(
    await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
  ).toBe(fontSize);
}

test("static screens retain complete layouts", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await context(browser, baseURL, "static");
  try {
    const page = await ctx.newPage();
    for (const [name, path, heading] of screens) {
      await open(page, path);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      await capture(page, name, info.project.name === "text200" ? 32 : 16);
      if (name === "assessment") {
        await page
          .getByRole("button", { name: "Search the catalog", exact: true })
          .click();
        await expect(
          page.getByRole("heading", {
            name: "Existing products and services",
            level: 1,
            exact: true,
          }),
        ).toBeVisible();
        await capture(
          page,
          "review-catalog",
          info.project.name === "text200" ? 32 : 16,
        );
      }
    }
  } finally {
    await ctx.close();
  }
});

test("gate remains visible before authentication", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await context(browser, baseURL);
  try {
    const page = await ctx.newPage();
    await open(page, "/review");
    await expect(
      page.getByRole("heading", { name: "Try One Door", exact: true }),
    ).toBeVisible();
    await capture(page, "gate", info.project.name === "text200" ? 32 : 16);
  } finally {
    await ctx.close();
  }
});

test("saved requester states retain summary, questions, changes, offer and wait", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await context(browser, baseURL, "requester");
  try {
    const page = await ctx.newPage();
    for (const [name, path] of Object.entries(fixture.drafts)) {
      await open(page, path);
      if (name === "waiting") {
        const progress = page.getByRole("progressbar");
        await expect(progress).toBeVisible();
        expect(
          await progress.evaluate((e) => getComputedStyle(e).accentColor),
        ).toBe("rgb(0, 94, 162)");
      } else {
        await expect(
          page.getByRole("region", { name: "Your request", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Save draft and return to my requests",
            exact: true,
          }),
        ).toBeEnabled();
      }
      if (name === "questions")
        await expect(
          page.getByRole("heading", { name: "About your work", exact: true }),
        ).toBeVisible();
      if (name === "refined")
        await expect(page.locator("ins").first()).toBeVisible();
      if (name === "strong")
        await expect(
          page.getByRole("heading", {
            name: "This may already meet your need",
            exact: true,
          }),
        ).toBeVisible();
      await capture(
        page,
        "requester-" + name,
        info.project.name === "text200" ? 32 : 16,
      );
    }
    await open(page, "/my");
    await expect(
      page.getByRole("heading", { name: "Saved drafts", exact: true }),
    ).toBeVisible();
    await capture(
      page,
      "saved-drafts",
      info.project.name === "text200" ? 32 : 16,
    );
  } finally {
    await ctx.close();
  }
});
