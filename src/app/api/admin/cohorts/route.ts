import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { createCohort, listCohorts } from "@/server/domain/cohorts";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  label: z.string().min(1).max(120),
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
