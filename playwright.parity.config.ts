import { defineConfig } from "@playwright/test";

// Both builds must use the same prepared fixture; this suite does not run a worker.
export default defineConfig({
  testDir: "./test",
  testMatch: "visual-parity.acceptance.ts",
  outputDir: "./playwright-parity-results",
  snapshotDir: "./test/parity-snapshots",
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 180000,
  expect: { timeout: 20000, toHaveScreenshot: { maxDiffPixels: 0 } },
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:4188",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "America/Chicago",
    colorScheme: "light",
    launchOptions: {
      args: ["--disable-font-subpixel-positioning", "--disable-lcd-text"],
    },
  },
  projects: [
    { name: "desktop" },
    {
      name: "text200",
      use: {
        // Temporary Page.setFontSizes overrides are reset by screenshot capture.
        launchOptions: {
          args: [
            "--disable-font-subpixel-positioning",
            "--disable-lcd-text",
            "--blink-settings=defaultFontSize=32,defaultFixedFontSize=26",
          ],
        },
      },
    },
  ],
});
