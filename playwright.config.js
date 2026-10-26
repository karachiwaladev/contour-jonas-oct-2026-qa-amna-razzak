// End-to-end tests for the todo app. Run with: npm run test:e2e
// Locally this uses the installed Google Chrome; in CI it uses Playwright's bundled Chromium.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "todo/tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:8765",
    channel: process.env.CI ? undefined : "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node todo/tests/server.js",
    url: "http://localhost:8765",
    reuseExistingServer: !process.env.CI,
  },
});
