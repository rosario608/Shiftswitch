import { requireResident } from "@/server/auth/guards";
import { apiHandler, ok, parseOptionalJson, requireUuid } from "@/server/http/api";
import { rejectSchema } from "@/lib/schemas";
import { rejectOffer } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ offerId: string }> }) => {
    const context = await requireResident();
    const { offerId: rawId } = await ctx.params;
    const offerId = requireUuid(rawId, "offer");
    const body = await parseOptionalJson(request, rejectSchema, {});
    await rejectOffer(context, offerId, body.reason);
    return ok({ rejected: true });
  },
);
