import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What a person reads when an action fails.
 *
 * `useAction` is the single funnel every mutation in the product goes through,
 * and it decides which sentence reaches the screen. It used to keep the message
 * only when the failure came back from the server, and replace every other one
 * with "Something went wrong. Please try again." — including the eight places a
 * component raises a written explanation *before* calling the server:
 *
 *   "Add at least one email address."
 *   "Choose a date."
 *   "Give the service a name."
 *   "This service would be open to PGY-3 through PGY-1, which is nobody."
 *   "Nothing could be built that satisfies every rule…"
 *
 * Each of those is the whole value of the failure — it says what to do next —
 * and each was invisible. Worse, the replacement is indistinguishable from the
 * app genuinely breaking, so the honest reaction to it is to stop trusting the
 * screen.
 *
 * Asserted against the source rather than by rendering, because the property is
 * about one branch in one file and a hook test would need a DOM, a renderer and
 * a mock server to observe the same line.
 */

const USE_ACTION = readFileSync(join(process.cwd(), "src/lib/use-action.ts"), "utf8");

describe("the message an action failure shows", () => {
  it("keeps what a component wrote, not just what the server said", () => {
    /* Both branches, in one condition: an ApiError already is an Error, so the
       test is that the general case is handled, not that the specific one is
       listed first. */
    expect(USE_ACTION).toMatch(/caught instanceof Error/);
  });

  it("still has a fallback for something that is not an Error at all", () => {
    expect(USE_ACTION).toContain("Something went wrong. Please try again.");
  });

  it("has no component raising a message written for a developer", () => {
    /* The other half of the same property: now that thrown messages are shown,
       every one of them has to read as a sentence somebody can act on. */
    const files = [
      "src/components/app/shift-create.tsx",
      "src/components/app/invitations-manager.tsx",
      "src/components/app/service-config.tsx",
      "src/components/app/schedule-workspace.tsx",
      "src/components/app/rules-manager.tsx",
      "src/components/app/services-manager.tsx",
      "src/components/app/cohorts-manager.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const match of source.matchAll(/throw new Error\(\s*"([^"]+)"/g)) {
        const message = match[1];
        expect(
          /^[A-Z]/.test(message),
          `${file}: "${message}" does not start like a sentence`,
        ).toBe(true);
        expect(
          message.length > 12,
          `${file}: "${message}" is too short to explain anything`,
        ).toBe(true);
      }
    }
  });
});
