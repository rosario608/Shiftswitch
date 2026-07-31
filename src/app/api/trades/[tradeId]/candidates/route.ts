import { requireResident } from "@/server/auth/guards";
import { apiHandler, ok, requireUuid } from "@/server/http/api";
import { getOfferCandidates } from "@/server/domain/candidates";

export const dynamic = "force-dynamic";

/** Shifts the caller may offer for this posted shift, ranked and pre-validated. */
export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireResident();
    const { tradeId: rawId } = await ctx.params;
    const tradeId = requireUuid(rawId, "trade");
    const result = await getOfferCandidates(context, tradeId);
    return ok(result);
  },
);
