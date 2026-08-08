import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { createCohort, listCohorts } from "@/server/domain/cohorts";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  /* No `min(1)`: an empty label is a thing a scheduler does by accident, and
     the domain answers it with "Give the cohort a label." Zod would answer it
     with "some of the information provided isn't valid", which is true and
     useless. The cap stays here, where it belongs. */
  label: z.string().max(120),
  pgyLevel: z.number().int().min(1).max(10),
  startDate: z.string().date().nullable().optional(),
  endDate: z.string().date().nullable().optional(),
  pairedCohortId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

export const GET = apiHandler(async () => {
  const context = await requireCapability("scheduling.plan");
  const cohorts = await listCohorts(context.program.id, { includeInactive: true });
  return ok({ cohorts });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("scheduling.plan");
  const input = await parseJson(request, createSchema);
  const cohort = await createCohort(context, input);
  return ok({ cohort }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
