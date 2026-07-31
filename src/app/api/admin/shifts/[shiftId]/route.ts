import { requireChief } from "@/server/auth/guards";
import { apiHandler, ok, parseJson, requireUuid } from "@/server/http/api";
import { shiftPatchSchema } from "@/lib/schemas";
import { updateShift } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (request: Request, ctx: { params: Promise<{ shiftId: string }> }) => {
    const context = await requireChief();
    const { shiftId: rawId } = await ctx.params;
    const shiftId = requireUuid(rawId, "shift");
    const patch = await parseJson(request, shiftPatchSchema);
    const shift = await updateShift(context, shiftId, patch);
    return ok({ shift });
  },
);
