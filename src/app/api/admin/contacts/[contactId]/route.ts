import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { contactPatchSchema } from "@/lib/schemas";
import { deleteContact, updateContact } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (request: Request, ctx: { params: Promise<{ contactId: string }> }) => {
    const context = await requireAdmin();
    const { contactId } = await ctx.params;
    const patch = await parseJson(request, contactPatchSchema);
    const contact = await updateContact(context, contactId, patch);
    return ok({ contact });
  },
);

export const DELETE = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ contactId: string }> }) => {
    const context = await requireAdmin();
    const { contactId } = await ctx.params;
    await deleteContact(context, contactId);
    return ok({ deleted: true });
  },
);
