import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";

export const ACCOUNTS = {
  alice: "e2e.alice@hospital.org",
  bob: "e2e.bob@hospital.org",
  carol: "e2e.carol@hospital.org",
  chief: "e2e.chief@hospital.org",
  admin: "e2e.admin@hospital.org",
  pending: "e2e.pending@hospital.org",
};

/** Rebuilds the deterministic fixture in the database the API server uses. */
export function resetFixture(env: Record<string, string> = {}): void {
  execFileSync("npx", ["tsx", "scripts/e2e-fixture.ts"], {
    stdio: "pipe",
    env: { ...process.env, ...env },
  });
}

/**
 * Signs in the way the native app does: through the app's own sign-in screen,
 * so the token handling, the storage layer and the API client are all
 * exercised rather than bypassed.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Sign in as").fill(email);
  await page.getByRole("button", { name: "Sign in without Google" }).click();

  // Wait until the session is actually established and stored. Returning early
  // lets a following `goto` navigate away mid-sign-in, which drops the token
  // and produces a confusing "signed out" failure much later.
  await expect(
    page.getByRole("navigation", { name: "Main" }).or(
      page.getByRole("heading", { name: "Almost there" }),
    ),
  ).toBeVisible();
}

/** The device rows the server has recorded for a user, by email. */
export function registeredDevices(email: string): Array<{
  platform: string;
  has_push_token: boolean;
}> {
  const output = execFileSync(
    "npx",
    ["tsx", "scripts/e2e-devices.ts", email],
    { encoding: "utf8" },
  );
  const line = output.trim().split("\n").at(-1) ?? "[]";
  return JSON.parse(line);
}

/** Clears the stored session so the next load starts signed out. */
export async function signOutOfApp(page: Page): Promise<void> {
  await page.evaluate(() => {
    globalThis.sessionStorage.clear();
    globalThis.localStorage.clear();
  });
}
