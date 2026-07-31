import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok, parseJson, requireUuid } from "@/server/http/api";
import { userPatchSchema } from "@/lib/schemas";
import { updateManagedUser } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (request: Request, ctx: { params: Promise<{ userId: string }> }) => {
    const context = await requireAdmin();
    const { userId: rawId } = await ctx.params;
    const userId = requireUuid(rawId, "user");
    const patch = await parseJson(request, userPatchSchema);
    const user = await updateManagedUser(context, userId, patch);
    return ok({ user });
  },
);
