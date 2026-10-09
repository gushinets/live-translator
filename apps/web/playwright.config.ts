import { defineConfig, devices } from "@playwright/test";
const previewPort=Number(process.env.PLAYWRIGHT_PREVIEW_PORT??4173);

export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/e2e/**/*.spec.ts", "**/real/orientation-harness.spec.ts"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${previewPort}`,
    trace: "on-first-retry",
    serviceWorkers: "block",
    locale: "en-US",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: `pnpm run build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${previewPort} --strictPort`,
    url: `http://127.0.0.1:${previewPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "webkit",
      // The portrait harness uses CDP, which is only available in Chromium.
      testIgnore: "**/real/orientation-harness.spec.ts",
      use: { ...devices["iPhone 13"] },
    },
  ],
});
