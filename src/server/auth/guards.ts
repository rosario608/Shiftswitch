import { AppError, forbidden, unauthenticated } from "@/server/http/errors";
import type { ProgramRow, ResidentRow, UserRole } from "@/server/db/types";
import { getSessionContext, type SessionContext, type SessionUser } from "./session";
import { can, ROLE_LABEL, roleRank, type Capability } from "./roles";

/**
 * Server-side authorization. Every route handler and every server component
 * that touches data must go through one of these guards. Roles are read from
 * the database session, never from a header, query parameter, or request body.
 */

export interface AuthedContext {
  user: SessionUser & { role: UserRole; programId: string };
  program: ProgramRow;
  resident: ResidentRow | null;
  sessionId: string;
}

/**
 * Seniority comparison. This answers "who outranks whom", which matters when
 * deciding who may change whose role — it is **not** how permissions are
 * decided. For that, use `requireCapability` / `can`.
 */
export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return roleRank(role) >= roleRank(minimum);
}

export async function getOptionalContext(): Promise<SessionContext | null> {
  return getSessionContext();
}

/** Any signed-in user whose account has been configured with a role+program. */
export async function requireUser(): Promise<AuthedContext> {
  const context = await getSessionContext();
  if (!context) throw unauthenticated();
  /* Belt and braces. `loadSession` already refuses a deactivated account, so a
     context reaching here always has `active = true` and this branch does not
     fire — which is why a deactivated session observes 401 rather than 403.
     Kept because the cost is one comparison and the failure mode it guards
     against (a future change to the session query) is silent. Google sign-in
     tells the person why, in `api/auth/google/callback`. */
  if (!context.user.active) {
    throw forbidden("Your account has been deactivated.");
  }
  if (!context.user.role || !context.user.programId || !context.program) {
    throw new AppError(
      "not_configured",
      "Your account is not yet configured. Please contact your program administrator.",
    );
  }
  return {
    user: {
      ...context.user,
      role: context.user.role,
      programId: context.user.programId,
    },
    program: context.program,
    resident: context.resident,
    sessionId: context.sessionId,
  };
}

/**
 * The guard everything should use. It names what the caller is trying to do,
 * not how senior they are, so the reason for a refusal is legible at the call
 * site and the policy lives in exactly one place.
 */
export async function requireCapability(
  capability: Capability,
): Promise<AuthedContext> {
  const context = await requireUser();
  if (!can(context.user.role, capability)) {
    throw forbidden(CAPABILITY_REFUSAL[capability](context.user.role));
  }
  return context;
}

/**
 * For a screen that serves two jobs at once.
 *
 * The service configuration page is the only place this is currently needed:
 * it says both *what a service is* (`services.manage`, program leadership) and
 * *how many people it needs* (`scheduling.plan`, whoever builds the schedule).
 * Splitting it into two screens would mean a chief configuring coverage and an
 * APD renaming the service never seeing each other's half, which is how a
 * service ends up marked as needing coverage with nothing saying how much.
 *
 * The refusal names the first capability, because that is the one the screen
 * is primarily about; the caller is refused only if it holds none of them.
 */
export async function requireAnyCapability(
  capabilities: readonly [Capability, ...Capability[]],
): Promise<AuthedContext> {
  const context = await requireUser();
  if (!capabilities.some((capability) => can(context.user.role, capability))) {
    throw forbidden(CAPABILITY_REFUSAL[capabilities[0]](context.user.role));
  }
  return context;
}

/**
 * Refusal messages say what the person *is* and what the area is for, because
 * "forbidden" on its own sends people to a help desk. They never reveal
 * anything about the resource being refused.
 */
const CAPABILITY_REFUSAL: Record<Capability, (role: UserRole) => string> = {
  "trade.participate": () => "Only residents can post and offer shifts.",
  "approvals.decide": (role) =>
    `Approving switches is for chief residents and program leadership. You are signed in as ${ROLE_LABEL[role]}.`,
  "schedule.manage": (role) =>
    `Managing the schedule is for chief residents and program leadership. You are signed in as ${ROLE_LABEL[role]}.`,
  "schedule.publish": (role) =>
    `Approving and publishing a schedule is for chief residents and program leadership. You are signed in as ${ROLE_LABEL[role]}.`,
  "schedule.export_program": () =>
    "Exporting the whole program schedule is for chief residents and program leadership.",
  "analytics.view": () =>
    "Program analytics are for chief residents and program leadership.",
  "audit.view": () => "The audit log is for chief residents and program leadership.",
  "services.manage": (role) =>
    `Services and rotations are managed by program leadership. You are signed in as ${ROLE_LABEL[role]}.`,
  "invitations.manage": (role) =>
    `Inviting people is done by program leadership. You are signed in as ${ROLE_LABEL[role]}.`,
  "users.manage": (role) =>
    `Managing people and roles is done by program leadership. You are signed in as ${ROLE_LABEL[role]}.`,
  "rules.manage": () => "The rules engine is configured by program leadership.",
  "contacts.manage": () => "Program contacts are managed by program leadership.",
  "program.manage": (role) =>
    `The program's settings are changed by the Program Director or an administrator. You are signed in as ${ROLE_LABEL[role]}.`,
  "maintenance.run": () => "Maintenance is limited to program administrators.",
  "scheduling.plan": (role) =>
    `Planning cohorts, blocks and coverage is for chief residents and program leadership. You are signed in as ${ROLE_LABEL[role]}.`,
  "residents.contact_info": () =>
    "Residents' phone numbers are visible to chief residents and program leadership.",
};

/**
 * Kept for the handful of places that genuinely mean "at least this senior"
 * rather than a capability — currently none in routes, but the distinction is
 * worth preserving rather than collapsing back into a rank check.
 */
export async function requireRole(minimum: UserRole): Promise<AuthedContext> {
  const context = await requireUser();
  if (!roleAtLeast(context.user.role, minimum)) {
    throw forbidden(`This area is limited to ${ROLE_LABEL[minimum]} and above.`);
  }
  return context;
}

/** A signed-in user who is an actual resident with a resident record. */
export async function requireResident(): Promise<
  AuthedContext & { resident: ResidentRow }
> {
  const context = await requireUser();
  if (!context.resident) {
    throw forbidden(
      "This action is only available to residents with an active schedule.",
    );
  }
  return context as AuthedContext & { resident: ResidentRow };
}

/**
 * Confirms a resource belongs to the caller's program. Prevents cross-program
 * access via a guessed id.
 */
export function assertSameProgram(
  context: AuthedContext,
  programId: string | null | undefined,
): void {
  if (!programId || programId !== context.program.id) {
    throw forbidden("That item belongs to a different program.");
  }
}

/**
 * Confirms the caller owns a resident-scoped resource, unless they are a chief
 * or administrator acting within their own program.
 */
export function assertOwnResidentOrElevated(
  context: AuthedContext,
  residentId: string,
): void {
  if (context.resident?.id === residentId) return;
  if (can(context.user.role, "schedule.manage")) return;
  throw forbidden("You can only view or change your own schedule.");
}
