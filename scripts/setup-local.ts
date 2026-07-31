#!/usr/bin/env tsx
/**
 * Everything a clean checkout needs before `npm run verify` will run.
 *
 *   npm run setup:local
 *
 * Creates the two local databases, writes a working `.env.local` with a
 * generated session secret, and applies the migrations. Idempotent: run it
 * again and it reports what already existed rather than complaining.
 *
 * This exists because "clone, install, verify" did not work. `.env.local` is
 * not committed — correctly, it holds secrets — so a fresh checkout has no
 * `DATABASE_URL` and no `AUTH_SECRET`, and the failure arrived as a preflight
 * message pointing at a five-step section of `docs/SETUP.md`. For a person
 * that is a mild annoyance. For an unattended session it is a dead stop, and
 * the whole point of `verify` is that it can be the first thing anybody runs.
 *
 * It deliberately does **not** configure Google OAuth. Sign-in needs real
 * credentials from a real Google Cloud project and cannot be invented; the
 * test suites do not need it, because they sign in through the test-login
 * endpoint. `docs/SETUP.md` covers the real thing.
 *
 * Local only. It refuses to write over an existing `.env.local`, and it only
 * ever creates databases on this machine.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { isLocalDatabase } from "./db-guard";

const ENV_LOCAL = path.join(process.cwd(), ".env.local");
const DEV_DB = "shiftswitch_dev";
const TEST_DB = "shiftswitch_test";

/**
 * Where PostgreSQL is, and how to reach it.
 *
 * A locally installed PostgreSQL usually trusts the `postgres` role with no
 * password; a container usually wants `postgres:postgres`. Rather than make the
 * reader guess, try both and use whichever connects.
 */
async function findConnection(): Promise<string | null> {
  const candidates = [
    process.env.DATABASE_URL,
    "postgres://postgres@127.0.0.1:5432/postgres",
    "postgres://postgres:postgres@127.0.0.1:5432/postgres",
  ].filter((url): url is string => Boolean(url) && isLocalDatabase(url!));

  for (const url of candidates) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.end();
      return url;
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function ensureDatabase(adminUrl: string, name: string): Promise<boolean> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      name,
    ]);
    if (existing.rowCount && existing.rowCount > 0) return false;
    // No parameter binding for an identifier, so quote it explicitly. `name` is
    // one of two constants above, never user input.
    await client.query(`CREATE DATABASE "${name}"`);
    return true;
  } finally {
    await client.end();
  }
}

function writeEnvLocal(devUrl: string, testUrl: string): void {
  const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  const secret = randomBytes(48).toString("base64");
  const configured = example
    .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${devUrl}`)
    .replace(/^TEST_DATABASE_URL=.*$/m, `TEST_DATABASE_URL=${testUrl}`)
    .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`)
    // The end-to-end suites sign in through the test-login endpoint, which is
    // refused outright when NODE_ENV=production regardless of this flag.
    .replace(/^ALLOW_TEST_LOGIN=.*$/m, "ALLOW_TEST_LOGIN=true");
  writeFileSync(ENV_LOCAL, configured, { mode: 0o600 });
}

async function main(): Promise<void> {
  const adminUrl = await findConnection();
  if (!adminUrl) {
    console.error(
      "[setup] No local PostgreSQL on 127.0.0.1:5432.\n" +
        "[setup] Start it first — on Debian/Ubuntu: service postgresql start\n" +
        "[setup] Or see docs/SETUP.md for Docker and hosted options.",
    );
    process.exit(1);
  }
  console.log(`[setup] PostgreSQL found at ${new URL(adminUrl).host}`);

  for (const name of [DEV_DB, TEST_DB]) {
    const created = await ensureDatabase(adminUrl, name);
    console.log(`[setup] database ${name} ${created ? "created" : "already existed"}`);
  }

  if (existsSync(ENV_LOCAL)) {
    console.log("[setup] .env.local already exists — left untouched");
  } else {
    writeEnvLocal(withDatabase(adminUrl, DEV_DB), withDatabase(adminUrl, TEST_DB));
    console.log("[setup] .env.local written, with a generated AUTH_SECRET");
  }

  // Applied to both, because `verify` uses the development database for the
  // end-to-end suites and the test database for everything else.
  for (const [label, url] of [
    ["development", withDatabase(adminUrl, DEV_DB)],
    ["test", withDatabase(adminUrl, TEST_DB)],
  ] as const) {
    execFileSync("npx", ["tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
    console.log(`[setup] migrations applied to the ${label} database`);
  }

  console.log(
    "\n[setup] Ready. `npm run verify` should now pass.\n" +
      "[setup] `npm run demo:seed` builds the demo program to click around in.\n" +
      "[setup] Google sign-in needs real credentials — see docs/SETUP.md.",
  );
}

main().catch((error) => {
  console.error("[setup] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
