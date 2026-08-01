import { query } from "@/server/db/pool";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";
import { schemaDrift } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { reportError } from "@/server/observability/report";
import { compareMigrations, type MigrationState } from "./check";

/**
 * Refuses to run code against a schema that cannot support it.
 *
 * ## Why this exists
 *
 * Production once ran a build whose queries named a column the deployed schema
 * did not have. The symptom was a 500 with `column "route" does not exist`
 * buried in a log nobody was reading, and the cause — an unapplied migration —
 * was invisible from every screen. Nothing in the product knew what schema it
 * needed, so nothing could say so.
 *
 * Now the build carries the list (`migration-manifest.ts`, generated) and this
 * compares it against `schema_migrations` before the work starts. A resident
 * gets one sentence saying the programme's administrator has been told; the
 * administrator gets the filename.
 *
 * ## Fail closed on drift, fail open on doubt
 *
 * If the comparison says a migration is **missing**, refuse: the next query is
 * going to fail anyway, and failing early with the reason is strictly better
 * than failing late without it.
 *
 * If the comparison itself **cannot be made** — the database is unreachable —
 * do *not* refuse. The underlying query is about to produce a database error
 * that says exactly that, and turning "the database is down" into "a migration
 * is missing" would send an operator to fix the wrong thing. Doubt is not
 * drift.
 *
 * ## Cached, and deliberately briefly
 *
 * One extra round trip on every request to answer a question whose answer
 * changes once a month is a poor trade, so the verdict is cached. Thirty
 * seconds, because the moment that matters most is the minute *after* somebody
 * applies the missing migration: the product should come back on its own,
 * without a redeploy and without anybody knowing there is a cache to clear.
 */

const TTL_MS = 30_000;

interface Cached {
  state: MigrationState | null;
  at: number;
}

declare global {
  var __shiftswitchSchemaGate: Cached | undefined;
}

/** Forgets the cached verdict. For tests, and for the diagnostic page's re-check. */
export function resetSchemaGate(): void {
  globalThis.__shiftswitchSchemaGate = undefined;
}

/**
 * The current verdict, or `null` when it could not be determined.
 *
 * `null` is not "fine" — it is "ask something else". Callers must not treat it
 * as a pass by accident, which is why it is not a boolean.
 */
export async function migrationState(): Promise<MigrationState | null> {
  const cached = globalThis.__shiftswitchSchemaGate;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.state;

  let state: MigrationState | null;
  try {
    const applied = await query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    state = compareMigrations(applied);
    if (state.status === "failed") {
      /* Here, rather than where the refusal is raised. This runs once per
         cache window; the refusal runs once per request, and a report per
         resident per tap would bury everything else that is wrong. */
      logger.error("schema_gate.drift", {
        missing: state.missing,
        changed: state.changed,
        expected: EXPECTED_MIGRATIONS.length,
      });
      reportError(
        new Error(
          `Database schema is behind this build: missing ${
            state.missing.join(", ") || "none"
          }; checksum changed ${state.changed.join(", ") || "none"}`,
        ),
        { kind: "job", route: "schema-gate", code: "schema_drift" },
      );
    }
  } catch (error) {
    /* Includes the case where `schema_migrations` itself does not exist — a
       database that has never been set up. That is genuinely "every migration
       is missing", but it is indistinguishable here from a permissions problem
       or a wrong database name, and the health check reports it properly with
       the driver's own message. Doubt, not drift. */
    logger.warn("schema_gate.undetermined", {
      error: error instanceof Error ? error.message : String(error),
    });
    state = null;
  }

  globalThis.__shiftswitchSchemaGate = { state, at: Date.now() };
  return state;
}

/**
 * Throws `schema_drift` when the deployed schema is behind this build.
 *
 * Called by `apiHandler` for every route and by the page guards for every
 * screen, rather than sprinkled over the routes that "need" a recent
 * migration. Working out which feature each migration underpins would be a
 * mapping somebody has to maintain, and the first time it was wrong the
 * product would 500 in exactly the way this exists to prevent. If the schema is
 * behind the code, *any* query may name a column that is not there.
 *
 * The exemptions are the routes that have to keep working precisely when this
 * is failing: health, diagnostics, and signing in — an administrator who cannot
 * authenticate cannot read the diagnosis.
 */
export async function assertSchemaCurrent(): Promise<void> {
  const state = await migrationState();
  if (!state || state.status !== "failed") return;

  throw schemaDrift(
    "ShiftSwitch has been updated but the database has not. Your program administrator " +
      "has been told what is needed — nothing you did caused this, and nothing has been lost.",
    {
      /* For the operator, in the response body and the error report. It names
         files, not data; there is nothing here to leak. */
      missing: state.missing,
      changed: state.changed,
      expected: EXPECTED_MIGRATIONS.length,
    },
  );
}

/** Paths that must answer even while the schema is drifted. */
const EXEMPT = [
  "/api/health",
  "/api/admin/diagnostics",
  "/api/auth/",
  "/api/session",
  "/api/well-known/",
];

export function isSchemaGateExempt(pathname: string): boolean {
  return EXEMPT.some((prefix) => pathname.startsWith(prefix));
}
