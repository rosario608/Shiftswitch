import { z } from "zod";
import { queryOne } from "@/server/db/pool";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { assignDraftShift, removeDraftShift } from "@/server/domain/schedule-versions";
import { getScheduleVersion } from "@/server/domain/schedule-versions";
import { loadScheduleSnapshot } from "@/server/domain/constraints/snapshot";
import { assessEdit } from "@/server/domain/generator/edit-check";

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

  /* Snapshotted before and after, so the response can say what *this* edit
     broke rather than listing everything already wrong with the month. Most of
     what is wrong with a half-built draft is not the fault of the person who
     just moved one person off one Tuesday, and telling them otherwise trains
     them to ignore it. */
  const before = await snapshotOf(context, versionId);
  await assignDraftShift(context, versionId, shiftId, input.residentId);
  const after = before ? await snapshotOf(context, versionId) : null;

  return ok({
    assigned: true,
    impact: before && after ? assessEdit(before, after) : null,
  });
});

/**
 * The draft as it stands, over the window its shifts actually occupy.
 *
 * Not over its declared period. A draft can be declared across an absurd span —
 * "everything, ever" is a legitimate way to copy the whole published schedule
 * into a draft — and coverage is evaluated a day at a time, so validating a
 * hundred-year window on every keystroke took long enough to reset the
 * connection. The shifts are what the edit could possibly have affected.
 */
async function snapshotOf(
  context: Awaited<ReturnType<typeof requireCapability>>,
  versionId: string,
) {
  const version = await getScheduleVersion(context.program.id, versionId);
  if (!version) return null;

  const span = await queryOne<{ from: string | null; to: string | null }>(
    `SELECT min(date)::text AS from, max(date)::text AS to
       FROM shifts WHERE schedule_version_id = $1`,
    [versionId],
  );
  const declared = {
    start: version.period_start.toISOString().slice(0, 10),
    end: version.period_end.toISOString().slice(0, 10),
  };

  return loadScheduleSnapshot(
    {
      id: context.program.id,
      name: context.program.name,
      timezone: context.program.timezone,
    },
    {
      period:
        span?.from && span?.to ? { start: span.from, end: span.to } : declared,
      versionId,
    },
  );
}

export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId, shiftId } = await params;
  await removeDraftShift(context, versionId, shiftId);
  return ok({ removed: true });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
