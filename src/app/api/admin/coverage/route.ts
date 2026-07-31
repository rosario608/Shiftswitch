import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { createCoverage, listCoverage } from "@/server/domain/coverage";

export const dynamic = "force-dynamic";

const pgyMix = z.array(
  z.object({
    pgy: z.number().int().min(1).max(10),
    min: z.number().int().min(0).max(20),
    max: z.number().int().min(0).max(20).nullable(),
  }),
).max(10);

export const coverageSchema = z.object({
  serviceId: z.string().uuid(),
  scope: z.enum(["weekday", "period", "date"]),
  label: z.string().max(120).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  specificDate: z.string().date().nullable().optional(),
  periodStart: z.string().date().nullable().optional(),
  periodEnd: z.string().date().nullable().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  minStaff: z.number().int().min(0).max(50),
  maxStaff: z.number().int().min(0).max(50).nullable().optional(),
  pgyMix: pgyMix.optional(),
  notes: z.string().max(2000).optional(),
  active: z.boolean().optional(),
});

export const GET = apiHandler(async (request: Request) => {
  const context = await requireCapability("services.manage");
  const serviceId = new URL(request.url).searchParams.get("serviceId") ?? undefined;
  const requirements = await listCoverage(context.program.id, { serviceId });
  return ok({ requirements });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("services.manage");
  const input = await parseJson(request, coverageSchema);
  const requirement = await createCoverage(context, input);
  return ok({ requirement }, { status: 201 });
});
