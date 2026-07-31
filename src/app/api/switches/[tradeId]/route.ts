import { requireUser, roleAtLeast } from "@/server/auth/guards";
import { apiHandler, ok, requireUuid } from "@/server/http/api";
import { forbidden, notFound } from "@/server/http/errors";
import { getCompletedTrade } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

/** A completed switch. Visible to the two residents involved and to chiefs. */
export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireUser();
    const { tradeId: rawId } = await ctx.params;
    const tradeId = requireUuid(rawId, "switch");
    const trade = await getCompletedTrade(tradeId, context.program.id);
    if (!trade) throw notFound("That switch no longer exists.");

    const residentId = context.resident?.id ?? null;
    const isParticipant =
      residentId === trade.resident_a || residentId === trade.resident_b;
    if (!isParticipant && !roleAtLeast(context.user.role, "chief")) {
      throw forbidden("You can only view switches you were part of.");
    }
    return ok({ trade, timezone: context.program.timezone });
  },
);
