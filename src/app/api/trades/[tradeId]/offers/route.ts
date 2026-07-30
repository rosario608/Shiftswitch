import { requireResident } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { createOfferSchema } from "@/lib/schemas";
import { createOffer } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireResident();
    const { tradeId } = await ctx.params;
    const input = await parseJson(request, createOfferSchema);
    const result = await createOffer(context, {
      tradeRequestId: tradeId,
      offeredShiftId: input.offeredShiftId,
    });
    return ok(result, { status: 201 });
  },
);
