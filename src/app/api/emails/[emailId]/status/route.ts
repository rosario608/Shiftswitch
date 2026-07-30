import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { emailStatusSchema } from "@/lib/schemas";
import { setEmailStatus } from "@/server/domain/email";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (request: Request, ctx: { params: Promise<{ emailId: string }> }) => {
    const context = await requireUser();
    const { emailId } = await ctx.params;
    const { status } = await parseJson(request, emailStatusSchema);
    const record = await setEmailStatus(context, emailId, status);
    return ok({ record });
  },
);
