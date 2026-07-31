import { requireResident } from "@/server/auth/guards";
import { apiHandler, ok, requireUuid } from "@/server/http/api";
import { withdrawOffer } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ offerId: string }> }) => {
    const context = await requireResident();
    const { offerId: rawId } = await ctx.params;
    const offerId = requireUuid(rawId, "offer");
    await withdrawOffer(context, offerId);
    return ok({ withdrawn: true });
  },
);
