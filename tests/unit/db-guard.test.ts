import { describe, expect, it } from "vitest";
import {
  checkDestructiveAllowed,
  isLocalDatabase,
  looksLikeProduction,
} from "../../scripts/db-guard";

/**
 * The guard in front of every statement that cannot be undone: the migration
 * runner's `--reset`, the end-to-end fixture's TRUNCATE, and the demo seeder.
 *
 * `npm run verify` runs the first two on every invocation, so this is not a
 * theoretical protection — it is the thing standing between a stray
 * `DATABASE_URL` in a shell and a destroyed database.
 */

const LOCAL = "postgres://postgres@127.0.0.1:5432/shiftswitch_test";

function check(env: Record<string, string | undefined>) {
  return checkDestructiveAllowed("ALLOW_REMOTE_DB_RESET", env);
}

describe("recognising a local database", () => {
  it("accepts the forms a local URL actually takes", () => {
    for (const url of [
      "postgres://postgres@127.0.0.1:5432/db",
      "postgres://postgres@localhost:5432/db",
      "postgres://user:pw@localhost/db",
      "postgresql://[::1]:5432/db",
      "postgres://0.0.0.0:5432/db",
    ]) {
      expect(isLocalDatabase(url), url).toBe(true);
    }
  });

  it("rejects anything hosted elsewhere", () => {
    for (const url of [
      "postgres://user@ep-cool-name.us-east-2.aws.neon.tech/db",
      "postgres://user@10.0.0.5:5432/db",
      "postgres://user@db.internal:5432/db",
      // The substring appears, but not as the host. A looser pattern matched
      // this and would have called a remote database local.
      "postgres://user@notlocalhost.example.com/db",
      "postgres://user@localhost.evil.com/db",
      "not a url at all",
    ]) {
      expect(isLocalDatabase(url), url).toBe(false);
    }
  });
});

describe("recognising production by name", () => {
  it("catches the words a production database is actually called", () => {
    for (const name of ["shiftswitch_production", "prod", "app-live", "my.prod.db"]) {
      expect(looksLikeProduction(name), name).toBe(true);
    }
  });

  it("does not catch words that merely contain them", () => {
    // "provider" contains "prod"; "deliverable" contains "live". Neither is a
    // production database, and refusing them would train people to override.
    for (const name of ["shiftswitch_test", "provider_db", "deliverables", "prodigy"]) {
      expect(looksLikeProduction(name), name).toBe(false);
    }
  });
});

describe("the gate as a whole", () => {
  it("allows a local test database", () => {
    expect(check({ DATABASE_URL: LOCAL }).allowed).toBe(true);
  });

  it("refuses when DATABASE_URL is unset rather than defaulting to something", () => {
    const result = check({});
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain("not set");
  });

  it("refuses NODE_ENV=production even on a local database", () => {
    const result = check({ DATABASE_URL: LOCAL, NODE_ENV: "production" });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(" ")).toContain("production");
  });

  it("refuses a remote host and names it", () => {
    const url = "postgres://user@ep-x.aws.neon.tech/shiftswitch";
    const result = check({ DATABASE_URL: url });
    expect(result.allowed).toBe(false);
    expect(result.target).toBe("ep-x.aws.neon.tech");
    expect(result.reasons.join(" ")).toContain("ALLOW_REMOTE_DB_RESET");
  });

  it("gives every reason at once, not just the first", () => {
    const result = check({
      DATABASE_URL: "postgres://user@ep-x.aws.neon.tech/shiftswitch_production",
      NODE_ENV: "production",
      APP_URL: "https://shiftswitch.live",
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toHaveLength(4);
  });

  it("lets a deliberate opt-in through for a remote but non-production target", () => {
    const result = check({
      DATABASE_URL: "postgres://user@staging.internal:5432/shiftswitch_staging",
      ALLOW_REMOTE_DB_RESET: "true",
    });
    expect(result.allowed).toBe(true);
  });

  it("does not let the opt-in override a production name", () => {
    // The escape hatch exists for a disposable remote database, not for
    // overriding every gate at once.
    const result = check({
      DATABASE_URL: "postgres://user@staging.internal:5432/shiftswitch_production",
      ALLOW_REMOTE_DB_RESET: "true",
    });
    expect(result.allowed).toBe(false);
  });

  it("scopes the opt-in to the caller that named it", () => {
    // The fixture's variable must not unlock the migration reset.
    const env = {
      DATABASE_URL: "postgres://user@staging.internal:5432/shiftswitch_staging",
      ALLOW_REMOTE_E2E_FIXTURE: "true",
    };
    expect(checkDestructiveAllowed("ALLOW_REMOTE_DB_RESET", env).allowed).toBe(false);
    expect(checkDestructiveAllowed("ALLOW_REMOTE_E2E_FIXTURE", env).allowed).toBe(true);
  });
});
