import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseOptionalJson } from "@/server/http/api";
import { markNotificationsSchema } from "@/lib/schemas";
import { markRead } from "@/server/domain/notifications";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const body = await parseOptionalJson(request, markNotificationsSchema, {});
  const updated = await markRead(context.user.id, body.notificationIds);
  return ok({ updated });
});
