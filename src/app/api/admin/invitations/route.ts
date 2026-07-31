import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { userRole } from "@/lib/schemas";
import { createInvitation, listInvitations } from "@/server/domain/invitations";
import { sendInvitationEmail } from "@/server/domain/invitation-email";
import { assignableRoles, canAssignRole, ROLE_LABEL } from "@/server/auth/roles";
import { forbidden } from "@/server/http/errors";

export const dynamic = "force-dynamic";

/**
 * Inviting somebody creates an account in the program, so it needs the same
 * capability as the rest of user management. A chief resident runs the schedule
 * and the approvals queue, not the roster.
 *
 * The role being invited is checked against what the inviter may *assign*, so
 * an APD cannot invite a PD and nobody can invite an administrator except an
 * administrator. Without that, invitation would be a way around the role rules
 * rather than an application of them.
 */

/** Pending and historical invitations for the caller's program. */
export const GET = apiHandler(async () => {
  const context = await requireCapability("invitations.manage");
  const invitations = await listInvitations(context.program.id);
  return ok({ invitations });
});

const createSchema = z.object({
  /* One address or many: onboarding a program means pasting a list, not typing
     one name twenty times. */
  emails: z.array(z.string().min(3).max(320)).min(1).max(100),
  role: userRole,
  pgyLevel: z.number().int().min(1).max(10).nullable().optional(),
  graduationYear: z.number().int().min(1900).max(2200).nullable().optional(),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("invitations.manage");
  const input = await parseJson(request, createSchema);

  if (!canAssignRole(context.user.role, input.role)) {
    throw forbidden(
      `As ${ROLE_LABEL[context.user.role]} you can invite ${assignableRoles(context.user.role)
        .map((role) => ROLE_LABEL[role])
        .join(", ")} — not ${ROLE_LABEL[input.role]}.`,
    );
  }

  const created: Array<{ email: string; url: string; id: string }> = [];
  const failed: Array<{ email: string; reason: string }> = [];

  /* Each address is independent: one bad entry in a pasted list must not throw
     away the twenty good ones. */
  for (const rawEmail of input.emails) {
    const email = rawEmail.trim();
    if (!email) continue;
    try {
      const result = await createInvitation(context, {
        email,
        role: input.role,
        pgyLevel: input.pgyLevel ?? null,
        graduationYear: input.graduationYear ?? null,
      });
      await sendInvitationEmail(context, result);
      created.push({ email, url: result.url, id: result.invitation.id });
    } catch (error) {
      failed.push({
        email,
        reason:
          error instanceof Error ? error.message : "Could not create that invitation.",
      });
    }
  }

  return ok({ created, failed }, { status: created.length > 0 ? 201 : 200 });
});
