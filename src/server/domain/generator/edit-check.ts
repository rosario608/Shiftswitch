import { validateSchedule } from "@/server/domain/constraints/validator";
import type { ScheduleSnapshot, Violation } from "@/server/domain/constraints/types";

/**
 * What an edit broke.
 *
 * A chief moving one person from a Tuesday does not want a fresh list of
 * everything wrong with the month — most of which was wrong before they
 * touched it, and none of which they caused. They want the answer to one
 * question: *did that break anything?*
 *
 * So this validates twice, before and after, and reports the difference. A
 * violation that was already there is not news; a violation that appeared when
 * they moved somebody is the only thing worth interrupting them for. And a
 * violation that *disappeared* is worth saying too — an edit that fixed
 * something should be told so, or a scheduler learns to distrust the check.
 */

export interface EditImpact {
  /** True when the edit introduced nothing new. */
  safe: boolean;
  introduced: Violation[];
  resolved: Violation[];
  /** Score before and after, so an edit that only made things worse is visible. */
  scoreBefore: number;
  scoreAfter: number;
  /** One sentence, for a screen that has room for one sentence. */
  summary: string;
}

/**
 * Violations are compared by what they are *about*, not by their text.
 *
 * A message that names a count — "has 1 person and needs 2" — changes when the
 * count changes, and comparing text would report the same gap as both resolved
 * and introduced. The identity of a violation is its constraint plus the
 * people, shifts and dates it concerns.
 */
function identity(violation: Violation): string {
  return [
    violation.constraintId,
    [...violation.residentIds].sort().join(","),
    [...violation.shiftIds].sort().join(","),
    [...violation.dates].sort().join(","),
  ].join("|");
}

export function assessEdit(
  before: ScheduleSnapshot,
  after: ScheduleSnapshot,
): EditImpact {
  const was = validateSchedule(before);
  const now = validateSchedule(after);

  const wasById = new Map(was.violations.map((v) => [identity(v), v]));
  const nowById = new Map(now.violations.map((v) => [identity(v), v]));

  const introduced = now.violations.filter((v) => !wasById.has(identity(v)));
  const resolved = was.violations.filter((v) => !nowById.has(identity(v)));

  const hardIntroduced = introduced.filter((v) => v.kind === "hard");
  const safe = hardIntroduced.length === 0;

  let summary: string;
  if (introduced.length === 0 && resolved.length === 0) {
    summary = "That change broke nothing and fixed nothing.";
  } else if (hardIntroduced.length > 0) {
    summary =
      hardIntroduced.length === 1
        ? `That change created a problem: ${hardIntroduced[0].message}`
        : `That change created ${hardIntroduced.length} problems, starting with: ${hardIntroduced[0].message}`;
  } else if (introduced.length > 0) {
    summary =
      `That change is legal, but it made ${introduced.length === 1 ? "something" : `${introduced.length} things`} worse — ` +
      introduced[0].message;
  } else {
    summary =
      resolved.length === 1
        ? `That change fixed a problem: ${resolved[0].message}`
        : `That change fixed ${resolved.length} problems.`;
  }

  return {
    safe,
    introduced,
    resolved,
    scoreBefore: was.score.score,
    scoreAfter: now.score.score,
    summary,
  };
}
