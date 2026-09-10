import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

const external = Boolean(process.env.E2E_BASE_URL);
if (!external) {
  if (!process.env.E2E_DATABASE_URL)
    throw new Error(
      "Set E2E_DATABASE_URL to an isolated browser-test database",
    );
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  process.env.DEMO_ACCESS_CODE ||= randomBytes(24).toString("hex");
  process.env.SESSION_SECRET ||= randomBytes(32).toString("hex");
}

export default defineConfig({
  testDir: "./test",
  testMatch: [
    "accessibility.acceptance.ts",
    "browser.acceptance.ts",
    "reviewer-interactions.acceptance.ts",
    "reviewer-contributions.acceptance.ts",
    "review-boundary.acceptance.ts",
    "focus.acceptance.ts",
  ],
  outputDir: "./playwright-results",
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: "list",
  webServer: external
    ? undefined
    : {
        command: "node --experimental-strip-types test/browser-server.ts",
        url: "http://127.0.0.1:4181/my",
        reuseExistingServer: false,
        timeout: 120000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
      },
  use: {
    actionTimeout: 15000,
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:4181",
    channel: process.env.CI ? undefined : "chrome",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
});
