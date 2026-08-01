/**
 * What a migration is not allowed to do unattended.
 *
 * ## Why this exists
 *
 * Applying migrations is about to stop being a person's job. That is the right
 * change — every migration so far went in by somebody pasting SQL into a
 * console, and this repository's own notes have been wrong about production
 * twice as a result — but it removes the last moment where a human looked at the
 * statement before it ran.
 *
 * Nothing else in the pipeline would notice. The runner is forward-only,
 * checksummed and transactional, and it would apply `DROP TABLE shifts` with
 * exactly the same care it applies `ADD COLUMN`. The transaction guarantees the
 * drop is atomic, which is no comfort at all.
 *
 * So the unattended path refuses a statement that destroys data, and the
 * *deliberate* one says so in the file:
 *
 *     -- shiftswitch:destructive-ok  Dropping legacy_shifts, empty since 0007
 *
 * The marker needs a reason after it, for the same purpose reasons are
 * mandatory on a schedule override: a change nobody can account for six months
 * later is the thing this repository keeps deciding it does not want.
 *
 * ## What counts
 *
 * Only statements that can lose data a programme cares about. Creating,
 * altering-to-add, indexing and commenting are all safe and unmarked, which is
 * every migration in this repository so far.
 *
 * `DROP … IF EXISTS` on a *constraint* or an *index* is not destructive of
 * data and is deliberately absent from the list — a migration that replaces an
 * index should not need a ceremony.
 */

export interface DestructiveFinding {
  file: string;
  line: number;
  statement: string;
  why: string;
}

/** The marker a migration uses to say a destructive statement is intended. */
export const OVERRIDE_MARKER = "shiftswitch:destructive-ok";

const RULES: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\bDROP\s+TABLE\b/i,
    why: "drops a table and everything in it",
  },
  {
    pattern: /\bDROP\s+SCHEMA\b/i,
    why: "drops a schema and every table in it",
  },
  {
    pattern: /\bDROP\s+DATABASE\b/i,
    why: "drops the whole database",
  },
  {
    pattern: /\bTRUNCATE\b/i,
    why: "empties a table",
  },
  {
    pattern: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i,
    why: "drops a column and the values in it",
  },
  {
    /* A DELETE with no WHERE is a truncate wearing a different hat. One *with*
       a WHERE is how a migration fixes bad rows, which is legitimate. */
    pattern: /\bDELETE\s+FROM\b(?![\s\S]*?\bWHERE\b)/i,
    why: "deletes every row in a table",
  },
  {
    pattern: /\bDROP\s+TYPE\b/i,
    why: "drops a type, which fails or cascades into the columns using it",
  },
];

/** Everything in one migration file that would destroy data. */
export function scanForDestructive(file: string, sql: string): DestructiveFinding[] {
  if (sql.includes(OVERRIDE_MARKER)) return [];

  const findings: DestructiveFinding[] = [];
  const lines = sql.split("\n");

  lines.forEach((line, index) => {
    /* Comments are prose. A migration explaining *why* it is not dropping a
       table should not be refused for saying the words. */
    const code = line.replace(/--.*$/, "");
    if (!code.trim()) return;

    for (const rule of RULES) {
      if (rule.pattern.test(code)) {
        findings.push({
          file,
          line: index + 1,
          statement: code.trim().slice(0, 120),
          why: rule.why,
        });
        break;
      }
    }
  });

  /* A multi-line `ALTER TABLE … DROP COLUMN` escapes a line-by-line read. It is
     the one rule worth paying for a second pass over the whole file. */
  const withoutComments = sql.replace(/--.*$/gm, "");
  if (
    /\bALTER\s+TABLE\b[\s\S]{0,400}?\bDROP\s+COLUMN\b/i.test(withoutComments) &&
    !findings.some((finding) => finding.why.startsWith("drops a column"))
  ) {
    findings.push({
      file,
      line: 0,
      statement: "ALTER TABLE … DROP COLUMN (spanning several lines)",
      why: "drops a column and the values in it",
    });
  }

  return findings;
}

/**
 * The refusal, written for whoever is reading a red pipeline rather than for
 * whoever wrote the migration — they are often not the same person, and the
 * reader needs to know both what was refused and what to do about it.
 */
export function describeRefusal(findings: DestructiveFinding[]): string {
  const lines = [
    `Refusing to apply ${findings.length === 1 ? "a migration" : "migrations"} that would destroy data:`,
    "",
  ];
  for (const finding of findings) {
    lines.push(
      `  ${finding.file}${finding.line ? `:${finding.line}` : ""} — ${finding.why}`,
    );
    lines.push(`      ${finding.statement}`);
  }
  lines.push("");
  lines.push(
    "Nothing was applied. If this is deliberate, put a line like this in the migration:",
  );
  lines.push("");
  lines.push(`    -- ${OVERRIDE_MARKER}  <why this is safe and intended>`);
  lines.push("");
  lines.push(
    "The reason is not decoration: it is what somebody reads in six months when they ask where the data went.",
  );
  return lines.join("\n");
}
