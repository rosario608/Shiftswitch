import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import {
  correctPublishedShift,
  listCorrections,
} from "@/server/domain/schedule-corrections";

export const dynamic = "force-dynamic";

const correctSchema = z.object({
  shiftId: z.string().uuid(),
  /* Nullable and not optional: correcting a shift to nobody is a real
     intention — the service is closed, the post is unfilled — and an omitted
     key would be indistinguishable from "leave it alone". */
  residentId: z.string().uuid().nullable(),
  /* No `min(1)`: the domain answers an empty reason with a sentence about who
     will read it, which is more use than "some of the information provided
     isn't valid". */
  reason: z.string().max(1000),
});

export const GET = apiHandler(async (request: Request) => {
  const context = await requireCapability("schedule.manage");
  const url = new URL(request.url);
  const corrections = await listCorrections(context.program.id, {
    versionId: url.searchParams.get("versionId"),
    from: url.searchParams.get("from") ?? undefined,
  });
  return ok({ corrections });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("schedule.manage");
  const input = await parseJson(request, correctSchema);
  const result = await correctPublishedShift(context, input.shiftId, {
    residentId: input.residentId,
    reason: input.reason,
  });
  return ok(result);
});
