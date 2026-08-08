import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { listAuditLogs } from "@/server/domain/audit";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  const context = await requireCapability("audit.view");
  const url = new URL(request.url);
  const logs = await listAuditLogs({
    programId: context.program.id,
    action: url.searchParams.get("action") ?? undefined,
    entityType: url.searchParams.get("entityType") ?? undefined,
    entityId: url.searchParams.get("entityId") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 50),
    offset: Number(url.searchParams.get("offset") ?? 0),
  });
  return ok({ logs });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
