import { requireResident } from "@/server/auth/guards";
import { apiHandler, ok, parseJson, requireUuid } from "@/server/http/api";
import { createOfferSchema } from "@/lib/schemas";
import { createOffer } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ switchId: string }> }) => {
    const context = await requireResident();
    const { switchId: rawId } = await ctx.params;
    const switchId = requireUuid(rawId, "switch");
    const input = await parseJson(request, createOfferSchema);
    const result = await createOffer(context, {
      tradeRequestId: switchId,
      offeredShiftId: input.offeredShiftId,
    });
    return ok(result, { status: 201 });
  },
);
