import { requireChief } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { listPendingApprovals } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireChief();
  const approvals = await listPendingApprovals(context.program.id);
  return ok({ approvals });
});
