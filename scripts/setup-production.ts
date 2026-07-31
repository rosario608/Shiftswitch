#!/usr/bin/env tsx
/**
 * One command to take a fresh production environment from empty to usable.
 *
 *   npm run setup:production
 *
 * It replaces the multi-step sequence in docs/DEPLOYMENT.md with a single run
 * that checks the configuration first, then does the work, then verifies the
 * result. It is safe to re-run: migrations are forward-only and recorded, and
 * the admin bootstrap is skipped once an administrator exists.
 *
 * What it does
 *   1. Refuses to run against a configuration that is not production.
 *   2. Applies outstanding migrations.
 *   3. Creates the first program, if the database has none.
 *   4. Reports exactly what a human still has to do, and what is already done.
 *
 * What it deliberately does NOT do
 *   - It never invents a Google OAuth client, an FCM key or a signing key.
 *     Those belong to accounts only the operator can hold.
 *   - It never creates a user. The first administrator signs in with Google and
 *     is promoted by BOOTSTRAP_ADMIN_EMAILS; there is no password to set.
 */
import { createAdminClient, describeConnection } from "./db-client";
import { loadEnv } from "./load-env";

loadEnv();

interface Finding {
  level: "error" | "warning" | "ok" | "todo";
  message: string;
}

const findings: Finding[] = [];
const fail = (message: string) => findings.push({ level: "error", message });
const warn = (message: string) => findings.push({ level: "warning", message });
const ok = (message: string) => findings.push({ level: "ok", message });
const todo = (message: string) => findings.push({ level: "todo", message });

function looksLocal(value: string): boolean {
  return /(^|\/\/|@)(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(:|\/|$)/i.test(value);
}

function checkConfiguration() {
  const appUrl = process.env.APP_URL ?? "";
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!appUrl) {
    fail("APP_URL is not set. It must be the public https address of the site.");
  } else if (!appUrl.startsWith("https://") || looksLocal(appUrl)) {
    fail(`APP_URL must be a public https address (got "${appUrl}").`);
  } else {
    ok(`Site address: ${appUrl}`);
  }

  if (!databaseUrl) {
    fail("DATABASE_URL is not set.");
  } else if (/(_dev|_test|-dev|-test|development)/i.test(databaseUrl)) {
    fail("DATABASE_URL names a development or test database.");
  } else if (looksLocal(databaseUrl)) {
    // Not an error: a self-hosted deployment normally runs PostgreSQL on the
    // same machine as the application. It is only worth mentioning, in case it
    // is actually somebody's laptop.
    warn(
      "DATABASE_URL points at localhost. That is correct for a self-hosted database on this machine, and wrong if this is not the production host.",
    );
  } else {
    ok("Database connection string looks like production.");
  }

  const secret = process.env.AUTH_SECRET ?? "";
  if (secret.length < 32 || /test|change ?me|placeholder|secret-secret/i.test(secret)) {
    fail(
      "AUTH_SECRET must be a real random value of at least 32 characters. Generate one with: openssl rand -base64 48",
    );
  } else {
    ok("Session signing secret is set.");
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    fail(
      "Google sign-in is not configured. Nobody can sign in without GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
    );
  } else if (/test-client/i.test(process.env.GOOGLE_CLIENT_ID)) {
    fail("GOOGLE_CLIENT_ID is a test value.");
  } else {
    ok("Google sign-in credentials are set.");
    todo(
      `In the Google Cloud console, the OAuth client must list this redirect URI exactly:\n      ${appUrl}/api/auth/google/callback`,
    );
  }

  if (process.env.ALLOW_TEST_LOGIN === "true") {
    fail("ALLOW_TEST_LOGIN is enabled. It must never be set in production.");
  }
  if (process.env.DATABASE_SSL !== "true") {
    warn('DATABASE_SSL is not "true". Most hosted databases require TLS.');
  }
  if (["debug", "trace"].includes((process.env.LOG_LEVEL ?? "").toLowerCase())) {
    fail("LOG_LEVEL is debug or trace; production logging must not be verbose.");
  }
  if (!process.env.FCM_PROJECT_ID) {
    todo(
      "Push notifications are not configured (FCM_PROJECT_ID unset). The app works without them; residents just will not get notifications on their phone.",
    );
  } else {
    ok("Push notification credentials are set.");
  }
}

