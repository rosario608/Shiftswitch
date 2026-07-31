import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseJson, requireUuid } from "@/server/http/api";
import { emailPatchSchema } from "@/lib/schemas";
import { updateEmailRecord } from "@/server/domain/email";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (request: Request, ctx: { params: Promise<{ emailId: string }> }) => {
    const context = await requireUser();
    const { emailId: rawId } = await ctx.params;
    const emailId = requireUuid(rawId, "email");
    const patch = await parseJson(request, emailPatchSchema);
    const email = await updateEmailRecord(context, emailId, patch);
    return ok({ email });
  },
);
