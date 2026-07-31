import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseOptionalJson, requireUuid } from "@/server/http/api";
import { approveSchema } from "@/lib/schemas";
import { approveTrade } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireCapability("approvals.decide");
    const { tradeId: rawId } = await ctx.params;
    const tradeId = requireUuid(rawId, "trade");
    const body = await parseOptionalJson(request, approveSchema, {});
    const result = await approveTrade(context, tradeId, {
      notes: body.notes,
      override: body.override,
    });
    return ok(result);
  },
);
