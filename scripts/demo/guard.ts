/**
 * The safety interlock on the demo data.
 *
 * Seeding writes twenty-one users and several hundred shifts. Run against the
 * wrong database that is not a mistake anybody notices immediately — it is a
 * real program suddenly containing people who do not exist. So the demo
 * commands refuse by default and only proceed when the environment positively
 * says it is not production.
 *
 * Three independent gates, all of which must pass:
 *
 *   1. `NODE_ENV` must not be `production`.
 *   2. The target must be local — a database on this machine — unless
 *      `ALLOW_REMOTE_DEMO_DATA=true` is set deliberately, which is how a
 *      staging deployment opts in.
 *   3. Neither the database name nor `APP_URL` may look like production.
 *
 * The "does this look like production" detection itself lives in
 * `scripts/db-guard.ts`, shared with the migration reset and the end-to-end
 * fixture, so there is one answer to that question rather than one per script.
 *
 * On top of that, every destructive statement the seeder runs is scoped by the
 * demo program's *name*. Even if all three gates were somehow wrong, the worst
 * case is that a program literally called "ShiftSwitch Demo Residency" is
 * replaced — never a real one.
 */

import {
  databaseName,
  hostOf,
  isLocalDatabase,
  looksLikeProduction,
} from "../db-guard";

export interface GuardResult {
  allowed: boolean;
  reasons: string[];
  target: string;
}

export function checkDemoAllowed(
  env: Record<string, string | undefined> = process.env,
): GuardResult {
  const reasons: string[] = [];
  const databaseUrl = env.DATABASE_URL ?? "";
  const target = databaseUrl ? hostOf(databaseUrl) : "no DATABASE_URL";

  if (!databaseUrl) {
    reasons.push("DATABASE_URL is not set, so there is nothing to seed.");
    return { allowed: false, reasons, target };
  }

  if (env.NODE_ENV === "production") {
    reasons.push("NODE_ENV is 'production'. Demo data must never be seeded there.");
  }

  const remoteAllowed = env.ALLOW_REMOTE_DEMO_DATA === "true";
  if (!isLocalDatabase(databaseUrl) && !remoteAllowed) {
    reasons.push(
      `DATABASE_URL points at ${hostOf(databaseUrl)}, which is not this machine. ` +
        "If that really is a staging database, set ALLOW_REMOTE_DEMO_DATA=true to say so explicitly.",
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

/** Throws with an explanation rather than proceeding. */
export function assertDemoAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  const result = checkDemoAllowed(env);
  if (result.allowed) return;
  throw new Error(
    `Refusing to touch ${result.target}:\n` +
      result.reasons.map((reason) => `  - ${reason}`).join("\n"),
  );
}
