import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { revokeEnrollmentLink } from "@/server/domain/enrollment";

export const dynamic = "force-dynamic";

/** Turning a link off. Idempotent: revoking an already-revoked link is fine. */
export const POST = apiHandler(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const authed = await requireCapability("invitations.manage");
    const { id } = await context.params;
    const link = await revokeEnrollmentLink(authed, id);
    return ok({ id: link.id, revokedAt: link.revoked_at });
  },
);
