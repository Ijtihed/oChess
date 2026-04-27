import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config — end-to-end smoke against the local dev server.
 *
 * Scope: flows that don't require a second user, real email, or Google
 * OAuth. Vitest already covers the per-component logic; these tests
 * catch integration regressions that only surface in a real browser
 * (CSS at small viewports, route transitions, lazy-chunk hydration,
 * keyboard nav).
 *
 * The `webServer` block boots `npm run dev` automatically when you run
 * `npm run e2e`. CI can run the same command after `npx playwright
 * install --with-deps chromium`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 5"], viewport: { width: 360, height: 740 } },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
