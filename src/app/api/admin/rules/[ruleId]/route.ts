import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { rulePatchSchema } from "@/lib/schemas";
import { deleteRule, updateRule } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (request: Request, ctx: { params: Promise<{ ruleId: string }> }) => {
    const context = await requireAdmin();
    const { ruleId } = await ctx.params;
    const patch = await parseJson(request, rulePatchSchema);
    const rule = await updateRule(context, ruleId, patch);
    return ok({ rule });
  },
);

export const DELETE = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ ruleId: string }> }) => {
    const context = await requireAdmin();
    const { ruleId } = await ctx.params;
    await deleteRule(context, ruleId);
    return ok({ deleted: true });
  },
);
