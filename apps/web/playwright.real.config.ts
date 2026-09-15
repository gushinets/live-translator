import { defineConfig, devices } from "@playwright/test";

const WEB_ORIGIN = "http://127.0.0.1:4173";
const PORTRAIT_VIEWPORT = { width: 390, height: 844 };

export default defineConfig({
  testDir: "./tests/real",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: {
    timeout: 30_000,
  },
  reporter: [["list"]],
  outputDir: "test-results/real-live",
  use: {
    baseURL: WEB_ORIGIN,
    viewport: PORTRAIT_VIEWPORT,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command:
        "pnpm build && node --env-file-if-exists=../../.env dist/server.js",
      cwd: "../api",
      url: "http://127.0.0.1:3001/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        WEB_ORIGIN,
      },
    },
    {
      command:
        "pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
      cwd: ".",
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium-real-live",
      use: {
        ...devices["Desktop Chrome"],
        viewport: PORTRAIT_VIEWPORT,
        screen: PORTRAIT_VIEWPORT,
      },
    },
  ],
});
