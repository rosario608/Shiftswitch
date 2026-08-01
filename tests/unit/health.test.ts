import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkAuth,
  checkDelivery,
  compareMigrations,
  releaseId,
} from "@/server/health/check";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";
import { readMigrations, render } from "../../scripts/generate-migration-manifest";
import { scrub, buildReport } from "@/server/observability/report";
import { newRequestId, requestIdFrom } from "@/server/observability/request-id";

/**
 * The checks that answer "is this deployment able to do its job".
 *
 * Asserted here rather than only through the endpoint because the interesting
 * cases are states a test database cannot easily be put into — a migration
 * applied with different bytes, an environment missing one variable — and
 * because the *wording* is the product. An operator who does not read stack
 * traces gets exactly these sentences.
 */

describe("the migration manifest", () => {
  it("matches what is actually in db/migrations", () => {
    /* The generated file is what the running build believes about the schema.
       If it drifts from the directory, the drift *detector* is the thing that
       has drifted, which is the worst possible failure for this feature: it
       would report a healthy database as broken, or a broken one as healthy.

       Regenerate with `npm run migrations:manifest`. */
    expect(EXPECTED_MIGRATIONS).toEqual(readMigrations());
  });

  it("is byte-identical to what the generator would write", () => {
    const onDisk = readFileSync(
      join(process.cwd(), "src", "server", "db", "migration-manifest.ts"),
      "utf8",
    );
    expect(onDisk).toEqual(render(readMigrations()));
  });

  it("uses the same checksum the migration runner records", () => {
    /* If these two hashes ever diverge, every deployment reports every
       migration as "changed" and the product refuses to serve. The runner
       hashes the file's utf8 contents with sha256; so does this. */
    const first = readdirSync(join(process.cwd(), "db", "migrations"))
      .filter((file) => file.endsWith(".sql"))
      .sort()[0];
    const expected = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "db", "migrations", first), "utf8"))
      .digest("hex");
    expect(EXPECTED_MIGRATIONS[0]).toEqual({ version: first, checksum: expected });
  });
});

describe("comparing the schema against the build", () => {
  const build = [
    { version: "0001_init.sql", checksum: "aaa" },
    { version: "0002_mobile.sql", checksum: "bbb" },
  ];

  it("is happy when they agree", () => {
    const state = compareMigrations([...build], build);
    expect(state.status).toBe("ok");
    expect(state.missing).toEqual([]);
    expect(state.summary).toMatch(/All 2 migrations are applied/);
  });

  it("fails, and names the file, when the database is behind", () => {
    const state = compareMigrations([build[0]], build);
    expect(state.status).toBe("failed");
    expect(state.missing).toEqual(["0002_mobile.sql"]);
    /* The filename is the whole value of this message: it is what somebody
       pastes into the next goal, or types after `npm run db:migrate`. */
    expect(state.summary).toContain("0002_mobile.sql");
    expect(state.summary).toMatch(/scheduling is switched off/i);
  });

  it("names every missing file, not just the first", () => {
    const state = compareMigrations([], build);
    expect(state.missing).toEqual(["0001_init.sql", "0002_mobile.sql"]);
    expect(state.summary).toContain("0001_init.sql");
    expect(state.summary).toContain("0002_mobile.sql");
  });

  it("is only degraded when the database is *ahead*", () => {
    /* An older instance still serving during a rollout. Migrations here are
       additive, so its queries still work; refusing would take a working
       server offline for the duration of a deploy. Named, though — an
       operator staring at a mystery deserves the clue. */
    const state = compareMigrations(
      [...build, { version: "0003_later.sql", checksum: "ccc" }],
      build,
    );
    expect(state.status).toBe("degraded");
    expect(state.unexpected).toEqual(["0003_later.sql"]);
    expect(state.summary).toMatch(/normal for a few seconds during a deploy/i);
  });

  it("fails when an applied migration's bytes have changed", () => {
    /* Forward-only and checksummed means this should be impossible; when it
       happens, somebody edited an applied file and what the database contains
       is genuinely unknown. That is not a degradation. */
    const state = compareMigrations(
      [build[0], { version: "0002_mobile.sql", checksum: "different" }],
      build,
    );
    expect(state.status).toBe("failed");
    expect(state.changed).toEqual(["0002_mobile.sql"]);
    expect(state.summary).toMatch(/no longer known/i);
  });

  it("reports missing before changed when both are true", () => {
    // Missing is the actionable one: apply it, then look again.
    const state = compareMigrations(
      [{ version: "0001_init.sql", checksum: "different" }],
      build,
    );
    expect(state.status).toBe("failed");
    expect(state.summary).toContain("0002_mobile.sql");
  });
});

