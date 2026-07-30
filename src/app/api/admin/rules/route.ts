import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { ruleSchema } from "@/lib/schemas";
import { createRule, listRuleTypes, listRules } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireAdmin();
  const rules = await listRules(context.program.id);
  return ok({ rules, ruleTypes: listRuleTypes() });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireAdmin();
  const input = await parseJson(request, ruleSchema);
  const rule = await createRule(context, input);
  return ok({ rule }, { status: 201 });
});
