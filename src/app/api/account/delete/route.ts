import { z } from "zod";
import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { deleteOwnAccount, previewAccountDeletion } from "@/server/domain/account";
import { destroyCurrentSessionAnywhere } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/** What deletion will and will not remove — shown before the user confirms. */
export const GET = apiHandler(async () => {
  const context = await requireUser();
  const preview = await previewAccountDeletion(context);
  return ok({ preview });
});

const schema = z.object({
  confirm: z.string(),
  reason: z.string().max(500).optional(),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const input = await parseJson(request, schema);
  const result = await deleteOwnAccount(context, input);
  await destroyCurrentSessionAnywhere();
  return ok({ result });
});