function report(): boolean {
  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warning");

  for (const finding of findings.filter((f) => f.level === "ok")) {
    console.log(`  ok       ${finding.message}`);
  }
  for (const finding of warnings) {
    console.warn(`  warning  ${finding.message}`);
  }
  for (const finding of errors) {
    console.error(`  problem  ${finding.message}`);
  }

  if (errors.length > 0) {
    console.error(
      `\n[setup] ${errors.length} thing(s) must be fixed before this environment can be set up.` +
        `\n        Nothing has been changed.\n`,
    );
    return false;
  }
  return true;
}

async function main() {
  console.log(`\n[setup] Checking the configuration`);
  console.log(`        Database: ${describeConnection()}\n`);
  checkConfiguration();
  if (!report()) process.exit(1);

  console.log("\n[setup] Applying database migrations\n");
  const { runMigrations } = await import("./migrate");
  const applied = await runMigrations();
  console.log(
    applied === 0
      ? "  ok       Database schema already up to date."
      : `  ok       Applied ${applied} migration(s).`,
  );

  const db = await createAdminClient();
  await db.connect();

  console.log("\n[setup] Checking the program and administrator\n");

  const programCount = (
    await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM programs",
    )
  ).rows[0];
  if (Number(programCount?.count ?? 0) === 0) {
    const name = process.env.PROGRAM_NAME;
    const institution = process.env.PROGRAM_INSTITUTION;
    const timezone = process.env.PROGRAM_TIMEZONE;
    if (!name || !institution || !timezone) {
      console.log(
        "  todo     No program exists yet. Re-run with the program's details, for example:\n" +
          '             PROGRAM_NAME="Internal Medicine Residency" \\\n' +
          '             PROGRAM_INSTITUTION="Riverside University Hospital" \\\n' +
          '             PROGRAM_TIMEZONE="America/New_York" \\\n' +
          "             npm run setup:production",
      );
    } else {
      const created = (
        await db.query<{ id: string }>(
          `INSERT INTO programs (name, institution, timezone, approved_email_domains, default_trade_approval_required)
           VALUES ($1, $2, $3, '{}', false) RETURNING id`,
          [name, institution, timezone],
        )
      ).rows[0];
      console.log(`  ok       Created the program "${name}" (${created.id}).`);
    }
  } else {
    console.log(`  ok       ${programCount!.count} program(s) already exist.`);
  }

  const adminCount = (
    await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE role = 'admin'",
    )
  ).rows[0];
  const admins = Number(adminCount?.count ?? 0);
  const bootstrap = (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "").trim();

  if (admins > 0) {
    console.log(`  ok       ${admins} administrator(s) already configured.`);
    if (bootstrap) {
      console.log(
        "  todo     BOOTSTRAP_ADMIN_EMAILS is still set. Clear it — it is only needed until the first administrator exists.",
      );
    }
  } else if (!bootstrap) {
    console.log(
      "  todo     No administrator yet. Set BOOTSTRAP_ADMIN_EMAILS to the Google address\n" +
        "             that should become the first administrator, then sign in once at\n" +
        `             ${process.env.APP_URL}. That sign-in promotes the account.`,
    );
  } else {
    console.log(
      `  ok       BOOTSTRAP_ADMIN_EMAILS is set (${bootstrap}).\n` +
        `             Sign in once at ${process.env.APP_URL} to become the administrator,\n` +
        "             then clear the variable.",
    );
  }

  // Prove the application can actually reach and read the schema, rather than
  // assuming the migration step was enough.
  const tables = (
    await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN
          ('users','programs','shifts','trade_requests','completed_trades','devices','calendar_feeds')`,
    )
  ).rows;
  if (tables.length < 7) {
    console.error(
      `\n[setup] The schema is incomplete — found ${tables.length} of 7 core tables. Stopping.\n`,
    );
    await db.end();
    process.exit(1);
  }
  console.log("  ok       All core tables present and readable.");

  const remaining = findings.filter((f) => f.level === "todo");
  console.log("\n[setup] Done.\n");
  if (remaining.length > 0) {
    console.log("Still to do:\n");
    for (const finding of remaining) console.log(`  - ${finding.message}`);
    console.log("");
  }

  await db.end();
}

main().catch((error) => {
  console.error("\n[setup] failed:", error);
  process.exit(1);
});
