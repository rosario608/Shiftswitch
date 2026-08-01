import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseOptionalJson, requireUuid } from "@/server/http/api";
import { rejectSchema } from "@/lib/schemas";
import { cancelTradeRequest } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ switchId: string }> }) => {
    const context = await requireUser();
    const { switchId: rawId } = await ctx.params;
    const switchId = requireUuid(rawId, "switch");
    const body = await parseOptionalJson(request, rejectSchema, {});
    await cancelTradeRequest(context, switchId, body.reason);
    return ok({ cancelled: true });
  },
);
