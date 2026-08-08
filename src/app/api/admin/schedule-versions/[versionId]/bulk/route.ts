import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { bulkAssign, repeatWeek } from "@/server/domain/schedule-bulk";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ versionId: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign"),
    changes: z
      .array(
        z.object({
          shiftId: z.string().uuid(),
          /* Nullable and not optional: "nobody" is a destination a scheduler
             chooses, and an omitted key would make it indistinguishable from
             "leave this one alone". */
          residentId: z.string().uuid().nullable(),
        }),
      )
      .max(500),
  }),
  z.object({
    action: z.literal("repeat"),
    sourceStart: z.string().date(),
    targetStart: z.string().date(),
    days: z.number().int().min(1).max(31).optional(),
  }),
]);

export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  const input = await parseJson(request, schema);

  const result =
    input.action === "assign"
      ? await bulkAssign(context, versionId, input.changes)
      : await repeatWeek(context, versionId, {
          sourceStart: input.sourceStart,
          targetStart: input.targetStart,
          days: input.days,
        });

  return ok(result);
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
