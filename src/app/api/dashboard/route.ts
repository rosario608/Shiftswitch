import { requireUser } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { getResidentDashboard } from "@/server/domain/dashboard";
import { countUnread } from "@/server/domain/notifications";

export const dynamic = "force-dynamic";

/**
 * The home screen in one request.
 *
 * The web app builds this in a server component; the native client cannot, so
 * the same read model is exposed here rather than making the app assemble a
 * dashboard from five round trips on a hospital wifi connection.
 */
export const GET = apiHandler(async () => {
  const context = await requireUser();
  const [dashboard, unread] = await Promise.all([
    getResidentDashboard(context),
    countUnread(context.user.id),
  ]);
  return ok({
    dashboard,
    unread,
    timezone: context.program.timezone,
    role: context.user.role,
  });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
