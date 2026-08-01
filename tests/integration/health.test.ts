import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { query } from "@/server/db/pool";
import { checkHealth } from "@/server/health/check";
import {
  assertSchemaCurrent,
  migrationState,
  resetSchemaGate,
} from "@/server/health/schema-gate";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";
import {
  setErrorTransport,
  type ErrorReport,
} from "@/server/observability/report";
import { reportText } from "@/components/app/diagnostics-panel";
import { closeDatabase, ensureMigrated } from "./helpers";

/**
 * The three states the diagnostic has to get right, against a real database.
 *
 * The unit tests cover the comparison logic; these cover the wiring, which is
 * where this kind of feature actually fails — a check that reads the wrong
 * table, a cache that never clears, a report that says "healthy" because the
 * query threw and nobody looked at the error.
 *
 * Each case ends by rendering the **copyable report**, because that string is
 * the deliverable: it is what somebody pastes when they are asking for help,
 * and a verdict that is right in a JSON payload and wrong in the text is a
 * verdict that is wrong.
 */

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

afterEach(async () => {
  /* Every case here manipulates `schema_migrations`; leaving it wrong would
     break every other integration file. Restored from the manifest, which is
     the truth this database was built from. */
  await query("DELETE FROM schema_migrations");
  for (const migration of EXPECTED_MIGRATIONS) {
    await query(
      "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [migration.version, migration.checksum],
    );
  }
  resetSchemaGate();
});

describe("a healthy system", () => {
  it("says so, in words, and lets scheduling through", async () => {
    const report = await checkHealth();

    const database = report.components.find((c) => c.name === "database")!;
    const migrations = report.components.find((c) => c.name === "migrations")!;
    expect(database.status).toBe("ok");
    expect(migrations.status).toBe("ok");
    expect(migrations.summary).toMatch(
      new RegExp(`All ${EXPECTED_MIGRATIONS.length} migrations are applied`),
    );

    // And nothing is refused.
    await expect(assertSchemaCurrent()).resolves.toBeUndefined();

    const text = reportText({ ...report, components: report.components });
    expect(text).toContain("[OK] Database");
    expect(text).toContain("[OK] Database schema");
  });

  it("reports overall health as the worst part, not the average", async () => {
    /* Email delivery is unconfigured in a test environment, so the whole report
       is `degraded` even though the database is perfect. That is the intended
       behaviour: a summary that averaged its parts would call a broken database
       "mostly fine". */
    const report = await checkHealth();
    expect(report.status).not.toBe("failed");
    expect(report.components.some((c) => c.status === "degraded")).toBe(true);
  });
});

