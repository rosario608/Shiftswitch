import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import {
  createScheduleVersion,
  listScheduleVersions,
} from "@/server/domain/schedule-versions";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  blockStructureId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
  copyFromPublished: z.boolean().optional(),
});

export const GET = apiHandler(async () => {
  const context = await requireCapability("scheduling.plan");
  const versions = await listScheduleVersions(context.program.id);
  return ok({ versions });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("scheduling.plan");
  const input = await parseJson(request, createSchema);
  const version = await createScheduleVersion(context, input);
  return ok({ version }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
