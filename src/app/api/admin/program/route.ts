import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { programPatchSchema } from "@/lib/schemas";
import { updateProgram } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(async (request: Request) => {
  const context = await requireCapability("program.manage");
  const patch = await parseJson(request, programPatchSchema);
  const program = await updateProgram(context, patch);
  return ok({ program });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
