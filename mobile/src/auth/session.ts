import { Browser } from "@capacitor/browser";
import { API_URL, ALLOW_TEST_LOGIN, APP_SCHEME } from "@/config";
import { api, ApiError } from "@/api/client";
import type { SessionResponse } from "@/api/types";
import { STORAGE_KEYS, secureGet, secureRemove, secureSet } from "@/lib/storage";
import { challengeFor, createVerifier } from "./pkce";

/**
 * The native sign-in sequence.
 *
 * 1. Generate a PKCE verifier and hold it in memory only.
 * 2. Open the system browser (not an embedded webview — Google refuses those,
 *    and it lets the resident reuse a Google session they are already signed
 *    into) at the server's Google start endpoint, passing the challenge.
 * 3. The server completes OIDC, mints a one-time code and redirects to
 *    `shiftswitch://auth/callback?code=…`.
 * 4. The app receives that URL, closes the browser, and exchanges the code plus
 *    the verifier for a session token over HTTPS.
 */

let pendingVerifier: string | null = null;

export interface StoredSession {
  token: string;
  expiresAt: string;
}

export async function loadStoredSession(): Promise<StoredSession | null> {
  const token = await secureGet(STORAGE_KEYS.sessionToken);
  if (!token) return null;
  const expiresAt = await secureGet(STORAGE_KEYS.sessionExpiry);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await clearStoredSession();
    return null;
  }
  return { token, expiresAt: expiresAt ?? "" };
}

export async function storeSession(session: StoredSession): Promise<void> {
  await secureSet(STORAGE_KEYS.sessionToken, session.token);
  if (session.expiresAt) {
    await secureSet(STORAGE_KEYS.sessionExpiry, session.expiresAt);
  }
}

export async function clearStoredSession(): Promise<void> {
  await secureRemove(STORAGE_KEYS.sessionToken);
  await secureRemove(STORAGE_KEYS.sessionExpiry);
}

/** Opens the system browser at Google sign-in. Resolves once it is open. */
export async function beginGoogleSignIn(): Promise<void> {
  const verifier = createVerifier();
  pendingVerifier = verifier;
  const challenge = await challengeFor(verifier);
  const url = `${API_URL}/api/auth/google/start?nativeChallenge=${encodeURIComponent(challenge)}`;
  await Browser.open({ url, presentationStyle: "popover" });
}

export class SignInCancelled extends Error {
  constructor() {
    super("Sign-in was cancelled.");
    this.name = "SignInCancelled";
  }
}

/**
 * Handles `shiftswitch://auth/callback`. Returns the new session, or throws an
 * ApiError whose message can be shown as-is.
 */
export async function completeSignIn(callbackUrl: string): Promise<StoredSession> {
  const url = new URL(callbackUrl);
  await Browser.close().catch(() => undefined);

  const error = url.searchParams.get("error");
  if (error) {
    throw new ApiError(
      "unauthenticated",
      error === "domain_rejected"
        ? "Your email address is not approved for this program. Contact your program administrator."
        : "Sign-in did not complete. Please try again.",
    );
  }

  const code = url.searchParams.get("code");
  const verifier = pendingVerifier;
  pendingVerifier = null;
  if (!code || !verifier) {
    throw new ApiError(
      "unauthenticated",
      "That sign-in link is no longer valid. Please sign in again.",
    );
  }

  const result = await api.post<{ token: string; expiresAt: string }>(
    "/api/auth/native/exchange",
    { code, codeVerifier: verifier },
    { allowUnauthenticated: true },
  );
  const session = { token: result.token, expiresAt: result.expiresAt };
  await storeSession(session);
  return session;
}

export function isAuthCallback(url: string): boolean {
  return url.startsWith(`${APP_SCHEME}://auth/callback`);
}

export async function fetchSession(): Promise<SessionResponse> {
  return api.get<SessionResponse>("/api/session", { allowUnauthenticated: true });
}

/**
 * Development-only sign-in for driving the app locally and in the mobile
 * end-to-end run. Compiled out of production builds by `config.ts`, and
 * rejected by the server unless it too has test login enabled.
 */
export async function testSignIn(email: string): Promise<StoredSession> {
  if (!ALLOW_TEST_LOGIN) {
    throw new ApiError("forbidden", "Test sign-in is not available in this build.");
  }
  const result = await api.post<{ token: string; expiresAt: string }>(
    "/api/auth/test-login",
    { email, native: true },
    { allowUnauthenticated: true },
  );
  const session = { token: result.token, expiresAt: result.expiresAt };
  await storeSession(session);
  return session;
}
