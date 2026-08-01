import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, requireUuid } from "@/server/http/api";
import { notFound } from "@/server/http/errors";
import { getTradeRequestDetail } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ switchId: string }> }) => {
    const context = await requireUser();
    const { switchId: rawId } = await ctx.params;
    const switchId = requireUuid(rawId, "switch");
    const detail = await getTradeRequestDetail(switchId, context.program.id);
    if (!detail) throw notFound("That posted shift no longer exists.");
    return ok({ trade: detail });
  },
);
