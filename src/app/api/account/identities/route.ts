import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { listIdentities } from "@/server/domain/account";

export const dynamic = "force-dynamic";

/** The sign-in methods linked to this one application account. */
export const GET = apiHandler(async () => {
  const context = await requireUser();
  const identities = await listIdentities(context.user.id);
  return ok({ identities });
});
