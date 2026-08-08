import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseOptionalJson, requireUuid } from "@/server/http/api";
import { approveSchema } from "@/lib/schemas";
import { approveTrade } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ switchId: string }> }) => {
    const context = await requireCapability("approvals.decide");
    const { switchId: rawId } = await ctx.params;
    const switchId = requireUuid(rawId, "switch");
    const body = await parseOptionalJson(request, approveSchema, {});
    const result = await approveTrade(context, switchId, {
      notes: body.notes,
      override: body.override,
    });
    return ok(result);
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
