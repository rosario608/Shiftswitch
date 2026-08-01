import { describe, expect, it } from "vitest";
import { checkConnectionString } from "../../scripts/check-connection-string";

/**
 * Every way a connection string arrives wrong, and what the person who pasted
 * it is told.
 *
 * The case that produced this file is the third one down. The workflow's first
 * real run failed with `getaddrinfo EAI_AGAIN base` — a hostname of `base`,
 * which is what happens when a phone's text selection catches the middle of a
 * line instead of all of it. The database was never touched, and the only clue
 * was a DNS error forty lines into a log.
 */

const VALID =
  "postgresql://neondb_owner:npg_secret123@ep-cool-name-12345678.us-east-2.aws.neon.tech/neondb?sslmode=require";

describe("a connection string that is fine", () => {
  it("passes, and says what it found without saying what it is", () => {
    const verdict = checkConnectionString(VALID);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toMatch(/looks complete/);
    // Never the value, the password, or the host.
    expect(verdict.message).not.toContain("npg_secret123");
    expect(verdict.message).not.toContain("neon.tech");
    expect(verdict.message).not.toContain("neondb_owner");
  });

  it("accepts the shorter postgres:// spelling too", () => {
    expect(checkConnectionString(VALID.replace("postgresql://", "postgres://")).ok).toBe(
      true,
    );
  });
});

describe("nothing pasted at all", () => {
  it("names the secret and where it goes", () => {
    for (const empty of [undefined, "", "   "]) {
      const verdict = checkConnectionString(empty);
      expect(verdict.ok).toBe(false);
      expect(verdict.message).toContain("PRODUCTION_DATABASE_URL");
      expect(verdict.message).toMatch(/Secrets and variables/);
    }
  });
});

describe("half a line, which is what a phone actually does", () => {
  it("catches the single-word server name that produced `EAI_AGAIN base`", () => {
    /* The real failure, reconstructed: everything before the host was kept and
       the host itself came out as one word. `pg` will happily try to resolve
       it, wait for DNS, and fail with a message about `getaddrinfo`. */
    const verdict = checkConnectionString("postgresql://user:pass@base/neondb");
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/single word/);
    expect(verdict.message).toMatch(/joined by dots/);
  });

  it("catches a value that never begins with the scheme, and says how long it was", () => {
    const verdict = checkConnectionString("base.aws.neon.tech/neondb");
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/does not begin with postgresql:\/\//);
    // The length is the tell for a truncation, and discloses nothing.
    expect(verdict.message).toMatch(/25 characters long/);
  });

  it("catches a line cut off before the server name", () => {
    const verdict = checkConnectionString("postgresql://neondb_owner:npg_secret123@");
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/no server name|cut short/i);
  });

  it("catches a line with no username left on it", () => {
    const verdict = checkConnectionString("postgresql://ep-cool.us-east-2.aws.neon.tech/neondb");
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/no username/);
  });

  it("catches a line with no database name on the end", () => {
    const verdict = checkConnectionString(
      "postgresql://neondb_owner:npg_secret123@ep-cool.us-east-2.aws.neon.tech",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/which database/);
  });
});

describe("more than the line was pasted", () => {
  it("catches a whole block copied out of a settings page", () => {
    /* `DATABASE_URL="postgres://…"` on its own line, or two variables at once.
       These start with the right characters often enough to slip past a naive
       prefix check and then fail somewhere much less obvious. */
    const verdict = checkConnectionString(`${VALID}\nPOSTGRES_URL=${VALID}`);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/space or a line break/);
    expect(verdict.message).toMatch(/single line/);
  });

  it("catches a trailing fragment picked up by a sloppy selection", () => {
    const verdict = checkConnectionString(`${VALID} Copy`);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/space or a line break/);
  });
});

describe("what every message has to do", () => {
  it("tells the reader what to do, not what went wrong internally", () => {
    const failures = [
      "postgresql://user:pass@base/neondb",
      "base.aws.neon.tech/neondb",
      "postgresql://neondb_owner:npg_secret123@",
      `${VALID} Copy`,
    ].map((value) => checkConnectionString(value));

    for (const verdict of failures) {
      expect(verdict.ok).toBe(false);
      // An instruction, not a diagnosis: every one says to copy it again.
      expect(verdict.message, verdict.message).toMatch(/[Cc]opy|Add it/);
      // And none of them uses a word the reader would have to look up.
      for (const jargon of ["getaddrinfo", "EAI_AGAIN", "DNS", "URI", "parse"]) {
        expect(verdict.message, verdict.message).not.toContain(jargon);
      }
    }
  });
});
