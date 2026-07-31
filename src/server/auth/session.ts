import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { getPool, query, queryOne, type Queryable } from "@/server/db/pool";
import type { ProgramRow, ResidentRow, UserRow } from "@/server/db/types";

export const SESSION_COOKIE = "ss_session";
export const OAUTH_COOKIE = "ss_oauth";

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  pictureUrl: string | null;
  role: UserRow["role"];
  programId: string | null;
  active: boolean;
}

export interface SessionContext {
  sessionId: string;
  user: SessionUser;
  program: ProgramRow | null;
  resident: ResidentRow | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (process.env.APP_URL ?? "").startsWith("https://"),
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * Creates a database-backed session and returns the opaque token.
 *
 * The web client receives it as an httpOnly cookie; the native client receives
 * it once, over a custom-scheme redirect, and keeps it in the platform secure
 * store. Both presentations are the same row, with the same expiry and the same
 * revocation path — there is no second authentication system.
 */
export async function issueSessionToken(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      hashToken(token),
      meta.userAgent?.slice(0, 300) ?? null,
      meta.ip ? createHash("sha256").update(meta.ip).digest("hex") : null,
      expiresAt,
    ],
  );
  return { token, expiresAt };
}

/** Creates a session and sets the opaque session cookie (web clients). */
export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<string> {
  const { token } = await issueSessionToken(userId, meta);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_DAYS * 86_400));
  return token;
}

export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await query("DELETE FROM sessions WHERE token_hash = $1", [
      hashToken(token),
    ]);
  }
  store.delete(SESSION_COOKIE);
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

interface SessionJoinRow extends UserRow {
  session_id: string;
}

/**
 * Resolves the caller from the session cookie. Returns null when there is no
 * valid, unexpired session. Every authorization decision starts here — the
 * client never supplies its own role, program, or resident id.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const bearer = await bearerToken();
  if (bearer) return resolveSessionByToken(bearer);
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return resolveSessionByToken(token);
}

/**
 * The native client presents its session as `Authorization: Bearer <token>`,
 * because a WebView served from a custom scheme is cross-origin to the API and
 * cannot carry a SameSite=Lax cookie.
 */
async function bearerToken(): Promise<string | null> {
  const headerList = await headers();
  const value = headerList.get("authorization");
  if (!value) return null;
  const [scheme, token] = value.split(" ");
  if (!token || scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

/** Revokes the caller's session, whichever presentation they used. */
export async function destroyCurrentSessionAnywhere(): Promise<void> {
  const bearer = await bearerToken();
  if (bearer) {
    await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(bearer)]);
  }
  await destroyCurrentSession();
}

export async function resolveSessionByToken(
  token: string,
  executor: Queryable = getPool(),
): Promise<SessionContext | null> {
  const row = await queryOne<SessionJoinRow>(
    `SELECT u.*, s.id AS session_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
    executor,
  );
  if (!row) return null;
  if (!row.active) return null;

  const program = row.program_id
    ? await queryOne<ProgramRow>(
        "SELECT * FROM programs WHERE id = $1",
        [row.program_id],
        executor,
      )
    : null;

  const resident =
    row.role === "resident" || row.role === "chief"
      ? await queryOne<ResidentRow>(
          "SELECT * FROM residents WHERE user_id = $1 AND active = true",
          [row.id],
          executor,
        )
      : null;

  // Best-effort activity tracking; never blocks the request path.
  void query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [
    row.session_id,
  ]).catch(() => undefined);

  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      pictureUrl: row.picture_url,
      role: row.role,
      programId: row.program_id,
      active: row.active,
    },
    program,
    resident,
  };
}

// --- transient OAuth state cookie ------------------------------------------

export interface OAuthStateCookie {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  /** Set when the native app started the flow; carries its PKCE challenge. */
  nativeChallenge?: string;
}

export async function setOAuthStateCookie(
  value: OAuthStateCookie,
): Promise<void> {
  const store = await cookies();
  store.set(
    OAUTH_COOKIE,
    Buffer.from(JSON.stringify(value)).toString("base64url"),
    { ...cookieOptions(600), sameSite: "lax" },
  );
}

export async function readOAuthStateCookie(): Promise<OAuthStateCookie | null> {
  const store = await cookies();
  const raw = store.get(OAUTH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as OAuthStateCookie;
    if (!parsed.state || !parsed.nonce || !parsed.codeVerifier) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearOAuthStateCookie(): Promise<void> {
  const store = await cookies();
  store.delete(OAUTH_COOKIE);
}

export async function purgeExpiredSessions(): Promise<number> {
  const rows = await query<{ id: string }>(
    "DELETE FROM sessions WHERE expires_at < now() RETURNING id",
  );
  return rows.length;
}
