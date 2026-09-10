// The deliberate hosted acceptance journey. It runs against a deployed origin
// only, dispatches real provider work and spends from the shared demo caps, so
// it starts nothing itself and is never part of routine checks.
import { defineConfig } from "@playwright/test";

if (!process.env.E2E_BASE_URL)
  throw new Error(
    "Set E2E_BASE_URL to the deployed origin; this journey never starts a server",
  );
if (!process.env.DEMO_ACCESS_CODE)
  throw new Error(
    "Set DEMO_ACCESS_CODE in the environment from the private access file; never paste it into a command",
  );
if (!process.env.ONE_DOOR_SMOKE_MAX_MICROS)
  throw new Error(
    "Set ONE_DOOR_SMOKE_MAX_MICROS to the cost you calculated this journey should charge; it is checked afterwards, not enforced before dispatch",
  );
if (!process.env.ONE_DOOR_SMOKE_EVIDENCE_DIR)
  throw new Error(
    "Set ONE_DOOR_SMOKE_EVIDENCE_DIR to a private directory outside outputDir; Playwright clears outputDir between runs",
  );

export default defineConfig({
  testDir: "./test",
  testMatch: ["hosted-journey.acceptance.ts"],
  // Receipts are written under ONE_DOOR_SMOKE_EVIDENCE_DIR instead, one
  // directory per run, because Playwright clears outputDir on every start.
  outputDir: "./playwright-results",
  forbidOnly: true,
  workers: 1,
  // A retry would create a second request and charge a second time.
  retries: 0,
  // One wall-clock bound for the whole journey, provider work included.
  timeout: 600000,
  expect: { timeout: 20000 },
  reporter: "list",
  use: {
    actionTimeout: 20000,
    baseURL: process.env.E2E_BASE_URL,
    channel: process.env.CI ? undefined : "chrome",
    viewport: { width: 1440, height: 1000 },
    // A failure screenshot of this journey would show the entered demo.
    screenshot: "off",
    video: "off",
    trace: "off",
  },
});
