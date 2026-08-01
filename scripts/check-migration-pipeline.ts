#!/usr/bin/env tsx
/**
 * Proves the unattended migration path does what the workflow claims.
 *
 *     npx tsx scripts/check-migration-pipeline.ts
 *
 * Four properties, each asserted against a real database rather than reasoned
 * about:
 *
 *   1. On an empty database it applies every migration, in order.
 *   2. Run again with nothing pending, it is a no-op and exits 0.
 *   3. With exactly one migration outstanding it applies exactly that one, and
 *      names it.
 *   4. A migration that would destroy data is refused *before anything runs* —
 *      including the harmless statements in the same file.
 *
 * Not part of `npm run verify`, for the same reason the twelve-times
 * concurrency run is not: it needs `CREATE DATABASE`, which is a permission a
 * test suite should not require. It is the command to run when the migration
 * pipeline changes, and its output is what any claim about that pipeline should
 * be citing.
 *
 * It creates and drops `shiftswitch_migration_check` and touches nothing else.
 * `scripts/db-guard.ts` still refuses any target that is not demonstrably
 * local, so pointing this at anything real is not possible.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { loadEnv } from "./load-env";

const SCRATCH = "shiftswitch_migration_check";
const PROBE = "9999_pipeline_check_destructive.sql";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

/** Runs the CI entrypoint against the scratch database, capturing its summary. */
function runPipeline(scratchUrl: string): {
  code: number;
  stdout: string;
  summary: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "migration-check-"));
  const summaryFile = path.join(dir, "summary.md");
  writeFileSync(summaryFile, "");
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync("npx", ["tsx", "scripts/apply-migrations-ci.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: scratchUrl,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    code = failure.status ?? 1;
    stdout = failure.stdout ?? "";
  }
  const summary = readFileSync(summaryFile, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { code, stdout, summary };
}

async function adminConnection(): Promise<Client> {
  loadEnv();
  const base = process.env.DATABASE_URL ?? "";
  const url = new URL(base);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

async function main(): Promise<void> {
  loadEnv();
  const base = new URL(process.env.DATABASE_URL ?? "");
  if (!["127.0.0.1", "localhost", "::1"].includes(base.hostname)) {
    throw new Error(
      `Refusing to run: DATABASE_URL points at ${base.hostname}, which is not local. ` +
        "This script creates and drops a database.",
    );
  }
  const scratch = new URL(base.toString());
  scratch.pathname = `/${SCRATCH}`;
  const scratchUrl = scratch.toString();

  const admin = await adminConnection();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
  } finally {
    await admin.end();
  }

  const migrationsDir = path.join(process.cwd(), "db", "migrations");
  const probePath = path.join(migrationsDir, PROBE);
  let heldBack: { path: string; sql: string } | null = null;

  try {
    /* Held back so the database can be brought to "current, then one lands" —
       the state every real run meets. Moved rather than forgotten in the
       ledger: a forward-only migration's DDL is deliberately not re-runnable,
       so deleting its row and replaying it would test a situation that cannot
       happen. */
    const all = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const newest = all[all.length - 1]!;
    const newestPath = path.join(migrationsDir, newest);
    const newestSql = readFileSync(newestPath, "utf8");
    heldBack = { path: newestPath, sql: newestSql };

    console.log("\n1. An empty database gets everything");
    rmSync(newestPath);
    const first = runPipeline(scratchUrl);
    check("exits 0", first.code === 0, first.stdout.slice(-300));
    check("says it applied migrations", /Applied \d+ migrations?/.test(first.summary));
    check("names 0001 in the summary", first.summary.includes("0001_init.sql"));
    const appliedCount = (first.summary.match(/^- `/gm) ?? []).length;
    check(
      `names every one it applied (${appliedCount} of ${all.length - 1})`,
      appliedCount === all.length - 1,
    );

    console.log("\n2. Running it again does nothing");
    const second = runPipeline(scratchUrl);
    check("exits 0", second.code === 0);
    check("says there was nothing to apply", second.summary.includes("Nothing to apply"));
    check("applied nothing", !/Applied [1-9]/.test(second.summary));

    console.log("\n3. A new migration lands on a current database");
    writeFileSync(newestPath, newestSql);
    const third = runPipeline(scratchUrl);
    check("exits 0", third.code === 0, third.stdout.slice(-300));
    check("sees exactly one pending", third.stdout.includes(`1 pending: ${newest}`));
    check(
      "applies exactly one",
      /Applied 1 migration\b/.test(third.summary),
      third.summary.split("\n")[0],
    );
    check("names it in the summary", third.summary.includes(newest));
    check(
      "reports the rest as skipped",
      new RegExp(`${all.length - 1} already applied`).test(third.summary),
      third.summary,
    );

    console.log("\n4. A destructive migration is refused before anything runs");
    writeFileSync(
      probePath,
      [
        "-- Written by scripts/check-migration-pipeline.ts and deleted again.",
        "ALTER TABLE shifts ADD COLUMN pipeline_check_marker text;",
        "DROP TABLE held_shift_rows;",
      ].join("\n"),
    );
    const fourth = runPipeline(scratchUrl);
    check("exits non-zero", fourth.code !== 0);
    check("says what it refused", fourth.summary.includes("drops a table"));
    check("says how to mean it", fourth.summary.includes("destructive-ok"));

    const after = new Client({ connectionString: scratchUrl });
    await after.connect();
    const marker = await after.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.columns WHERE table_name='shifts' AND column_name='pipeline_check_marker'",
    );
    const dropped = await after.query<{ present: boolean }>(
      "SELECT to_regclass('public.held_shift_rows') IS NULL AS present",
    );
    await after.end();
    check(
      "the harmless statement in the same file did not run either",
      marker.rows[0].count === "0",
    );
    check("nothing was dropped", dropped.rows[0].present === false);
  } finally {
    /* The held-back migration goes back whatever happened. Leaving a repository
       one file short because a check threw would be a far worse outcome than
       the check failing. */
    if (heldBack) writeFileSync(heldBack.path, heldBack.sql);
    rmSync(probePath, { force: true });
    const cleanup = await adminConnection();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    } finally {
      await cleanup.end();
    }
  }

  console.log(
    failures === 0
      ? "\nThe migration pipeline behaves as the workflow claims.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("[migration-check] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
