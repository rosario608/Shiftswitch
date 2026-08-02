import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One word per concept, enforced.
 *
 * ## The decision
 *
 * The product is called ShiftSwitch, so the exchange is a **switch** — at every
 * stage, from the moment somebody posts a shift to the moment it lands on two
 * schedules. Not a trade, not a swap. The stages are adjectives on that one
 * noun (open, offered, waiting on a chief, done, declined), never new nouns.
 *
 * | Concept | The word | Rejected |
 * | --- | --- | --- |
 * | The exchange, at every stage | switch | trade, swap |
 * | A shift going one way, nothing back | giveaway | handoff, handover, giveback |
 * | Putting a shift up to be taken | give away | offload, unload, dump |
 * | Taking one without giving one back | pick up / take | claim, grab |
 * | Putting your shift up | post | list, put up for grabs |
 * | What a colleague sends back | offer | bid, proposal |
 * | A shift the program allows to be switched | switchable | tradeable, swappable |
 *
 * ## Why a giveaway is not a handoff
 *
 * "Handoff" is already a word in a hospital, and it means transferring
 * responsibility for a *patient* — sign-out, I-PASS, the thing residents are
 * formally assessed on. Using it for a shift changing hands would collide with
 * the one meaning every user of this product already has for it.
 *
 * "Cover" was the other candidate and is what residents actually say. It is
 * rejected because this product already uses *coverage* for staffing levels —
 * coverage requirements, the coverage report, `checkTradeCoverage` — and that
 * is a chief's word for a different thing. One word per concept cuts both ways.
 *
 * A resident must never confuse a giveaway with a switch: one leaves you
 * working the same amount and the other leaves you working more.
 *
 * ## Why a test and not a style note
 *
 * Because it was already written down. `docs/RULES.md` and the product copy
 * have said "switch" since the first session, and "trade" still reached the
 * screen 58 times — in headings, empty states, rule failures and one option
 * label. A resident using this half-asleep at 3am has to hold one model of what
 * the app does; three words for it is three models, and the one thing a tool
 * for swapping call cannot afford is a user unsure whether "trade" and "switch"
 * are the same feature.
 *
 * ## What it checks
 *
 * Prose that reaches a person: string literals and JSX text in the web app, the
 * native client, and the server modules that write notifications, emails and
 * rule failures. Identifiers are not checked — `TradeRequestStatus` is a type
 * name, `trade_requests` is a table, and neither is read by a resident. That
 * boundary is deliberate: renaming the database is a migration, and this test
 * is about what somebody *reads*.
 */

const ROOT = process.cwd();

/** Everything a resident, chief or program director can read. */
const SCANNED = [
  "src/app",
  "src/components",
  "mobile/src",
  "src/server/domain/trades.ts",
  "src/server/domain/trade-context.ts",
  "src/server/domain/trade-coverage.ts",
  "src/server/domain/candidates.ts",
  "src/server/domain/matching.ts",
  "src/server/domain/notifications.ts",
  "src/server/domain/email.ts",
  "src/server/domain/dashboard.ts",
  "src/server/domain/schedule-actions.ts",
  "src/server/domain/rules",
  "src/server/domain/status.ts",
  "src/server/auth/guards.ts",
  "src/server/http/errors.ts",
];

const REJECTED =
  /\b(trade|trades|traded|trading|tradeable|tradable|swap|swaps|swapped|swapping|swappable|handoffs?|hand-offs?|handovers?|hand-overs?|give-?backs?)\b/i;

/**
 * Strings that are not prose and never reach a screen. Each one is a *value*
 * the system uses — an event name, a column, a route — and renaming those is a
 * migration rather than a wording fix. Kept explicit and small: anything added
 * here should be something a person genuinely cannot read.
 */
const NOT_PROSE = [
  /^[a-z0-9_.:/[\]-]+$/, // event keys, table and column names, route paths, ids
  /* Import specifiers must actually look like one — a scope, a relative path,
     or something with a slash in it. An earlier version of this list was
     `/^@?[a-z0-9@/._-]+$/i`, which is case-insensitive and therefore matched
     any single capitalised word: it quietly excused the `<h1>Trades</h1>` at
     the top of the board, which is the largest text on the screen. A guard's
     allowlist is where its blind spots live. */
  /^(@[a-z0-9@/._-]+|\.{1,2}\/[a-z0-9@/._-]+|[a-z0-9._-]+\/[a-z0-9@/._-]+)$/i,
  /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|VALUES)\b/, // SQL
];

/** Tailwind and other machine-facing attribute soup. */
const CLASSNAME = /(^| )(flex|grid|inline|block|hidden|space-|text-|bg-|border-|rounded|px-|py-|pt-|pb-|pl-|pr-|mt-|mb-|ml-|mr-|mx-|my-|gap-|min-|max-|w-|h-|shrink|grow|items-|justify-|font-|opacity-|absolute|relative|sticky|overflow-|divide-|z-)/;

