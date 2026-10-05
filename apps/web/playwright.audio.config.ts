import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/audio", workers: 1, timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5184", viewport: { width: 390, height: 844 } },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5184 --strictPort",
    url: "http://127.0.0.1:5184/tests/audio/harness.html", reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
