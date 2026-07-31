/**
 * "Is this database safe to destroy?"
 *
 * Three scripts in this repository issue statements that cannot be undone:
 *
 *   scripts/migrate.ts --reset   DROP SCHEMA public CASCADE
 *   scripts/e2e-fixture.ts       TRUNCATE ... RESTART IDENTITY CASCADE
 *   scripts/demo/seed.ts         deletes and rebuilds the demo program
 *
 * Only the third had a guard. The other two would happily execute against
 * whatever `DATABASE_URL` happened to be exported — and `npm run verify` now
 * runs both of them on every invocation, which turns a stray environment
 * variable into a destroyed database rather than a failed command.
 *
 * The gates are deliberately about the *target*, not the intent. A script
 * cannot know whether the person running it meant to; it can know that the
 * host is not this machine and refuse.
 *
 *   1. `NODE_ENV` must not be `production`.
 *   2. The host must be local, unless the caller's opt-in variable is set to
 *      "true" — which is how a staging environment says so deliberately.
 *   3. Neither the database name nor `APP_URL` may contain a production word.
 *
 * `scripts/demo/guard.ts` builds on this with demo-specific wording; the
 * detection logic lives here so there is one answer to "does this look like
 * production" rather than one per script.
 */

const PRODUCTION_WORD = /(^|[^a-z])(prod|production|live)([^a-z]|$)/i;

/**
 * Loopback hostnames. Compared against the parsed hostname rather than matched
 * against the raw URL: the string form has too many shapes to pattern-match
 * safely. `postgresql://[::1]:5432/db` brackets its host, and a pattern loose
 * enough to catch that also matches `notlocalhost.example.com` — which fails in
 * the dangerous direction.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1"]);

export function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

export function isLocalDatabase(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Unparseable: treat as remote. The whole point is to refuse when unsure.
    return false;
  }
  // `new URL` keeps the brackets on an IPv6 literal.
  return LOOPBACK.has(hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

export function looksLikeProduction(value: string): boolean {
  return PRODUCTION_WORD.test(value);
}

export interface DestructiveCheck {
  allowed: boolean;
  reasons: string[];
  target: string;
}

/**
 * @param remoteOptIn  Name of the environment variable that allows a non-local
 *                     target, so each caller opts in under its own name rather
 *                     than one blanket override unlocking everything.
 */
export function checkDestructiveAllowed(
  remoteOptIn: string,
  env: Record<string, string | undefined> = process.env,
): DestructiveCheck {
  const reasons: string[] = [];
  const databaseUrl = env.DATABASE_URL ?? "";
  const target = databaseUrl ? hostOf(databaseUrl) : "no DATABASE_URL";

  if (!databaseUrl) {
    reasons.push("DATABASE_URL is not set, so there is nothing to act on.");
    return { allowed: false, reasons, target };
  }

  if (env.NODE_ENV === "production") {
    reasons.push("NODE_ENV is 'production'.");
  }

  if (!isLocalDatabase(databaseUrl) && env[remoteOptIn] !== "true") {
    reasons.push(
      `DATABASE_URL points at ${hostOf(databaseUrl)}, which is not this machine. ` +
        `If that really is a disposable database, set ${remoteOptIn}=true to say so explicitly.`,
    );
  }

  const name = databaseName(databaseUrl);
  if (looksLikeProduction(name)) {
    reasons.push(`The database is named "${name}", which looks like production.`);
  }

  const appUrl = env.APP_URL ?? "";
  if (appUrl && looksLikeProduction(appUrl)) {
    reasons.push(`APP_URL is "${appUrl}", which looks like production.`);
  }

  return { allowed: reasons.length === 0, reasons, target };
}

/** Throws with an explanation rather than destroying anything. */
export function assertDestructiveAllowed(
  action: string,
  remoteOptIn: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const result = checkDestructiveAllowed(remoteOptIn, env);
  if (result.allowed) return;
  throw new Error(
    `Refusing to ${action} on ${result.target}:\n` +
      result.reasons.map((reason) => `  - ${reason}`).join("\n"),
  );
}
