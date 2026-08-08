import { requireResident } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, requireUuid } from "@/server/http/api";
import { acceptOffer } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ offerId: string }> }) => {
    const context = await requireResident();
    const { offerId: rawId } = await ctx.params;
    const offerId = requireUuid(rawId, "offer");
    const outcome = await acceptOffer(context, offerId);
    return ok(outcome);
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
