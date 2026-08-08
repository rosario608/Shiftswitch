import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import {
  defaultPeriod,
  loadScheduleSnapshot,
} from "@/server/domain/constraints/snapshot";
import { validateSchedule } from "@/server/domain/constraints/validator";

export const dynamic = "force-dynamic";

/**
 * Validate a schedule on demand.
 *
 * A POST rather than a GET, because it is not free — it reads the whole
 * window and every constraint runs over it — and because a chief asking
 * "check this" is making a request, not fetching a page. Nothing is written.
 */
const requestSchema = z.object({
  /** Omitted validates the live schedule from today onward. */
  versionId: z.string().uuid().nullable().optional(),
  periodStart: z.string().date().optional(),
  periodEnd: z.string().date().optional(),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("scheduling.plan");
  const input = await parseJson(request, requestSchema);

  const period =
    input.periodStart && input.periodEnd
      ? { start: input.periodStart, end: input.periodEnd }
      : await defaultPeriod(context.program.id, context.program.timezone);

  const snapshot = await loadScheduleSnapshot(
    {
      id: context.program.id,
      name: context.program.name,
      timezone: context.program.timezone,
    },
    {
      period,
      versionId: input.versionId ?? null,
      /* A draft is judged partly on how much it moves; the live schedule has
         nothing to be compared against. */
      withBaseline: Boolean(input.versionId),
    },
  );

  return ok({ period, validation: validateSchedule(snapshot) });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
