import { createHash } from "node:crypto";
import { query } from "@/server/db/pool";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";
import { describeEnvironment } from "@/server/config/environment";
import { logger } from "@/server/observability/logger";

/**
 * Is this deployment able to do its job, and if not, exactly which part is
 * broken?
 *
 * One module, three consumers: `/api/health` (machine-readable, for a monitor),
 * `/admin/diagnostics` (a sentence a non-engineer can act on), and the startup
 * check that refuses to serve scheduling when the schema is behind the code.
 * They are the same computation deliberately — a dashboard that says "healthy"
 * while the page says "degraded" is worse than having neither.
 *
 * ## What counts as a failure
 *
 * Three states, and the middle one is the one worth being careful about:
 *
 *   `ok`        — this component is doing its job.
 *   `degraded`  — it works, but something an operator should fix is true.
 *                 The product still serves residents.
 *   `failed`    — residents are affected right now.
 *
 * A missing *optional* configuration is `degraded`, never `failed`: no email
 * transport means invitations are copied by hand, which the product already
 * says out loud, and paging somebody at 3am for it would teach them to ignore
 * the pager. A missing migration is `failed` even though the process is running
 * happily, because the next query that names the new column is a 500 in
 * somebody's face.
 */

export type HealthStatus = "ok" | "degraded" | "failed";

/**
 * Just enough of an environment to check.
 *
 * `NodeJS.ProcessEnv` requires every variable the project has ever declared,
 * which makes "what happens when GOOGLE_CLIENT_ID is missing" impossible to
 * write as a test without casting the absence away — and a cast is exactly how
 * a check like this stops being tested.
 */
type EnvLike = Record<string, string | undefined>;

export interface HealthComponent {
  name: string;
  status: HealthStatus;
  /** One sentence, written for somebody who does not read stack traces. */
  summary: string;
  /** Machine-readable specifics. Never contains anybody's data. */
  detail?: Record<string, unknown>;
}

export interface HealthReport {
  status: HealthStatus;
  checkedAt: string;
  release: string;
  environment: string;
  /**
   * Six characters identifying *which* database this deployment uses, so
   * production and a preview can be compared without either revealing a
   * connection string. See `databaseFingerprint`.
   */
  database: string | null;
  components: HealthComponent[];
}

