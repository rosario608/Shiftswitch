import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OVERRIDE_MARKER,
  describeRefusal,
  scanForDestructive,
} from "../../scripts/migration-safety";

/**
 * The guard on the unattended migration path.
 *
 * Applying migrations is no longer a person's job, which removes the last
 * moment where somebody looked at the statement before it ran. The runner would
 * apply `DROP TABLE shifts` with exactly the same care it applies `ADD COLUMN`
 * — atomically, which is no comfort.
 */

describe("what it refuses", () => {
  const cases: Array<[string, string]> = [
    ["a dropped table", "DROP TABLE shifts;"],
    ["a dropped schema", "DROP SCHEMA public CASCADE;"],
    ["a dropped database", "DROP DATABASE shiftswitch;"],
    ["a truncate", "TRUNCATE shift_assignments;"],
    ["a dropped column", "ALTER TABLE shifts DROP COLUMN location;"],
    ["a delete with no WHERE", "DELETE FROM notifications;"],
    ["a dropped type", "DROP TYPE shift_provenance;"],
  ];

  for (const [name, sql] of cases) {
    it(`refuses ${name}`, () => {
      const findings = scanForDestructive("0099_test.sql", sql);
      expect(findings).toHaveLength(1);
      expect(findings[0].why).toBeTruthy();
      expect(findings[0].line).toBeGreaterThan(0);
    });
  }

  it("refuses a DROP COLUMN spread over several lines", () => {
    /* The shape a formatter produces, and the one a line-by-line read misses. */
    const sql = `ALTER TABLE shifts\n  DROP COLUMN\n    location;`;
    expect(scanForDestructive("0099_test.sql", sql).length).toBeGreaterThan(0);
  });

  it("says what was refused and what to do instead", () => {
    const message = describeRefusal(scanForDestructive("0099_test.sql", "DROP TABLE shifts;"));
    expect(message).toContain("0099_test.sql");
    expect(message).toContain("drops a table");
    expect(message).toContain(OVERRIDE_MARKER);
    expect(message).toMatch(/nothing was applied/i);
  });
});

describe("what it allows", () => {
  const allowed: Array<[string, string]> = [
    ["creating a table", "CREATE TABLE positions (id uuid PRIMARY KEY);"],
    ["adding a column", "ALTER TABLE shifts ADD COLUMN provenance text;"],
    ["adding an index", "CREATE INDEX shifts_provenance ON shifts (provenance);"],
    ["a comment", "COMMENT ON COLUMN users.enrollment_status IS 'confirmed or pending';"],
    ["a targeted delete", "DELETE FROM held_shift_rows WHERE claimed_at IS NOT NULL;"],
    ["replacing an index", "DROP INDEX IF EXISTS shifts_old_idx;"],
    ["dropping a constraint", "ALTER TABLE shifts DROP CONSTRAINT shifts_check;"],
  ];

  for (const [name, sql] of allowed) {
    it(`allows ${name}`, () => {
      expect(scanForDestructive("0099_test.sql", sql), name).toEqual([]);
    });
  }

  it("is not fooled by prose in a comment", () => {
    /* Every migration in this repository explains itself at length, and several
       of them discuss what they are deliberately *not* dropping. A guard that
       refused a file for saying the words would be unusable. */
    const sql = [
      "-- This does not DROP TABLE shifts, because the column is still read by",
      "-- the published-schedule query. TRUNCATE would be worse still.",
      "ALTER TABLE shifts ADD COLUMN team_id uuid;",
    ].join("\n");
    expect(scanForDestructive("0099_test.sql", sql)).toEqual([]);
  });

  it("allows a destructive statement that says why", () => {
    const sql = [
      `-- ${OVERRIDE_MARKER}  legacy_shifts has been empty since 0007 and nothing reads it.`,
      "DROP TABLE legacy_shifts;",
    ].join("\n");
    expect(scanForDestructive("0099_test.sql", sql)).toEqual([]);
  });
});

describe("every migration in this repository", () => {
  it("passes the guard, or the guard is wrong about real migrations", () => {
    /* The check that keeps this honest. A rule tuned only against invented
       snippets can be arbitrarily strict; running it over eleven real
       migrations is what says it is usable. */
    const dir = path.join(process.cwd(), "db", "migrations");
    const files = readdirSync(dir).filter((name) => name.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(5);

    const findings = files.flatMap((file) =>
      scanForDestructive(file, readFileSync(path.join(dir, file), "utf8")),
    );
    expect(
      findings,
      "These would be refused by the unattended migration path:\n" +
        findings.map((f) => `  ${f.file}:${f.line} ${f.statement}`).join("\n"),
    ).toEqual([]);
  });
});
