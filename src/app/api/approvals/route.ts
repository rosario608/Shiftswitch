import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { listPendingApprovals } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireCapability("approvals.decide");
  const approvals = await listPendingApprovals(context.program.id);
  return ok({ approvals });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
