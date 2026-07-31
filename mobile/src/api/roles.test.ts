import { describe, expect, it } from "vitest";
import { hasAdminArea, ROLE_LABEL, ROLE_SHORT_LABEL } from "./roles";
import type { UserRole } from "./types";

/**
 * The native client keeps its own copy of the role vocabulary, because it
 * cannot import server code. This is the test that stops the copy drifting:
 * the canonical list lives in `src/server/auth/roles.ts` and is asserted by
 * `tests/unit/roles.test.ts` in the server project.
 */

const ROLES: UserRole[] = ["resident", "chief", "apd", "pd", "admin"];

describe("the native client's role vocabulary", () => {
  it("knows all five roles", () => {
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...ROLES].sort());
    expect(Object.keys(ROLE_SHORT_LABEL).sort()).toEqual([...ROLES].sort());
  });

  it("uses the program's terminology, not generic tiers", () => {
    expect(ROLE_LABEL.pd).toBe("Program Director");
    expect(ROLE_LABEL.apd).toBe("Associate Program Director");
    expect(ROLE_SHORT_LABEL.pd).toBe("PD");
    expect(ROLE_SHORT_LABEL.apd).toBe("APD");
  });

  it("shows an administrative area to everybody except a resident", () => {
    expect(hasAdminArea("resident")).toBe(false);
    for (const role of ["chief", "apd", "pd", "admin"] as UserRole[]) {
      expect(hasAdminArea(role), role).toBe(true);
    }
    // An unconfigured account has no role and no administrative area.
    expect(hasAdminArea(null)).toBe(false);
    expect(hasAdminArea(undefined)).toBe(false);
  });
});
