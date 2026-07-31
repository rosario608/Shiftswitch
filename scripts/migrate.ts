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
import { Client } from "pg";
import { loadEnv } from "./load-env";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

/** Applies any outstanding migrations. Returns how many ran. */
export async function runMigrations(
  options: { reset?: boolean } = {},
): Promise<number> {
  loadEnv();
  const reset = options.reset ?? false;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const client = new Client({ connectionString });
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

    const applied = new Map<string, string>(
      (
        await client.query<{ version: string; checksum: string }>(
          "SELECT version, checksum FROM schema_migrations",
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;
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
        ran += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return ran;
  } finally {
    await client.end();
  }
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
