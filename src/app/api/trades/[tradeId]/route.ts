import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, requireUuid } from "@/server/http/api";
import { notFound } from "@/server/http/errors";
import { getTradeRequestDetail } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireUser();
    const { tradeId: rawId } = await ctx.params;
    const tradeId = requireUuid(rawId, "trade");
    const detail = await getTradeRequestDetail(tradeId, context.program.id);
    if (!detail) throw notFound("That trade post no longer exists.");
    return ok({ trade: detail });
  },
);
