import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { deleteCoverage, updateCoverage } from "@/server/domain/coverage";
import { coverageSchema } from "../route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ coverageId: string }> };

export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { coverageId } = await params;
  const input = await parseJson(request, coverageSchema);
  const requirement = await updateCoverage(context, coverageId, input);
  return ok({ requirement });
});

export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { coverageId } = await params;
  await deleteCoverage(context, coverageId);
  return ok({ deleted: true });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
