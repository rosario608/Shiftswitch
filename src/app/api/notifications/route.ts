import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { countUnread, listNotifications } from "@/server/domain/notifications";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const url = new URL(request.url);
  const notifications = await listNotifications(context.user.id, {
    limit: Number(url.searchParams.get("limit") ?? 50),
    unreadOnly: url.searchParams.get("unread") === "true",
  });
  const unread = await countUnread(context.user.id);
  return ok({ notifications, unread });
});
