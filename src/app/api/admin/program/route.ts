import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { programPatchSchema } from "@/lib/schemas";
import { updateProgram } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(async (request: Request) => {
  const context = await requireAdmin();
  const patch = await parseJson(request, programPatchSchema);
  const program = await updateProgram(context, patch);
  return ok({ program });
});