/** The worst of the parts. `failed` beats `degraded` beats `ok`. */
function worst(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

/**
 * The build's identity.
 *
 * Vercel supplies the commit sha; a local or self-hosted run supplies nothing,
 * and "unknown" is the honest answer rather than a fabricated version. It is
 * the tag on every error report, so getting it wrong makes a stack trace point
 * at the wrong source map.
 */
export function releaseId(env: EnvLike = process.env): string {
  return (
    env.NEXT_PUBLIC_RELEASE ??
    env.VERCEL_GIT_COMMIT_SHA ??
    env.SHIFTSWITCH_RELEASE ??
    "unknown"
  );
}

export interface MigrationState {
  status: HealthStatus;
  summary: string;
  /** In the build, absent from the database. The reason to refuse. */
  missing: string[];
  /** In the database, absent from the build — an older build against a newer schema. */
  unexpected: string[];
  /** Applied, but the file's bytes have changed since. */
  changed: string[];
}

/**
 * Compares the migrations this build was compiled with against the ones the
 * database says it has applied.
 *
 * The asymmetry matters and is the whole point:
 *
 * **Missing** — the code expects `0009` and the database has never seen it. The
 * code will name columns that do not exist. This is `failed`, and the affected
 * functionality refuses rather than 500s.
 *
 * **Unexpected** — the database has `0010` and this build does not know about
 * it. That is an *older build* running against a *newer* schema, which happens
 * for a few seconds during any rollout and is usually harmless, because
 * migrations here are additive. `degraded`, and named, because "usually" is not
 * "always" and an operator staring at a mystery deserves the clue.
 *
 * **Changed** — an applied migration's bytes differ from the build's copy.
 * Migrations are forward-only and checksummed precisely so this is impossible
 * by accident; when it happens somebody edited an applied file, and what the
 * database actually contains is now unknown. `failed`.
 */
export function compareMigrations(
  applied: Array<{ version: string; checksum: string }>,
  expected: readonly { version: string; checksum: string }[] = EXPECTED_MIGRATIONS,
): MigrationState {
  const appliedBy = new Map(applied.map((row) => [row.version, row.checksum]));
  const expectedBy = new Map(expected.map((row) => [row.version, row.checksum]));

  const missing = expected
    .filter((row) => !appliedBy.has(row.version))
    .map((row) => row.version);
  const unexpected = applied
    .filter((row) => !expectedBy.has(row.version))
    .map((row) => row.version)
    .sort();
  const changed = expected
    .filter((row) => {
      const found = appliedBy.get(row.version);
      return found !== undefined && found !== row.checksum;
    })
    .map((row) => row.version);

  if (missing.length > 0) {
    return {
      status: "failed",
      summary:
        `The database is missing ${plural(missing.length, "migration")} this version of ` +
        `ShiftSwitch needs: ${missing.join(", ")}. Scheduling is switched off until ` +
        "it is applied, because the code would ask for columns that do not exist.",
      missing,
      unexpected,
      changed,
    };
  }

  if (changed.length > 0) {
    return {
      status: "failed",
      summary:
        `${plural(changed.length, "migration")} recorded as applied ${
          changed.length === 1 ? "does" : "do"
        } not match this build: ${changed.join(", ")}. An applied migration was ` +
        "edited, so what the database actually contains is no longer known.",
      missing,
      unexpected,
      changed,
    };
  }

  if (unexpected.length > 0) {
    return {
      status: "degraded",
      summary:
        `The database has ${plural(unexpected.length, "migration")} this build does not ` +
        `know about: ${unexpected.join(", ")}. That is normal for a few seconds during a ` +
        "deploy; if it persists, this server is running older code than the schema.",
      missing,
      unexpected,
      changed,
    };
  }

  return {
    status: "ok",
    summary: `All ${expected.length} migrations are applied.`,
    missing,
    unexpected,
    changed,
  };
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/** Reads `schema_migrations`, or explains why it could not. */
async function databaseAndMigrations(): Promise<[HealthComponent, HealthComponent]> {
  let applied: Array<{ version: string; checksum: string }>;
  const started = Date.now();
  try {
    applied = await query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
  } catch (error) {
    /* One failure, two components, and they say different things: the database
       is unreachable *and* the migration state is therefore unknown. Reporting
       migrations as "ok" because the check did not run would be the worst
       possible answer. */
    const message = error instanceof Error ? error.message : String(error);
    const missingTable = /schema_migrations/i.test(message) && /exist/i.test(message);

    return [
      {
        name: "database",
        status: "failed",
        summary: missingTable
          ? "The database is reachable but has never been set up — it has no migration table at all."
          : "The database cannot be reached. Nothing that reads or writes a schedule can work until it is.",
        detail: {
          reachable: missingTable,
          /* The driver's own words. Safe: a connection error names a host and a
             port, never a person. Truncated because a connection string can be
             long and this is going in a copyable report. */
          error: message.slice(0, 300),
          elapsedMs: Date.now() - started,
        },
      },
      {
        name: "migrations",
        status: "failed",
        summary: missingTable
          ? `No migrations have been applied. This build needs all ${EXPECTED_MIGRATIONS.length}.`
          : "Cannot tell — the database is unreachable, so the schema is unknown.",
        detail: {
          expected: EXPECTED_MIGRATIONS.length,
          applied: null,
          missing: missingTable ? EXPECTED_MIGRATIONS.map((m) => m.version) : null,
        },
      },
    ];
  }

  const state = compareMigrations(applied);
  return [
    {
      name: "database",
      status: "ok",
      summary: "The database is reachable.",
      detail: { reachable: true, elapsedMs: Date.now() - started },
    },
    {
      name: "migrations",
      status: state.status,
      summary: state.summary,
      detail: {
        expected: EXPECTED_MIGRATIONS.length,
        applied: applied.length,
        missing: state.missing,
        unexpected: state.unexpected,
        changed: state.changed,
      },
    },
  ];
}

/**
 * Sign-in configuration.
 *
 * Google OpenID Connect is the only way in, so a missing client id is not a
 * degradation — nobody can sign in at all. `AUTH_SECRET` is the same: without
 * it the OAuth state cannot be signed, and every attempt fails at the callback.
 *
 * ## Except where it is not the only way in
 *
 * A local or CI environment runs with `ALLOW_TEST_LOGIN`, which opens a
 * second door that Google configuration has nothing to do with. Reporting
 * `failed` there would be *wrong on the facts* — people are signing in
 * perfectly well — and the cost of being wrong is worse than it looks: a check
 * that is red in every development environment is a check nobody reads, and the
 * one time it goes red in production it will be ignored along with the rest.
 *
 * So it is still reported, because shipping this configuration would be an
 * outage, but as `degraded` with the reason stated. The sandbox door is itself
 * double-locked and can never open in a production build (see
 * `describeEnvironment`), so this cannot soften the production check by
 * accident.
 */
export function checkAuth(env: EnvLike = process.env): HealthComponent {
  const missing: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.AUTH_SECRET) missing.push("AUTH_SECRET");
  if (!env.APP_URL) missing.push("APP_URL");

  if (missing.length > 0) {
    const sandbox = describeEnvironment(env).invitationSandboxEnabled;
    return {
      name: "auth",
      status: sandbox ? "degraded" : "failed",
      summary: sandbox
        ? `Google sign-in is not configured (${missing.join(", ")}). This environment ` +
          "also allows test sign-in, so people can still get in — but a deployment " +
          "with this configuration and no test door would let nobody in at all."
        : `Sign-in is not configured: ${missing.join(", ")} ${
            missing.length === 1 ? "is" : "are"
          } not set. Google is the only way into ShiftSwitch, so nobody can sign in.`,
      detail: { missing, testLoginAvailable: sandbox },
    };
  }

  /* A redirect URI that does not match what Google was told produces a failure
     at the callback and nowhere earlier, which is a miserable thing to debug.
     It cannot be verified from here — only Google knows what is registered —
     so the value is reported for a human to compare, not judged. */
  return {
    name: "auth",
    status: "ok",
    summary: "Google sign-in is configured.",
    detail: {
      redirectUri: `${env.APP_URL}/api/auth/google/callback`,
      hostedDomain: env.GOOGLE_HOSTED_DOMAIN ?? null,
    },
  };
}

/**
 * Delivery, and why it is `degraded` rather than `failed`.
 *
 * The product never claims an email was sent when it was not — the transport
 * returns "not delivered" with a reason and the interface says to copy the
 * link. So an unconfigured transport is a real thing an operator should know
 * and not a thing that breaks a resident's day.
 */
export function checkDelivery(env: EnvLike = process.env): HealthComponent {
  const environment = describeEnvironment(env);
  if (environment.emailDeliveryEnabled) {
    return { name: "email", status: "ok", summary: "Email delivery is configured." };
  }
  return {
    name: "email",
    status: "degraded",
    summary: environment.emailDeliveryReason,
    detail: { environment: environment.environment },
  };
}

/**
 * Whether a resident's phone will ever buzz.
 *
 * Reported here, beside email, because the two together answer one question a
 * resident cares about far more than any other: *if somebody offers on my
 * shift, will I find out?* Before this existed, the answer lived in three
 * environment variables that only somebody with the Vercel dashboard open could
 * read — so the honest answer to "does push work in production" was "nobody can
 * tell", which is a poor thing to discover after handing a link to forty
 * people.
 *
 * `degraded`, not `failed`, and for the same reason as email: nothing breaks.
 * The transport reports "skipped" rather than pretending, every notification is
 * still on the notifications screen, and a resident who opens the app sees
 * everything. What they do not get is a reason to open it.
 */
export function checkPush(env: EnvLike = process.env): HealthComponent {
  const missing = (
    [
      ["FCM_PROJECT_ID", env.FCM_PROJECT_ID],
      ["FCM_CLIENT_EMAIL", env.FCM_CLIENT_EMAIL],
      ["FCM_PRIVATE_KEY", env.FCM_PRIVATE_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length === 0) {
    return {
      name: "push",
      status: "ok",
      summary: "Push notifications are configured.",
      detail: { projectId: env.FCM_PROJECT_ID },
    };
  }

  return {
    name: "push",
    status: "degraded",
    summary:
      missing.length === 3
        ? "No push service is configured, so nobody gets a notification when somebody offers on their shift. They will only see it by opening the app."
        : `Push is half-configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set, so no notification can be sent.`,
    detail: { missing },
  };
}

/**
 * Whether a failure reaches anybody.
 *
 * The counterpart to the two above, and the one nobody thinks about until the
 * morning after. With no destination configured, `reportError` writes to the
 * log and says so — which is honest, and is also invisible unless somebody
 * happens to be reading Vercel's logs at the moment it happens.
 */
export function checkErrorReporting(env: EnvLike = process.env): HealthComponent {
  if (env.ERROR_REPORTING_DSN) {
    return {
      name: "error reporting",
      status: "ok",
      summary: "Errors are reported to an external service.",
    };
  }
  return {
    name: "error reporting",
    status: "degraded",
    summary:
      "No ERROR_REPORTING_DSN is set, so errors are written to the deployment log and nothing is sent anywhere. Nobody is told when a resident hits a failure.",
  };
}

/**
 * Which database this deployment is talking to, as a fingerprint.
 *
 * Six characters of a hash of the host and database name — never the
 * connection string, never a credential, and not reversible into either. It
 * exists to answer one question that is otherwise unanswerable without handling
 * secrets: **is the preview environment pointed at the live database?**
 *
 * Open `/api/health` on production and again on a preview deployment. Same
 * fingerprint means one database, and a pull request can write to the real
 * programme's schedule. Different means they are properly separated. That is a
 * comparison anybody can make in ten seconds, with nothing sensitive on screen.
 */
export function databaseFingerprint(env: EnvLike = process.env): string | null {
  const url = env.DATABASE_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return createHash("sha256")
      .update(`${parsed.host}${parsed.pathname}`)
      .digest("hex")
      .slice(0, 6);
  } catch {
    return null;
  }
}

/** The whole picture. Safe to call on every request; it is one small query. */
export async function checkHealth(): Promise<HealthReport> {
  const [database, migrations] = await databaseAndMigrations();
  const components = [
    database,
    migrations,
    checkAuth(),
    checkDelivery(),
    checkPush(),
    checkErrorReporting(),
  ];
  const status = worst(components.map((component) => component.status));

  if (status === "failed") {
    logger.error("health.failed", {
      components: components
        .filter((component) => component.status === "failed")
        .map((component) => ({ name: component.name, summary: component.summary })),
    });
  }

  return {
    status,
    checkedAt: new Date().toISOString(),
    release: releaseId(),
    environment: describeEnvironment().environment,
    database: databaseFingerprint(),
    components,
  };
}
