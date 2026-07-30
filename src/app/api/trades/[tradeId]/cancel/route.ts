import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseOptionalJson } from "@/server/http/api";
import { rejectSchema } from "@/lib/schemas";
import { cancelTradeRequest } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireUser();
    const { tradeId } = await ctx.params;
    const body = await parseOptionalJson(request, rejectSchema, {});
    await cancelTradeRequest(context, tradeId, body.reason);
    return ok({ cancelled: true });
  },
);
