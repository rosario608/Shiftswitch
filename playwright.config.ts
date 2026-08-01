import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

/**
 * End-to-end tests run against a real Next.js server backed by the real
 * database. Sign-in uses the test-login endpoint (enabled only when
 * ALLOW_TEST_LOGIN=true and NODE_ENV is not production) so the suite does not
 * depend on Google's servers.
 */
const PORT = Number(process.env.E2E_PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const chromium = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(existsSync(chromium) ? { launchOptions: { executablePath: chromium } } : {}),
  },
  projects: [
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: `npm run dev -- -p ${PORT}`,
        url: baseURL,
        reuseExistingServer: true,
        /* Four minutes, not two. `next dev` compiles the first route on
           demand, and on a slow filesystem — which Next itself warns about in
           this container — a cold start after `npm run build` has just
           rewritten `.next` takes longer than the default allows. A timeout
           here reads as "the whole suite is broken" rather than "the server was
           still starting". */
        timeout: 240_000,
      },
});
