import { requireUser } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { listIdentities } from "@/server/domain/account";

export const dynamic = "force-dynamic";

/** The sign-in methods linked to this one application account. */
export const GET = apiHandler(async () => {
  const context = await requireUser();
  const identities = await listIdentities(context.user.id);
  return ok({ identities });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
