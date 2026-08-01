#!/usr/bin/env tsx
/**
 * Forward-only SQL migration runner.
 *
 * Every file in db/migrations is applied exactly once, in filename order,
 * inside its own transaction, and recorded in `schema_migrations`.
 *
 *   npm run db:migrate
 *   npm run db:reset     (drops and recreates the public schema first)
 *
 * `runMigrations()` is exported so other scripts — setup-production.ts — can
 * apply migrations in-process instead of shelling out and parsing the output.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createAdminClient } from "./db-client";
import { assertDestructiveAllowed } from "./db-guard";
import { loadEnv } from "./load-env";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

export interface MigrationRun {
  /** Filenames applied by this run, in the order they were applied. */
  applied: string[];
  /** Filenames already recorded, whose checksums matched. */
  alreadyApplied: string[];
}

/**
 * Applies any outstanding migrations and says which ones.
 *
 * The list matters now that nobody is watching this run: the workflow writes it
 * into the job summary, and "applied 2 migration(s)" tells whoever reads that
 * summary in three months nothing at all about which two.
 */
export async function applyPendingMigrations(
  options: { reset?: boolean } = {},
): Promise<MigrationRun> {
  loadEnv();
  const reset = options.reset ?? false;

  /* Checked before a socket is opened, not inside the transaction.
     `--reset` is the most destructive statement in the repository and had no
     guard at all: it dropped whatever `DATABASE_URL` pointed at. Refusing
     before connecting means a wrong target produces a refusal naming the host,
     rather than a connection error that says nothing about what was about to
     happen. Applying migrations *forward* is safe anywhere and stays
     unguarded; dropping the schema is not. */
  if (reset) {
    assertDestructiveAllowed("drop and recreate the schema", "ALLOW_REMOTE_DB_RESET");
  }

  const client = await createAdminClient();
  await client.connect();
  try {
    if (reset) {
      console.log("[migrate] dropping public schema");
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const existing = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const applied = new Map<string, string>(
      existing.rows.map((r) => [r.version, r.checksum]),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const run: MigrationRun = { applied: [], alreadyApplied: [] };
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} has changed after being applied. ` +
              `Create a new migration instead of editing an applied one.`,
          );
        }
        run.alreadyApplied.push(file);
        continue;
      }
      console.log(`[migrate] applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
        run.applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return run;
  } finally {
    await client.end();
  }
}

/**
 * The count, for callers that only need to know whether anything happened.
 * Kept so `setup-production.ts` and every existing call site read the same.
 */
export async function runMigrations(
  options: { reset?: boolean } = {},
): Promise<number> {
  return (await applyPendingMigrations(options)).applied.length;
}

/**
 * Only run when invoked directly, so importing this module does not migrate a
 * database as a side effect.
 */
const invokedDirectly = process.argv[1]?.includes("migrate.ts");
if (invokedDirectly) {
  runMigrations({ reset: process.argv.includes("--reset") })
    .then((ran) => {
      console.log(
        ran === 0
          ? "[migrate] database is up to date"
          : `[migrate] applied ${ran} migration(s)`,
      );
    })
    .catch((error) => {
      console.error(
        "[migrate] failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    });
}
