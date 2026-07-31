import { assertSameProgram, requireUser, roleAtLeast } from "@/server/auth/guards";
import { apiHandler, ok, requireUuid } from "@/server/http/api";
import { forbidden, notFound } from "@/server/http/errors";
import { getShiftDetail } from "@/server/domain/schedule";
import { queryOne } from "@/server/db/pool";

export const dynamic = "force-dynamic";

/**
 * A single shift. Visible to the assigned resident, to chiefs/administrators,
 * and to any resident in the program *only* while it is posted for trade.
 */
export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ shiftId: string }> }) => {
    const context = await requireUser();
    const { shiftId: rawId } = await ctx.params;
    const shiftId = requireUuid(rawId, "shift");
    const shift = await getShiftDetail(shiftId);
    if (!shift) throw notFound("That shift no longer exists.");
    assertSameProgram(context, shift.program_id);

    const isOwner = context.resident?.id === shift.resident_id;
    const isElevated = roleAtLeast(context.user.role, "chief");
    if (!isOwner && !isElevated) {
      const posted = await queryOne<{ id: string }>(
        `SELECT id FROM trade_requests
          WHERE source_shift_id = $1 AND status IN ('open', 'offer_pending')`,
        [shiftId],
      );
      if (!posted) {
        throw forbidden("You can only view your own shifts.");
      }
    }
    return ok({ shift, timezone: context.program.timezone });
  },
);
