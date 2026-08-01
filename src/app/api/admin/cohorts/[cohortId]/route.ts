import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import {
  addCohortMember,
  deleteCohort,
  removeCohortMember,
  updateCohort,
} from "@/server/domain/cohorts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ cohortId: string }> };

const patchSchema = z.object({
  /** See the create route: the blank-label message is the domain's to give. */
  label: z.string().max(120).optional(),
  pgyLevel: z.number().int().min(1).max(10).optional(),
  startDate: z.string().date().nullable().optional(),
  endDate: z.string().date().nullable().optional(),
  pairedCohortId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
  active: z.boolean().optional(),
  /** Membership changes ride on the same endpoint the screen already calls. */
  addResidentId: z.string().uuid().optional(),
  removeResidentId: z.string().uuid().optional(),
});

export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { cohortId } = await params;
  const input = await parseJson(request, patchSchema);

  if (input.addResidentId) {
    await addCohortMember(context, cohortId, input.addResidentId);
  }
  if (input.removeResidentId) {
    await removeCohortMember(context, cohortId, input.removeResidentId);
  }

  // Membership was handled above; the rest is the cohort's own fields.
  const rest = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => key !== "addResidentId" && key !== "removeResidentId",
    ),
  );
  const cohort =
    Object.keys(rest).length > 0
      ? await updateCohort(context, cohortId, rest)
      : null;
  return ok({ cohort });
});

export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { cohortId } = await params;
  await deleteCohort(context, cohortId);
  return ok({ deleted: true });
});