function walk(target: string): string[] {
  const full = path.join(ROOT, target);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((entry) => {
    const child = path.join(full, entry);
    if (statSync(child).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") return [];
      return walk(path.relative(ROOT, child));
    }
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [child] : [];
  });
}

/** Every string literal and JSX text node in a file, with its line number. */
function prose(source: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  const lines = source.split("\n");

  let inBlockComment = false;
  lines.forEach((line, index) => {
    /* Comments are for whoever is reading the code, and they are allowed to say
       "the trade lifecycle" — that is the name of the domain, and several of
       them explain why a defect was fixed the way it was. Only what ships is
       checked. */
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

    const code = line.replace(/\/\/.*$/, "");

    for (const match of code.matchAll(/"([^"\\]{4,300})"|'([^'\\]{4,300})'|`([^`\\$]{4,300})`/g)) {
      const text = match[1] ?? match[2] ?? match[3];
      found.push({ line: index + 1, text });
    }
    // JSX text between tags on one line: >Some words here<
    for (const match of code.matchAll(/>([^<>{}"']{4,300})</g)) {
      found.push({ line: index + 1, text: match[1] });
    }

    /* JSX text on a line of its own, which is how anything inside a multi-line
       element is written — including the back-link at the top of every detail
       screen, which said "Trades" for a whole commit after the rest of the
       product stopped. Prose only: no punctuation that belongs to code.

       HTML entities are folded away first. `&rsquo;` carries both an ampersand
       and a semicolon, and the semicolon is in the punctuation this rejects as
       code — so a line containing one was invisible to this check. It hid the
       largest sentence on the sign-in page, which promised to "Swap residency
       shifts" for as long as this guard has existed. An allowlist is where a
       guard's blind spots live; so is its idea of what punctuation means. */
    /* A bare `{NAME}` interpolation is a word to the reader, so a sentence
       containing one is still a sentence — the invitation page's "lets you swap
       them with your co-residents" hid behind a leading `{APP_NAME}`. Only the
       simple identifier form is folded; anything with a call, a member access
       or an operator in it is code and stays excluded. */
    const prosed = trimmed
      .replace(/&[a-z]+;/gi, "e")
      .replace(/\{[A-Za-z_$][A-Za-z0-9_$]*\}/g, "word");
    if (
      /^[A-Za-z][A-Za-z0-9 ,.'\u2019\u2014-]{3,200}$/.test(prosed) &&
      // At least two words, or it is an identifier on its own line, not prose.
      /\s/.test(prosed) &&
      !/[;:={}()<>"'`[\]]/.test(prosed)
    ) {
      found.push({ line: index + 1, text: prosed });
    }
  });

  return found;
}

function offences(): string[] {
  const problems: string[] = [];
  for (const target of SCANNED) {
    for (const file of walk(target)) {
      const relative = path.relative(ROOT, file);
      for (const { line, text } of prose(readFileSync(file, "utf8"))) {
        if (!REJECTED.test(text)) continue;
        if (NOT_PROSE.some((pattern) => pattern.test(text))) continue;
        if (CLASSNAME.test(text)) continue;
        problems.push(`${relative}:${line}  ${text.trim()}`);
      }
    }
  }
  return problems.sort();
}

describe("one word per concept", () => {
  it("never says trade or swap where somebody can read it", () => {
    const problems = offences();
    expect(
      problems,
      `The exchange is a "switch", everywhere and at every stage. Rewrite:\n` +
        problems.join("\n"),
    ).toEqual([]);
  });

  it("catches the rejected words itself, so a passing run means something", () => {
    /* A guard nobody has seen fail is a guard that might be matching nothing.
       These are the exact shapes the real offences took. */
    expect(REJECTED.test("Post this shift for trade")).toBe(true);
    expect(REJECTED.test("Residents may swap these shifts")).toBe(true);
    expect(REJECTED.test("Blocks the trade")).toBe(true);
    expect(REJECTED.test("This shift is marked non-tradeable")).toBe(true);
    expect(REJECTED.test("Accept this handoff")).toBe(true);
    expect(REJECTED.test("Shift handover requested")).toBe(true);

    // And does not fire on the words that are allowed to survive.
    expect(REJECTED.test("Post this shift for switch")).toBe(false);
    expect(REJECTED.test("Switch completed")).toBe(false);
    expect(REJECTED.test("upgrade")).toBe(false);
    /* The words this product chose for a one-way transfer, which must survive
       a check whose whole job is rejecting the alternatives. */
    expect(REJECTED.test("Give away this shift")).toBe(false);
    expect(REJECTED.test("Somebody took your shift")).toBe(false);
    expect(REJECTED.test("Pick up this shift")).toBe(false);
    /* "Coverage" is the chief's word for staffing levels and is untouched. */
    expect(REJECTED.test("This shift is covered")).toBe(false);
  });
});
