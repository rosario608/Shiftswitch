#!/usr/bin/env tsx
/**
 * Writes the list of migrations this build expects into a TypeScript module.
 *
 * The running server has to answer "is the database's schema the one this code
 * was written against" — and it cannot do that by reading `db/migrations/`,
 * because a serverless bundle contains the files the compiler traced and
 * nothing else. So the list is compiled *in*, as source.
 *
 * Generated rather than hand-maintained because a hand-maintained list drifts
 * from the directory the moment somebody adds a migration in a hurry, and a
 * drift detector that is itself out of date is worse than none. `npm run
 * verify` fails if the two disagree — see `tests/unit/health.test.ts`.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");
const OUTPUT = path.join(
  process.cwd(),
  "src",
  "server",
  "db",
  "migration-manifest.ts",
);

export interface MigrationEntry {
  version: string;
  checksum: string;
}

/** Reads `db/migrations` and returns each file with the checksum the runner computes. */
export function readMigrations(): MigrationEntry[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((version) => ({
      version,
      /* The same sha256 over the same bytes that `scripts/migrate.ts` records
         in `schema_migrations.checksum`. Any other hash here would make every
         comparison a false alarm. */
      checksum: createHash("sha256")
        .update(readFileSync(path.join(MIGRATIONS_DIR, version), "utf8"))
        .digest("hex"),
    }));
}

export function render(entries: MigrationEntry[]): string {
  const rows = entries
    .map(
      (entry) =>
        `  { version: ${JSON.stringify(entry.version)}, checksum: ${JSON.stringify(
          entry.checksum,
        )} },`,
    )
    .join("\n");

  return `/**
 * GENERATED FILE — do not edit.
 *
 * Written by \`scripts/generate-migration-manifest.ts\` from \`db/migrations\`.
 * Run \`npm run migrations:manifest\` after adding a migration;
 * \`tests/unit/health.test.ts\` fails if this is stale.
 *
 * This is what the *running build* expects the schema to be. Compared against
 * \`schema_migrations\` at startup and on every health check, because
 * production once ran code whose queries named a column the schema did not
 * have, and the only symptom was a 500 with no clue in it.
 */

export interface ExpectedMigration {
  version: string;
  checksum: string;
}

export const EXPECTED_MIGRATIONS: readonly ExpectedMigration[] = [
${rows}
];
`;
}

if (process.argv[1] && process.argv[1].endsWith("generate-migration-manifest.ts")) {
  const entries = readMigrations();
  writeFileSync(OUTPUT, render(entries), "utf8");
  console.log(
    `[manifest] wrote ${entries.length} migration(s) to ${path.relative(process.cwd(), OUTPUT)}`,
  );
}
