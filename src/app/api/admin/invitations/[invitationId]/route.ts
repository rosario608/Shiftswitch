import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok, requireUuid } from "@/server/http/api";
import { resendInvitation, revokeInvitation } from "@/server/domain/invitations";
import { sendInvitationEmail } from "@/server/domain/invitation-email";

export const dynamic = "force-dynamic";

/** Resend: rotates the token, extends the deadline, and re-delivers. */
export const POST = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ invitationId: string }> }) => {
    const context = await requireAdmin();
    const { invitationId: raw } = await ctx.params;
    const invitationId = requireUuid(raw, "invitation");
    const result = await resendInvitation(context, invitationId);
    await sendInvitationEmail(context, result);
    return ok({ invitation: result.invitation, url: result.url });
  },
);

export const DELETE = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ invitationId: string }> }) => {
    const context = await requireAdmin();
    const { invitationId: raw } = await ctx.params;
    const invitationId = requireUuid(raw, "invitation");
    await revokeInvitation(context, invitationId);
    return ok({ revoked: true });
  },
);
