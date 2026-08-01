import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ServiceConfig } from "@/components/app/service-config";
import { requireAnyPageCapability } from "@/server/auth/page-guards";
import { can } from "@/server/auth/roles";
import { listRulesForService } from "@/server/domain/admin";
import { listCoverage } from "@/server/domain/coverage";
import { listSites } from "@/server/domain/roster";
import { summariseRule } from "@/server/domain/rules/handlers";
import { listServices } from "@/server/domain/services";

export const dynamic = "force-dynamic";
export const metadata = { title: "Service configuration" };

/**
 * Everything about one service that a scheduler needs to say.
 *
 * Separate from the services list because the list answers "what services do we
 * run" and this answers "what does this one require" — different questions,
 * asked at different times, and cramming both into one screen makes the common
 * one worse.
 */
export default async function ServiceConfigPage({
  params,
}: {
  params: Promise<{ serviceId: string }>;
}) {
  /* Two halves, two capabilities. Program leadership says what the service
     *is*; whoever builds the schedule says how many people it needs. Both
     arrive here, and each sees their own half editable. */
  const context = await requireAnyPageCapability(["services.manage", "scheduling.plan"]);
  const { serviceId } = await params;

  const [services, sites, coverage, rules] = await Promise.all([
    listServices(context.program.id, "service"),
    listSites(context.program.id),
    listCoverage(context.program.id, { serviceId, includeInactive: true }),
    listRulesForService(context.program.id, serviceId),
  ]);
  const mayEditRules = can(context.user.role, "rules.manage");
  const mayEditService = can(context.user.role, "services.manage");
  const mayEditCoverage = can(context.user.role, "scheduling.plan");

  const service = services.find((record) => record.id === serviceId);
  if (!service) notFound();

  return (
    <div className="space-y-5">
      <Link
        href="/admin/services"
        className="inline-flex items-center gap-1 text-sm font-semibold text-brand"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Services
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-ink">{service.name}</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          What this service is, and how many people it needs.
          {service.source_template
            ? " Added from a template — every value here is editable and none of them is a recommendation."
            : ""}
        </p>
      </header>

      <ServiceConfig
        mayEditService={mayEditService}
        mayEditCoverage={mayEditCoverage}
        service={{
          id: service.id,
          name: service.name,
          abbreviation: service.abbreviation,
          siteId: service.site_id,
          pgyMin: service.pgy_min,
          pgyMax: service.pgy_max,
          typicalShiftHours: service.typical_shift_hours,
          tradeable: service.tradeable,
          active: service.active,
          coverageMandatory: service.coverage_mandatory,
          notes: service.notes,
          contactName: service.contact_name,
          contactEmail: service.contact_email,
          contactPhone: service.contact_phone,
          shiftCount: Number(service.shift_count),
        }}
        sites={sites
          .filter((site) => site.active)
          .map((site) => ({ id: site.id, name: site.name }))}
        coverage={coverage.map((requirement) => ({
          id: requirement.id,
          scope: requirement.scope,
          label: requirement.label,
          daysOfWeek: requirement.days_of_week,
          specificDate: requirement.specific_date
            ? requirement.specific_date.toISOString().slice(0, 10)
            : null,
          periodStart: requirement.period_start
            ? requirement.period_start.toISOString().slice(0, 10)
            : null,
          periodEnd: requirement.period_end
            ? requirement.period_end.toISOString().slice(0, 10)
            : null,
          startTime: requirement.start_time ? requirement.start_time.slice(0, 5) : null,
          endTime: requirement.end_time ? requirement.end_time.slice(0, 5) : null,
          minStaff: requirement.min_staff,
          maxStaff: requirement.max_staff,
          pgyMix: requirement.pgy_mix,
          notes: requirement.notes,
        }))}
      />

      {/* Read-only on purpose. Rules are program policy and are edited in one
          place; showing them here answers "what happens when somebody tries to
          trade this" without giving two screens the power to change them. */}
      <section aria-labelledby="rules-heading">
        <h2
          id="rules-heading"
          className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase"
        >
          Rules that apply here
        </h2>
        <Card className="px-4 py-3.5">
          {rules.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No rules are active, so any trade on {service.name} is checked for
              nothing more than the two residents being able to work the shifts.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {rules.map((rule) => (
                <li key={rule.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{rule.name}</span>
                    <Badge tone={rule.severity === "error" ? "critical" : "caution"}>
                      {rule.severity === "error" ? "Blocks the trade" : "Warns"}
                    </Badge>
                    {rule.scope === "service" ? (
                      <Badge tone="neutral">This service only</Badge>
                    ) : (
                      <Badge tone="neutral">Program-wide</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-ink-muted">{summariseRule(rule)}</p>
                </li>
              ))}
            </ul>
          )}
          {mayEditRules ? (
            <Link
              href="/admin/rules"
              className="mt-3 inline-block text-sm font-semibold text-brand"
            >
              Change these in Trade rules
            </Link>
          ) : null}
        </Card>
      </section>
    </div>
  );
}