describe("a migration that has not been applied", () => {
  it("names the file, refuses scheduling, and says nothing was lost", async () => {
    const last = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1];
    await query("DELETE FROM schema_migrations WHERE version = $1", [last.version]);
    resetSchemaGate();

    const report = await checkHealth();
    expect(report.status).toBe("failed");

    const migrations = report.components.find((c) => c.name === "migrations")!;
    expect(migrations.status).toBe("failed");
    /* The filename is the payload. Without it the operator knows only that
       "something is wrong with the database", which is where this started. */
    expect(migrations.summary).toContain(last.version);
    expect(migrations.detail?.missing).toEqual([last.version]);

    /* The database is still perfectly reachable, and saying otherwise would
       send somebody to check the wrong thing. */
    expect(report.components.find((c) => c.name === "database")!.status).toBe("ok");

    // Scheduling refuses, with a message written for whoever is looking at it.
    await expect(assertSchemaCurrent()).rejects.toMatchObject({
      code: "schema_drift",
      status: 503,
    });
    await expect(assertSchemaCurrent()).rejects.toThrow(/nothing has been lost/i);

    const text = reportText(report);
    expect(text).toContain("[FAILED] Database schema");
    expect(text).toContain(last.version);
  });

  it("recovers as soon as the migration is applied, without a redeploy", async () => {
    const last = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1];
    await query("DELETE FROM schema_migrations WHERE version = $1", [last.version]);
    resetSchemaGate();
    await expect(assertSchemaCurrent()).rejects.toMatchObject({ code: "schema_drift" });

    await query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
      last.version,
      last.checksum,
    ]);

    /* The cache is why this test exists. `resetSchemaGate` is what the
       diagnostic page's "Check again" button calls, and without it an operator
       who has just fixed the problem is told for another thirty seconds that
       they have not. */
    resetSchemaGate();
    await expect(assertSchemaCurrent()).resolves.toBeUndefined();
  });

  it("reports the drift once per verdict, not once per refused request", async () => {
    /* During a drift *every* request is refused, so reporting at the point of
       refusal would send one report per resident per tap — a flood that buries
       whatever else is wrong, arriving exactly when somebody is trying to read
       the dashboard. The report is raised where the verdict is computed, which
       the cache already limits to once per window. */
    const sent: ErrorReport[] = [];
    setErrorTransport({ name: "capture", send: (report) => void sent.push(report) });
    try {
      const last = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1];
      await query("DELETE FROM schema_migrations WHERE version = $1", [last.version]);
      resetSchemaGate();

      for (let i = 0; i < 5; i += 1) {
        await expect(assertSchemaCurrent()).rejects.toMatchObject({
          code: "schema_drift",
        });
      }

      expect(sent).toHaveLength(1);
      expect(sent[0].tags.code).toBe("schema_drift");
      expect(sent[0].message).toContain(last.version);
    } finally {
      setErrorTransport(null);
    }
  });

  it("treats an applied migration whose bytes changed as failed, not as fine", async () => {
    const first = EXPECTED_MIGRATIONS[0];
    await query("UPDATE schema_migrations SET checksum = $2 WHERE version = $1", [
      first.version,
      "0000000000000000000000000000000000000000000000000000000000000000",
    ]);
    resetSchemaGate();

    const report = await checkHealth();
    const migrations = report.components.find((c) => c.name === "migrations")!;
    expect(migrations.status).toBe("failed");
    expect(migrations.detail?.changed).toEqual([first.version]);
    await expect(assertSchemaCurrent()).rejects.toMatchObject({ code: "schema_drift" });
  });

  it("is only degraded when the database is ahead of the build", async () => {
    await query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
      "9999_from_the_future.sql",
      "whatever",
    ]);
    resetSchemaGate();

    const report = await checkHealth();
    const migrations = report.components.find((c) => c.name === "migrations")!;
    expect(migrations.status).toBe("degraded");

    /* Crucially, this does *not* refuse. An old instance still serving during a
       rollout keeps working; taking it offline would turn a normal deploy into
       an outage. */
    await expect(assertSchemaCurrent()).resolves.toBeUndefined();
  });
});

describe("a database that cannot be reached", () => {
  const original = process.env.DATABASE_URL;

  afterEach(async () => {
    process.env.DATABASE_URL = original;
    const { closePool } = await import("@/server/db/pool");
    await closePool();
    resetSchemaGate();
  });

  async function pointAtNothing() {
    const { closePool } = await import("@/server/db/pool");
    await closePool();
    /* A port with nothing on it. A syntactically valid URL, so the failure is
       a genuine connection refusal rather than a parse error — the shape of
       the outage this is meant to describe. */
    process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:59999/nothing";
    resetSchemaGate();
  }

  it("says the database is unreachable and refuses to guess about the schema", async () => {
    await pointAtNothing();

    const report = await checkHealth();
    expect(report.status).toBe("failed");

    const database = report.components.find((c) => c.name === "database")!;
    expect(database.status).toBe("failed");
    expect(database.summary).toMatch(/cannot be reached/i);

    /* The important half. The migration check could not run, and reporting it
       as "ok" because nothing contradicted it would be the worst answer
       available — a green tick beside a dead database. */
    const migrations = report.components.find((c) => c.name === "migrations")!;
    expect(migrations.status).toBe("failed");
    expect(migrations.summary).toMatch(/cannot tell/i);
    expect(migrations.detail?.applied).toBeNull();

    const text = reportText(report);
    expect(text).toContain("[FAILED] Database");
    expect(text).toContain("Overall: FAILED");
  }, 30_000);

  it("does not turn an outage into a false report of schema drift", async () => {
    await pointAtNothing();

    /* Doubt is not drift. If the gate refused here, an operator would be sent
       to apply a migration when the actual problem is that the database is
       down — and the underlying query is about to say so precisely. */
    expect(await migrationState()).toBeNull();
    await expect(assertSchemaCurrent()).resolves.toBeUndefined();
  }, 30_000);

  it("never puts the connection string in the report", async () => {
    await pointAtNothing();
    const report = await checkHealth();
    const serialised = JSON.stringify(report) + reportText(report);
    expect(serialised).not.toContain("nobody@");
    expect(serialised).not.toContain("postgres://");
  }, 30_000);
});
