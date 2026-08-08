import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { getProgramAnalytics } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireCapability("analytics.view");
  const analytics = await getProgramAnalytics(context.program.id);
  return ok({ analytics });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
