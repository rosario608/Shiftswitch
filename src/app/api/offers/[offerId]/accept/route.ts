import { requireResident } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { acceptOffer } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ offerId: string }> }) => {
    const context = await requireResident();
    const { offerId } = await ctx.params;
    const outcome = await acceptOffer(context, offerId);
    return ok(outcome);
  },
);
