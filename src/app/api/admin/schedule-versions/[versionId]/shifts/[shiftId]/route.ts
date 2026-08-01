import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { assignDraftShift, removeDraftShift } from "@/server/domain/schedule-versions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ versionId: string; shiftId: string }> };

/**
 * `null` is a value, not an omission: clearing a shift is how a scheduler says
 * "this one still needs somebody", and it is what the dashboard's unstaffed
 * count is counting. So the field is required and nullable rather than
 * optional — an absent key would be ambiguous between "leave it" and "clear
 * it", and the two differ by somebody's weekend.
 */
const patchSchema = z.object({
  residentId: z.string().uuid().nullable(),
});

export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId, shiftId } = await params;
  const input = await parseJson(request, patchSchema);
  await assignDraftShift(context, versionId, shiftId, input.residentId);
  return ok({ assigned: true });
});

export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId, shiftId } = await params;
  await removeDraftShift(context, versionId, shiftId);
  return ok({ removed: true });
});
