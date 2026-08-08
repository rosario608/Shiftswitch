import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { discardHeldRows } from "@/server/domain/held-rows";

export const dynamic = "force-dynamic";

/**
 * Throwing away rows for somebody the administrator recognises as nobody — a
 * name that was in the file by mistake, or a resident who left before the
 * schedule was uploaded.
 *
 * Recorded in the audit log with the name and the count, because "where did
 * those forty shifts go" is a question somebody will ask, and the answer has to
 * exist.
 */
export const DELETE = apiHandler(
  async (_request: Request, context: { params: Promise<{ key: string }> }) => {
    const authed = await requireCapability("schedule.manage");
    const { key } = await context.params;
    const discarded = await discardHeldRows(authed.program.id, decodeURIComponent(key), {
      userId: authed.user.id,
      label: authed.user.email,
    });
    return ok({ discarded });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
