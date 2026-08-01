import { execFileSync } from "node:child_process";
import type { Page, APIRequestContext } from "@playwright/test";

export const ACCOUNTS = {
  alice: "e2e.alice@hospital.org",
  bob: "e2e.bob@hospital.org",
  carol: "e2e.carol@hospital.org",
  newcomer: "e2e.newcomer@hospital.org",
  chief: "e2e.chief@hospital.org",
  pd: "e2e.pd@hospital.org",
  apd: "e2e.apd@hospital.org",
  admin: "e2e.admin@hospital.org",
  pending: "e2e.pending@hospital.org",
  deactivated: "e2e.deactivated@hospital.org",
  otherAdmin: "e2e.other.admin@hospital.org",
  otherResident: "e2e.other.resident@hospital.org",
};

/** Rebuilds the deterministic fixture in the database the server is using. */
export function resetFixture(): void {
  execFileSync("npx", ["tsx", "scripts/e2e-fixture.ts"], { stdio: "pipe" });
}

/**
 * Signs in through the test-login endpoint, which only exists when the server
 * runs with ALLOW_TEST_LOGIN=true outside production. It creates a real
 * database-backed session — the same one Google sign-in would create.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  const response = await page.request.post("/api/auth/test-login", {
    data: { email },
  });
  if (!response.ok()) {
    throw new Error(`test login failed for ${email}: ${response.status()}`);
  }
}

export async function signInApi(
  request: APIRequestContext,
  email: string,
): Promise<void> {
  const response = await request.post("/api/auth/test-login", { data: { email } });
  if (!response.ok()) {
    throw new Error(`test login failed for ${email}: ${response.status()}`);
  }
}

export async function signOut(page: Page): Promise<void> {
  await page.request.post("/api/auth/signout");
}
