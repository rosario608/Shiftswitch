#!/usr/bin/env tsx
/**
 * Applying migrations from the pipeline, with nobody watching.
 *
 * ## Why this is not just `npm run db:migrate`
 *
 * The runner is the same one a developer runs, deliberately — forward only,
 * each file in its own transaction, already-applied files skipped, a refusal if
 * an applied file's bytes have changed. What this adds is everything that only
 * matters when no human is present:
 *
 *   1. The connection string is checked for *shape* before a socket opens, and
 *      the refusal is in words. A half-copied value produced
 *      `getaddrinfo EAI_AGAIN base` once, which is a fine message for somebody
 *      who knows what `getaddrinfo` is.
 *   2. Pending migrations are read and refused if any would destroy data. The
 *      runner would apply `DROP TABLE shifts` as carefully as `ADD COLUMN`, and
 *      the transaction around it is no comfort at all.
 *   3. What it did is written to the job summary — the *files*, not a count.
 *      "Applied 2 migration(s)" tells a reader in three months nothing.
 *
 * ## What it never does
 *
 * It never resets, never drops, never reads a row of programme data. The only
 * statements it issues are the migrations themselves and the bookkeeping insert
 * into `schema_migrations`. Running it against an up-to-date database is a
 * no-op that exits 0, which is what makes a re-run safe after a failed deploy.
 */
import { readdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { checkConnectionString } from "./check-connection-string";
import { describeRefusal, scanForDestructive } from "./migration-safety";
import { applyPendingMigrations } from "./migrate";
import { createAdminClient } from "./db-client";
import { loadEnv } from "./load-env";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

/** Writes a block to the Actions job summary, and to stdout when running locally. */
function summary(markdown: string): void {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) appendFileSync(target, `${markdown}\n`);
  else console.log(markdown);
}

/** Which migration files the database has not recorded yet. */
async function pendingFiles(): Promise<string[]> {
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const client = await createAdminClient();
  await client.connect();
  try {
    /* The table may not exist on a database that has never been migrated, in
       which case everything is pending. Asked rather than assumed, because
       creating it here would be this script writing schema of its own. */
    const exists = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    if (!exists.rows[0]?.present) return onDisk;

    const applied = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const seen = new Set(applied.rows.map((row) => row.version));
    return onDisk.filter((name) => !seen.has(name));
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnv();

  const verdict = checkConnectionString(process.env.DATABASE_URL);
  if (!verdict.ok) {
    summary(`## Migrations not applied\n\n${verdict.message}`);
    console.log(`::error::${verdict.message}`);
    process.exit(1);
  }

  const pending = await pendingFiles();

  if (pending.length === 0) {
    summary(
      "## Nothing to apply\n\nThe database already has every migration in this build. " +
        "This is the ordinary outcome — most pushes change no schema.",
    );
    console.log("[migrate-ci] database is up to date");
    return;
  }

  /* Read before anything is applied, so a destructive statement in the third
     file stops the first from running. Refusing halfway would leave a database
     in a state no commit describes. */
  const findings = pending.flatMap((file) =>
    scanForDestructive(file, readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")),
  );
  if (findings.length > 0) {
    const message = describeRefusal(findings);
    summary(`## Refused\n\n\`\`\`\n${message}\n\`\`\``);
    console.log(`::error::${message.split("\n")[0]}`);
    console.error(message);
    process.exit(1);
  }

  console.log(`[migrate-ci] ${pending.length} pending: ${pending.join(", ")}`);
  const run = await applyPendingMigrations();

  const applied = run.applied.length
    ? run.applied.map((file) => `- \`${file}\``).join("\n")
    : "- (none — another run got there first)";

  summary(
    [
      `## Applied ${run.applied.length} migration${run.applied.length === 1 ? "" : "s"}`,
      "",
      applied,
      "",
      `${run.alreadyApplied.length} already applied and skipped.`,
      "",
      "Forward-only, each file in its own transaction. Re-running this is a no-op.",
    ].join("\n"),
  );
  console.log(`[migrate-ci] applied ${run.applied.length}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  summary(`## Failed\n\n\`\`\`\n${message}\n\`\`\`\n\nNothing partial was left behind: each migration runs in its own transaction.`);
  console.log(`::error::${message}`);
  console.error(error);
  process.exit(1);
});
