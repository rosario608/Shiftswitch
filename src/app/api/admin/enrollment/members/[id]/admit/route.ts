import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { admitMember } from "@/server/domain/enrollment";

export const dynamic = "force-dynamic";

/**
 * Confirming somebody who joined by a link with an address the program had not
 * listed. Until this happens they hold their own schedule and see nothing about
 * anybody else, so this is the moment they become a colleague rather than a
 * visitor — which is `users.manage`, the same authority as any other change to
 * who somebody is in the program.
 */
export const POST = apiHandler(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const authed = await requireCapability("users.manage");
    const { id } = await context.params;
    const user = await admitMember(authed, id);
    return ok({ id: user.id, email: user.email });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