describe("sign-in configuration", () => {
  const configured = {
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    AUTH_SECRET: "x".repeat(40),
    APP_URL: "https://shiftswitch.example",
  };

  it("is ok when everything is set, and shows the redirect URI to compare", () => {
    const component = checkAuth(configured);
    expect(component.status).toBe("ok");
    /* Whether it matches what Google was told cannot be checked from here, so
       it is reported for a human to compare rather than judged. */
    expect(component.detail?.redirectUri).toBe(
      "https://shiftswitch.example/api/auth/google/callback",
    );
  });

  it("fails — not degrades — when a variable is missing, because Google is the only way in", () => {
    const component = checkAuth({
      ...configured,
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: undefined,
    });
    expect(component.status).toBe("failed");
    expect(component.summary).toContain("GOOGLE_CLIENT_ID");
    expect(component.summary).toMatch(/nobody can sign in/i);
  });

  it("is only degraded where a test door is open, because then it is not true", () => {
    /* A local or CI environment signs in through `ALLOW_TEST_LOGIN`. Saying
       "nobody can sign in" there is wrong on the facts, and a check that is red
       in every development environment is a check nobody reads — which is how
       the one that matters gets ignored too. Still reported, because shipping
       this configuration would be an outage. */
    const component = checkAuth({
      ...configured,
      NODE_ENV: "development",
      ALLOW_TEST_LOGIN: "true",
      GOOGLE_CLIENT_ID: undefined,
    });
    expect(component.status).toBe("degraded");
    expect(component.summary).toContain("GOOGLE_CLIENT_ID");
    expect(component.summary).toMatch(/let nobody in at all/i);
    expect(component.detail?.testLoginAvailable).toBe(true);
  });

  it("cannot be softened by the test door in a production build", () => {
    /* `describeEnvironment` double-locks the sandbox: production plus the flag
       still means off. So the concession above cannot leak into production
       even if the variable is set there by mistake. */
    const component = checkAuth({
      ...configured,
      NODE_ENV: "production",
      ALLOW_TEST_LOGIN: "true",
      GOOGLE_CLIENT_ID: undefined,
    });
    expect(component.status).toBe("failed");
  });

  it("names all of them at once, so it takes one round trip to fix", () => {
    const component = checkAuth({ NODE_ENV: "production" });
    expect(component.summary).toContain("GOOGLE_CLIENT_ID");
    expect(component.summary).toContain("AUTH_SECRET");
    expect(component.summary).toContain("APP_URL");
  });

  it("does not leak the secret it is checking for", () => {
    const component = checkAuth(configured);
    expect(JSON.stringify(component)).not.toContain("secret");
  });
});

describe("email delivery", () => {
  it("is degraded, never failed, when nothing is configured", () => {
    /* The product already says out loud that nothing was sent and to copy the
       link. Paging somebody for it teaches them to ignore the pager. */
    const component = checkDelivery({ NODE_ENV: "production" });
    expect(component.status).toBe("degraded");
    expect(component.summary).toMatch(/copy the link/i);
  });
});

describe("the release tag", () => {
  it("says unknown rather than inventing a version", () => {
    expect(releaseId({})).toBe("unknown");
  });

  it("prefers the commit sha the platform supplies", () => {
    expect(releaseId({ VERCEL_GIT_COMMIT_SHA: "abc123" })).toBe(
      "abc123",
    );
  });
});

describe("what an error report may contain", () => {
  it("strips an email address out of a message", () => {
    expect(scrub("duplicate key for alice@hospital.org")).toBe(
      "duplicate key for [email]",
    );
  });

  it("strips a phone number in the shape the roster stores", () => {
    expect(scrub("contact +19195550100 failed")).toBe("contact [phone] failed");
  });

  it("strips a connection string, credentials and all", () => {
    expect(scrub("connect postgres://user:pw@host:5432/db refused")).toBe(
      "connect [connection-string] refused",
    );
  });

  it("strips a bearer token", () => {
    expect(scrub("Bearer abcdefghijklmnopqrstuvwx")).toMatch(/\[token\]/);
  });

  it("bounds the message, so one report cannot fill a quota", () => {
    expect(scrub("x".repeat(5_000)).length).toBeLessThanOrEqual(2_001);
  });

  it("carries the role and never the person", () => {
    const report = buildReport(new Error("boom"), {
      kind: "api",
      role: "chief",
      route: "/api/admin/coverage",
      requestId: "abc123",
    });
    expect(report.tags.role).toBe("chief");
    /* The typed tag set is the enforcement: there is no field through which a
       caller could attach a name, an address or a schedule. */
    expect(Object.keys(report.tags).sort()).toEqual([
      "kind",
      "requestId",
      "role",
      "route",
    ]);
  });

  it("scrubs the stack as well as the message", () => {
    const error = new Error("no");
    error.stack = "Error: no\n  at send (alice@hospital.org)";
    expect(buildReport(error, { kind: "api" }).stack).toContain("[email]");
  });
});

describe("the request id", () => {
  it("is short enough to read down a phone", () => {
    expect(newRequestId()).toHaveLength(6);
  });

  it("avoids the characters people misread", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(newRequestId()).not.toMatch(/[lio01]/);
    }
  });

  it("honours an id the caller already stamped, so one event stays one event", () => {
    const headers = new Headers({ "x-request-id": "abcdef" });
    expect(requestIdFrom(headers)).toBe("abcdef");
  });

  it("refuses an id that could fill a disk or confuse a log reader", () => {
    /* A newline is the attack worth worrying about — a forged log entry — and
       `Headers` rejects one outright, so it never reaches the filter. What
       does reach it is everything else a header may legally contain: spaces,
       punctuation, and any length at all. */
    expect(() => new Headers({ "x-request-id": "a\nb" })).toThrow();

    expect(requestIdFrom(new Headers({ "x-request-id": "x".repeat(500) }))).toHaveLength(6);
    expect(requestIdFrom(new Headers({ "x-request-id": "has space" }))).toHaveLength(6);
    expect(requestIdFrom(new Headers({ "x-request-id": "semi;colon" }))).toHaveLength(6);
    expect(requestIdFrom(new Headers({ "x-request-id": "" }))).toHaveLength(6);
  });
});
