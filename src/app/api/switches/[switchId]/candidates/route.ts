import { requireResident } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, requireUuid } from "@/server/http/api";
import { getOfferCandidates } from "@/server/domain/candidates";

export const dynamic = "force-dynamic";

/** Shifts the caller may offer for this posted shift, ranked and pre-validated. */
export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ switchId: string }> }) => {
    const context = await requireResident();
    const { switchId: rawId } = await ctx.params;
    const switchId = requireUuid(rawId, "switch");
    const result = await getOfferCandidates(context, switchId);
    return ok(result);
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
