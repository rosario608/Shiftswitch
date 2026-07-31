import { requireChief } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { runMaintenance } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

/** Expires stale posts/offers and closes out shifts that have been worked. */
export const POST = apiHandler(async () => {
  const context = await requireChief();
  const result = await runMaintenance(context.program.id);
  return ok({ result });
});
