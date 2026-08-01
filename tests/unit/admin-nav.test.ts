import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No administration nav label may contain another one.
 *
 * This is not a style rule. Playwright's `getByRole("link", { name })` matches
 * by substring, and so does a person scanning a list — so two entries named
 * "Services" and "Set up services" are ambiguous to a locator, to a screen
 * reader announcing the landmark, and to a coordinator looking for the services
 * screen.
 *
 * That exact pair shipped and broke `roles-and-onboarding.spec.ts` with a strict
 * mode violation, which is the good outcome: the test caught a real ambiguity
 * rather than a typo. This asserts the property directly so the next one is
 * caught at the point it is written rather than eleven minutes into a verify.
 *
 * Read off the source rather than imported, because the layout is a server
 * component in a route group and importing it drags Next's whole request
 * context into a unit test for the sake of a list of strings.
 */

const SOURCE = readFileSync(
  path.join(process.cwd(), "src/app/(app)/admin/layout.tsx"),
  "utf8",
);

function navLabels(): string[] {
  return [...SOURCE.matchAll(/label:\s*"([^"]+)"/g)].map((match) => match[1]);
}

describe("the administration navigation", () => {
  it("has labels at all, or this test is asserting nothing", () => {
    expect(navLabels().length).toBeGreaterThan(10);
  });

  it("never gives one entry a name that contains another's", () => {
    const labels = navLabels();
    const clashes: string[] = [];
    for (const outer of labels) {
      for (const inner of labels) {
        if (outer === inner) continue;
        if (outer.toLowerCase().includes(inner.toLowerCase())) {
          clashes.push(`"${inner}" is inside "${outer}"`);
        }
      }
    }
    expect(
      clashes,
      "Two nav entries whose names contain each other are ambiguous to a " +
        "screen reader and to every locator that matches by substring. Rename " +
        "one of each pair:\n" +
        clashes.join("\n"),
    ).toEqual([]);
  });
});
