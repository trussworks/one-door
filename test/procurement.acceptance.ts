import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

async function checkCriteriaPage(page: Page) {
  await page
    .getByRole("link", { name: "Visualize acceptance criteria", exact: true })
    .click();
  const criteria = page.frameLocator("#acceptance-frame");
  await expect(page.locator("#acceptance-frame")).toBeVisible();
  await expect(criteria.locator("li[data-criterion]")).toHaveCount(28);
  await criteria.locator("#ac-contact").click();
  await expect(criteria.locator("#criterion-contact")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await criteria.locator("#criterion-templates").hover();
  await expect(criteria.locator("#commit-templates")).toBeVisible();
  await expect(criteria.locator("#criterion-contact")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(criteria.locator("#commit-templates")).toBeHidden();
  await criteria
    .getByRole("link", {
      name: "Explore procurement relationships",
      exact: true,
    })
    .click();
  await expect(page.locator("#acceptance-frame")).toBeHidden();
}

test("the procurement link requires the code, returns to the prototype, and keeps both pages interactive", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/procurement");
  await expect(page).toHaveURL(/\/procurement-access$/);
  await expect(page.getByLabel("Demo code")).toBeVisible();
  await expect(page.locator("#role-picker")).toHaveCount(0);

  await page.getByLabel("Demo code").fill(process.env.DEMO_ACCESS_CODE!);
  await page.getByRole("button", { name: "Enter demo", exact: true }).click();
  await expect(page).toHaveURL(/\/procurement(?:#.*)?$/);
  await expect(page.locator("#role-picker")).toBeVisible();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(page.locator(".zoom__count")).toHaveText("Levels: 2 of 3");
  await page
    .locator('.rel[data-edge="d-finance-purchasing"] circle.rel__hit')
    .click();
  await expect(page.locator("#detail-heading")).toContainText(
    "OIT Finance to OIT Purchasing",
  );
  const state = new URL(page.url()).hash;

  await checkCriteriaPage(page);
  expect(new URL(page.url()).hash).toBe(state);
  await expect(page.locator(".zoom__count")).toHaveText("Levels: 2 of 3");

  // Chromium sends Secure cookies on HTTP 127.0.0.1; Playwright's request
  // client does not. Fetch in the browser and refuse a followed redirect.
  const served = await page.evaluate(async () => {
    const response = await fetch("/procurement", { redirect: "manual" });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await response.arrayBuffer(),
    );
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      sha256: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
  });
  expect(served).toEqual({
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: "private, no-store",
    sha256: createHash("sha256")
      .update(readFileSync("src/server/procurement-prototypes.html"))
      .digest("hex"),
  });
  await page.reload();
  await expect(page.locator(".zoom__count")).toHaveText("Levels: 2 of 3");
  await page.goto("/procurement-access" + state);
  await expect(page).toHaveURL(/\/procurement(?:#.*)?$/);
  await expect(page.locator(".zoom__count")).toHaveText("Levels: 2 of 3");
  expect(errors).toEqual([]);
});

test("the fixed login handoff preserves the criteria fragment and ignores redirect destinations", async ({
  page,
}) => {
  await page.goto(
    "/procurement-access?next=https%3A%2F%2Fexample.com#criteria",
  );
  await page.getByLabel("Demo code").fill(process.env.DEMO_ACCESS_CODE!);
  await page.getByRole("button", { name: "Enter demo", exact: true }).click();
  await expect(page).toHaveURL(/\/procurement#criteria$/);
  await expect(page.locator("#acceptance-frame")).toBeVisible();
  await expect(
    page.frameLocator("#acceptance-frame").locator("#vac-introduction"),
  ).toContainText("acceptance criteria");
});

test("the acceptance frame stays interactive under the deployed framing policy", async ({
  page,
}, testInfo) => {
  await page.route("**/procurement", async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "x-frame-options": "DENY",
        "content-security-policy":
          "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
      },
    });
  });
  await page.goto("/procurement#criteria");
  await page.getByLabel("Demo code").fill(process.env.DEMO_ACCESS_CODE!);
  const protectedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/procurement" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Enter demo", exact: true }).click();
  const response = await protectedResponse;
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["content-security-policy"]).toBe(
    "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  await expect(page).toHaveURL(/\/procurement#criteria$/);
  const criteria = page.frameLocator("#acceptance-frame");
  await expect(page.locator("#acceptance-frame")).toBeVisible();
  await criteria.locator("#ac-contact").click();
  await expect(criteria.locator("#criterion-contact")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.screenshot({ path: testInfo.outputPath("criteria.png") });
  await criteria
    .getByRole("link", {
      name: "Explore procurement relationships",
      exact: true,
    })
    .click();
  await expect(page.locator("#acceptance-frame")).toBeHidden();
  await expect(page.locator("#role-picker")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("orbit.png") });
});
