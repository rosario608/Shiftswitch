import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson, requireUuid } from "@/server/http/api";
import { shiftPatchSchema } from "@/lib/schemas";
import { deleteShift, updateShift } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (request: Request, ctx: { params: Promise<{ shiftId: string }> }) => {
    const context = await requireCapability("schedule.manage");
    const { shiftId: rawId } = await ctx.params;
    const shiftId = requireUuid(rawId, "shift");
    const patch = await parseJson(request, shiftPatchSchema);
    const shift = await updateShift(context, shiftId, patch);
    return ok({ shift });
  },
);

/**
 * Removes a shift. Refused when the shift carries history — see `deleteShift`.
 * Chief-or-above only, like every other administrative schedule operation.
 */
export const DELETE = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ shiftId: string }> }) => {
    const context = await requireCapability("schedule.manage");
    const { shiftId: rawId } = await ctx.params;
    const shiftId = requireUuid(rawId, "shift");
    await deleteShift(context, shiftId);
    return ok({ deleted: true });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
