import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import {
  listSiteEligibility,
  setSiteEligibility,
  updateSchedulingData,
} from "@/server/domain/roster";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ residentId: string }> };

const patchSchema = z.object({
  phone: z.string().max(40).optional(),
  pgyLevel: z.number().int().min(1).max(10).optional(),
  schedulable: z.boolean().optional(),
  schedulingNotes: z.string().max(2000).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  siteEligibility: z
    .array(
      z.object({
        siteId: z.string().uuid(),
        eligible: z.boolean(),
        notes: z.string().max(500).optional(),
      }),
    )
    .max(20)
    .optional(),
});

export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { residentId } = await params;
  const sites = await listSiteEligibility(context.program.id, residentId);
  return ok({ sites });
});

export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { residentId } = await params;
  const input = await parseJson(request, patchSchema);

  /* Writing a phone number needs the capability that reads one. Without this a
     chief-less role could set a number it could never see, which is a strange
     enough state to be worth refusing outright. */
  if (input.phone !== undefined) {
    await requireCapability("residents.contact_info");
  }

  for (const entry of input.siteEligibility ?? []) {
    await setSiteEligibility(
      context,
      residentId,
      entry.siteId,
      entry.eligible,
      entry.notes ?? "",
    );
  }

  // Site eligibility was applied above; the rest is the resident's own fields.
  const patch = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "siteEligibility"),
  );
  const resident = await updateSchedulingData(context, residentId, patch);
  return ok({ resident });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
