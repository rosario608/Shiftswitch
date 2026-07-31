import type { UserRole } from "./types";

/**
 * The five program roles, as the native client needs to talk about them.
 *
 * This duplicates `src/server/auth/roles.ts` deliberately: the native bundle is
 * a separate application and cannot import server code. What it must not do is
 * *disagree* — so it carries labels only, never permissions. Anything the
 * client decides from a role is a presentational choice; every actual
 * permission is enforced by the server on the request.
 *
 * `tests/unit/roles.test.ts` in the server project asserts the canonical list;
 * `mobile/tests/roles.test.ts` asserts this copy matches it.
 */
export const ROLE_LABEL: Record<UserRole, string> = {
  resident: "Resident",
  chief: "Chief resident",
  apd: "Associate Program Director",
  pd: "Program Director",
  admin: "Administrator",
};

export const ROLE_SHORT_LABEL: Record<UserRole, string> = {
  resident: "Resident",
  chief: "Chief",
  apd: "APD",
  pd: "PD",
  admin: "Admin",
};

/**
 * Whether this person has an administrative area in the app at all. Mirrors the
 * server's `audit.view` capability, which is the lowest bar that opens it.
 */
export function hasAdminArea(role: UserRole | null | undefined): boolean {
  return role === "chief" || role === "apd" || role === "pd" || role === "admin";
}
