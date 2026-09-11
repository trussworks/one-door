import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";

async function draftBundle() {
  const fixture = new URL("./fixtures/draft-lifecycle/", import.meta.url);
  const result = await build({
    configFile: false,
    envDir: false,
    logLevel: "error",
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "process.env": "{}",
    },
    resolve: {
      alias: [
        {
          find: "./shell",
          replacement: fileURLToPath(new URL("metadata.ts", fixture)),
        },
      ],
    },
    build: {
      write: false,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("entry.tsx", fixture)),
        formats: ["iife"],
        name: "DraftProbe",
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("Expected an in-memory bundle");
  const chunk = output.output.find((entry) => entry.type === "chunk");
  if (!chunk) throw new Error("The draft lifecycle bundle has no script");
  return chunk.code;
}

test("an abandoned React render cannot publish review draft values", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(url.origin).toBe("https://draft-lifecycle.invalid");
    expect(request.method()).toBe("GET");
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    expect(url.pathname).toBe("/api/wip");
    const payload =
      url.searchParams.get("pageKey") === "priority-reach"
        ? {
            rowVersion: 1,
            payload: {
              action: "replace",
              value: "25",
              unit: "people",
              period: "year",
              basis: "count",
            },
          }
        : null;
    return route.fulfill({ json: payload });
  });
  await page.goto("https://draft-lifecycle.invalid/");
  await page.addScriptTag({ content: await draftBundle() });
  await page.waitForFunction(() =>
    window.draftProbe
      .snapshot()
      .some(
        (entry) =>
          entry.key === "priority:reach" &&
          entry.ready &&
          entry.values.value === "25",
      ),
  );
  const before = await page.evaluate(() => window.draftProbe.snapshot());
  await page.getByRole("button", { name: "Start transition" }).click();
  await page.waitForFunction(() => window.draftProbe.attempted);
  await expect(page.locator("[data-request]")).toHaveAttribute(
    "data-request",
    "first",
  );
  await expect(page.locator("[data-fallback]")).toHaveCount(0);
  const suspended = await page.evaluate(() => window.draftProbe.snapshot());
  await page.getByRole("button", { name: "Cancel transition" }).click();
  await page.waitForFunction(() => window.draftProbe.cancellation === 1);
  expect(suspended).toEqual(before);
  expect(await page.evaluate(() => window.draftProbe.snapshot())).toEqual(
    before,
  );
  expect(errors).toEqual([]);
});
