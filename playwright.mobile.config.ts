import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

/**
 * End-to-end tests for the *native client*.
 *
 * The compiled app is served as a static bundle from its own origin, exactly
 * as the Capacitor webview serves it, and it talks to a real Next.js server
 * backed by the real database over CORS with a bearer token. That means this
 * suite exercises the parts that only exist in the native path and cannot be
 * covered by the web suite: cross-origin preflight, bearer authentication,
 * every API contract the app depends on, and the screens themselves.
 *
 * What it deliberately does not cover, because a browser cannot: the Capacitor
 * plugins (push registration, secure storage, the OS back button) and the
 * signed native binaries. Those are listed as untested in the verification
 * report rather than assumed to work.
 *
 *   npm run test:e2e:mobile
 */
const API_PORT = Number(process.env.MOBILE_E2E_API_PORT ?? 3100);
const APP_PORT = Number(process.env.MOBILE_E2E_APP_PORT ?? 4173);
const apiURL = `http://localhost:${API_PORT}`;
const baseURL = `http://localhost:${APP_PORT}`;
const chromium = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./tests/e2e-mobile",
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
    // The app is portrait-phone only, so there is one project rather than the
    // web suite's phone/desktop pair.
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: `npm run dev -- -p ${API_PORT}`,
      url: `${apiURL}/api/session`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ALLOW_TEST_LOGIN: "true",
        // The native origin during this run. In a real build the origins are
        // capacitor://localhost and https://localhost, which are allowed by
        // default in src/server/http/cors.ts.
        MOBILE_ALLOWED_ORIGINS: baseURL,
        APP_URL: apiURL,
      },
    },
    {
      // `--mode development` matters on both commands: the production guard in
      // vite.config.ts refuses a non-https API URL, which is exactly what it
      // should do — this run is deliberately not a production build.
      command: `npm run build:dev && npx vite preview --mode development --port ${APP_PORT} --strictPort --outDir dist`,
      cwd: "mobile",
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        VITE_API_URL: apiURL,
        VITE_ALLOW_TEST_LOGIN: "true",
        VITE_ENVIRONMENT: "development",
      },
    },
  ],
});
