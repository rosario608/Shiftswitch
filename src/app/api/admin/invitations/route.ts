import { z } from "zod";
import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { createInvitation, listInvitations } from "@/server/domain/invitations";
import { sendInvitationEmail } from "@/server/domain/invitation-email";

export const dynamic = "force-dynamic";

/**
 * Inviting somebody creates an account in the program, so it sits at the same
 * level as the rest of user management: administrator only. A chief resident
 * runs the schedule and the approvals queue, not the roster.
 */

/** Pending and historical invitations for the caller's program. */
export const GET = apiHandler(async () => {
  const context = await requireAdmin();
  const invitations = await listInvitations(context.program.id);
  return ok({ invitations });
});

const createSchema = z.object({
  /* One address or many: onboarding a program means pasting a list, not typing
     one name twenty times. */
  emails: z.array(z.string().min(3).max(320)).min(1).max(100),
  role: z.enum(["resident", "chief", "admin"]),
  pgyLevel: z.number().int().min(1).max(10).nullable().optional(),
  graduationYear: z.number().int().min(1900).max(2200).nullable().optional(),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireAdmin();
  const input = await parseJson(request, createSchema);

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
