import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { listDraftShifts } from "@/server/domain/schedule-versions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ versionId: string }> };

export const GET = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "200");
  const shifts = await listDraftShifts(context.program.id, versionId, {
    limit: Number.isFinite(limit) ? limit : 200,
  });
  return ok({ shifts });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
