import { requireChief } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { requiredReasonSchema } from "@/lib/schemas";
import { rejectTrade } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireChief();
    const { tradeId } = await ctx.params;
    const { reason } = await parseJson(request, requiredReasonSchema);
    await rejectTrade(context, tradeId, reason);
    return ok({ rejected: true });
  },
);
