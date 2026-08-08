import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { createSite, listSites } from "@/server/domain/roster";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  abbreviation: z.string().max(16).optional(),
  address: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

export const GET = apiHandler(async () => {
  const context = await requireCapability("services.manage");
  const sites = await listSites(context.program.id);
  return ok({ sites });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("services.manage");
  const input = await parseJson(request, createSchema);
  const site = await createSite(context, input);
  return ok({ site }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
