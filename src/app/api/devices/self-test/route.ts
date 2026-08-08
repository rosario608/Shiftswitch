import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { requireUser } from "@/server/auth/guards";
import { sendSelfTestPush } from "@/server/domain/push";

export const dynamic = "force-dynamic";

/**
 * "Send me a test notification."
 *
 * Reachable by any signed-in user, because the person who needs to know whether
 * push works on *their* phone is the person holding it. It can only ever target
 * the caller's own devices — the user id comes from the session and is never
 * read from the request.
 */
export const POST = apiHandler(async () => {
  const context = await requireUser();
  const outcome = await sendSelfTestPush(context.user.id);
  return ok(outcome);
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
