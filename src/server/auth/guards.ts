import { AppError, forbidden, unauthenticated } from "@/server/http/errors";
import type { ProgramRow, ResidentRow, UserRole } from "@/server/db/types";
import { getSessionContext, type SessionContext, type SessionUser } from "./session";

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

const ROLE_RANK: Record<UserRole, number> = { resident: 1, chief: 2, admin: 3 };

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export async function getOptionalContext(): Promise<SessionContext | null> {
  return getSessionContext();
}

/** Any signed-in user whose account has been configured with a role+program. */
export async function requireUser(): Promise<AuthedContext> {
  const context = await getSessionContext();
  if (!context) throw unauthenticated();
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

export async function requireRole(minimum: UserRole): Promise<AuthedContext> {
  const context = await requireUser();
  if (!roleAtLeast(context.user.role, minimum)) {
    throw forbidden(
      minimum === "admin"
        ? "This area is limited to program administrators."
        : "This area is limited to chief residents and administrators.",
    );
  }
  return context;
}

export const requireChief = () => requireRole("chief");
export const requireAdmin = () => requireRole("admin");

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
  if (roleAtLeast(context.user.role, "chief")) return;
  throw forbidden("You can only view or change your own schedule.");
}
