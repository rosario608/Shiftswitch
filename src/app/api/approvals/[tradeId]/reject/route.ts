import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson, requireUuid } from "@/server/http/api";
import { requiredReasonSchema } from "@/lib/schemas";
import { rejectTrade } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireCapability("approvals.decide");
    const { tradeId: rawId } = await ctx.params;
    const tradeId = requireUuid(rawId, "trade");
    const { reason } = await parseJson(request, requiredReasonSchema);
    await rejectTrade(context, tradeId, reason);
    return ok({ rejected: true });
  },
);
