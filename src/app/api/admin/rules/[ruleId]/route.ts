import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson, requireUuid } from "@/server/http/api";
import { rulePatchSchema } from "@/lib/schemas";
import { deleteRule, updateRule } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(
  async (request: Request, ctx: { params: Promise<{ ruleId: string }> }) => {
    const context = await requireCapability("rules.manage");
    const { ruleId: rawId } = await ctx.params;
    const ruleId = requireUuid(rawId, "rule");
    const patch = await parseJson(request, rulePatchSchema);
    const rule = await updateRule(context, ruleId, patch);
    return ok({ rule });
  },
);

export const DELETE = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ ruleId: string }> }) => {
    const context = await requireCapability("rules.manage");
    const { ruleId: rawId } = await ctx.params;
    const ruleId = requireUuid(rawId, "rule");
    await deleteRule(context, ruleId);
    return ok({ deleted: true });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
