import { requireChief } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { getProgramAnalytics } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireChief();
  const analytics = await getProgramAnalytics(context.program.id);
  return ok({ analytics });
});
