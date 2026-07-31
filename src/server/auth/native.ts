import { createHash, randomBytes } from "node:crypto";
import { query, queryOne } from "@/server/db/pool";
import { AppError } from "@/server/http/errors";
import { issueSessionToken } from "./session";

/**
 * Handing a session to the native app.
 *
 * The OAuth callback cannot put a session token in a `shiftswitch://` redirect:
 * on Android another application may register the same scheme and read it out
 * of the URL. So the redirect carries a single-use code, valid for two minutes,
 * bound to a PKCE challenge the app generated before opening the browser. Only
 * the app that started the sign-in can redeem it, and only once, over HTTPS.
 */

const CODE_TTL_MS = 2 * 60_000;

export const APP_SCHEME = process.env.MOBILE_APP_SCHEME ?? "shiftswitch";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Creates the one-time code the browser redirect will carry. */
export async function createHandoffCode(
  userId: string,
  challenge: string,
): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO native_auth_codes (code_hash, user_id, challenge, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hash(code), userId, challenge, new Date(Date.now() + CODE_TTL_MS)],
  );
  return code;
}

export interface RedeemedSession {
  token: string;
  expiresAt: Date;
  userId: string;
}

/**
 * Exchanges the code for a real session token. Fails closed on anything
 * unexpected: unknown code, expired code, already redeemed, or a verifier that
 * does not match the challenge the code was created with.
 */
export async function redeemHandoffCode(
  code: string,
  codeVerifier: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<RedeemedSession> {
  const row = await queryOne<{
    id: string;
    user_id: string;
    challenge: string;
    redeemed_at: Date | null;
    expires_at: Date;
  }>(
    "SELECT id, user_id, challenge, redeemed_at, expires_at FROM native_auth_codes WHERE code_hash = $1",
    [hash(code)],
  );

  const invalid = new AppError(
    "unauthenticated",
    "That sign-in link is no longer valid. Please sign in again.",
  );
  if (!row) throw invalid;
  if (row.redeemed_at) throw invalid;
  if (row.expires_at.getTime() <= Date.now()) throw invalid;
  if (row.challenge !== pkceChallengeFromVerifier(codeVerifier)) throw invalid;

  // Mark redeemed first; a second concurrent attempt updates zero rows.
  const claimed = await query<{ id: string }>(
    "UPDATE native_auth_codes SET redeemed_at = now() WHERE id = $1 AND redeemed_at IS NULL RETURNING id",
    [row.id],
  );
  if (claimed.length === 0) throw invalid;

  const { token, expiresAt } = await issueSessionToken(row.user_id, meta);
  return { token, expiresAt, userId: row.user_id };
}

export async function purgeExpiredHandoffCodes(): Promise<number> {
  const rows = await query<{ id: string }>(
    "DELETE FROM native_auth_codes WHERE expires_at < now() - interval '1 hour' RETURNING id",
  );
  return rows.length;
}

/** The custom-scheme URL the OAuth callback redirects a native sign-in to. */
export function nativeCallbackUrl(params: {
  code?: string;
  error?: string;
}): string {
  const query = new URLSearchParams();
  if (params.code) query.set("code", params.code);
  if (params.error) query.set("error", params.error);
  return `${APP_SCHEME}://auth/callback?${query.toString()}`;
}
