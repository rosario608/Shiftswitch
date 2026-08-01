import { Alert } from "@/components/ui/alert";
import { RulesManager, type RuleRecord } from "@/components/app/rules-manager";
import { requirePageCapability } from "@/server/auth/page-guards";
import { listRuleTypes, listRules } from "@/server/domain/admin";
import { summariseRule } from "@/server/domain/rules/handlers";
import { listServices } from "@/server/domain/schedule-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rules" };

const CATEGORY_LABEL: Record<number, string> = {
  1: "Safety",
  2: "Program policy",
  3: "Service",
  4: "Shift",
  5: "Preference",
};

export default async function RulesPage() {
  const context = await requirePageCapability("rules.manage");
  const [rules, services] = await Promise.all([
    listRules(context.program.id),
    listServices(context.program.id),
  ]);
  const ruleTypes = listRuleTypes();
  const categoryByType = new Map(ruleTypes.map((type) => [type.type, type.category]));

  const records: RuleRecord[] = rules.map((rule) => ({
    id: rule.id,
    rule_type: rule.rule_type,
    name: rule.name,
    description: rule.description,
    params: rule.params,
    severity: rule.severity,
    scope: rule.scope,
    scope_id: rule.scope_id,
    overridable: rule.overridable,
    active: rule.active,
    summary: summariseRule(rule),
    categoryLabel: CATEGORY_LABEL[categoryByType.get(rule.rule_type) ?? 5] ?? "Other",
  }));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Switch rules</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Every rule here is evaluated on the server whenever a trade is offered,
          accepted, and finalised.
        </p>
      </header>

      <Alert tone="info" title="Rule precedence">
        Failures are reported in this order: safety and coverage first, then
        program policy, then service and rotation requirements, then shift-specific
        settings, then preferences.
      </Alert>

      <RulesManager
        rules={records}
        ruleTypes={ruleTypes}
        services={services.map((service) => ({ id: service.id, name: service.name }))}
      />
    </div>
  );
}
