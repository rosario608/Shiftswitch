import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson, requireUuid } from "@/server/http/api";
import { requiredReasonSchema } from "@/lib/schemas";
import { requestTradeChanges } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ switchId: string }> }) => {
    const context = await requireCapability("approvals.decide");
    const { switchId: rawId } = await ctx.params;
    const switchId = requireUuid(rawId, "switch");
    const { reason } = await parseJson(request, requiredReasonSchema);
    await requestTradeChanges(context, switchId, reason);
    return ok({ changesRequested: true });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
