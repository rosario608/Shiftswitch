import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import {
  DEFAULT_TIME_BUDGET_MS,
  MAX_TIME_BUDGET_MS,
  generateDraftSchedule,
} from "@/server/domain/generator/run";

export const dynamic = "force-dynamic";

/**
 * Ask for a draft.
 *
 * Always a draft: there is no parameter that publishes, and adding one would
 * be the single most dangerous thing this endpoint could grow. A generated
 * month is a proposal until somebody has read the diff and pressed publish.
 */
const lockSchema = z.union([
  z.object({ kind: z.literal("assignment"), shiftId: z.string().uuid() }),
  z.object({ kind: z.literal("resident"), residentId: z.string().uuid() }),
  z.object({ kind: z.literal("cohort"), cohortId: z.string().uuid() }),
  z.object({ kind: z.literal("service"), serviceId: z.string().uuid() }),
  z.object({ kind: z.literal("date"), date: z.string().date() }),
]);

const requestSchema = z.object({
  name: z.string().max(120).optional(),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  /** Recorded on the draft, so a run can be reproduced exactly. */
  seed: z.number().int().min(0).max(2 ** 31).optional(),
  timeBudgetMs: z.number().int().min(0).max(MAX_TIME_BUDGET_MS).optional(),
  locks: z.array(lockSchema).max(500).optional(),
  /** Regenerate an existing draft, keeping whatever the locks protect. */
  versionId: z.string().uuid().nullable().optional(),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("scheduling.plan");
  const input = await parseJson(request, requestSchema);

  const result = await generateDraftSchedule(context, {
    name: input.name?.trim() || `Generated ${input.periodStart}`,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    seed: input.seed,
    timeBudgetMs: input.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    locks: input.locks,
    versionId: input.versionId ?? null,
  });

  return ok(result);
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
