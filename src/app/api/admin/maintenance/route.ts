import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { runMaintenance } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

/** Expires stale posts/offers and closes out shifts that have been worked. */
export const POST = apiHandler(async () => {
  const context = await requireCapability("maintenance.run");
  const result = await runMaintenance(context.program.id);
  return ok({ result });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
