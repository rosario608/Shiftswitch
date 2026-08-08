import { z } from "zod";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import {
  deleteOwnAccount,
  previewAccountDeletion,
  type DeletionContext,
} from "@/server/domain/account";
import {
  destroyCurrentSessionAnywhere,
  getSessionContext,
} from "@/server/auth/session";
import { unauthenticated } from "@/server/http/errors";

export const dynamic = "force-dynamic";

/**
 * Guarded by the session alone rather than by `requireUser()`.
 *
 * An account an administrator has not yet attached to a program is still an
 * account somebody created, and both stores require that it can be deleted
 * from inside the app. Refusing here with "your account is not configured"
 * would leave exactly those users with no way out but email.
 */
async function deletionContext(): Promise<DeletionContext> {
  const session = await getSessionContext();
  if (!session) throw unauthenticated();
  return {
    user: { id: session.user.id, email: session.user.email },
    program: session.program ? { id: session.program.id } : null,
    resident: session.resident ? { id: session.resident.id } : null,
  };
}

/** What deletion will and will not remove — shown before the user confirms. */
export const GET = apiHandler(async () => {
  const preview = await previewAccountDeletion(await deletionContext());
  return ok({ preview });
});

const schema = z.object({
  confirm: z.string(),
  reason: z.string().max(500).optional(),
});

export const POST = apiHandler(async (request: Request) => {
  /* The session first, then the body. Both orders are safe — nothing is deleted
     without a session either way — but validating first told an unauthenticated
     caller the shape of the request before refusing them, which is a small thing
     to give away for nothing. */
  const context = await deletionContext();
  const input = await parseJson(request, schema);
  const result = await deleteOwnAccount(context, input);
  await destroyCurrentSessionAnywhere();
  return ok({ result });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
