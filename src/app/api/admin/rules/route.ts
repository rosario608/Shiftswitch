import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { ruleSchema } from "@/lib/schemas";
import { createRule, listRuleTypes, listRules } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireCapability("rules.manage");
  const rules = await listRules(context.program.id);
  return ok({ rules, ruleTypes: listRuleTypes() });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("rules.manage");
  const input = await parseJson(request, ruleSchema);
  const rule = await createRule(context, input);
  return ok({ rule }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
