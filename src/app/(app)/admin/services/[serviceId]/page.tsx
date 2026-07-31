import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ServiceConfig } from "@/components/app/service-config";
import { requirePageCapability } from "@/server/auth/page-guards";
import { listCoverage } from "@/server/domain/coverage";
import { listSites } from "@/server/domain/roster";
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
  const context = await requirePageCapability("services.manage");
  const { serviceId } = await params;

  const [services, sites, coverage] = await Promise.all([
    listServices(context.program.id, "service"),
    listSites(context.program.id),
    listCoverage(context.program.id, { serviceId, includeInactive: true }),
  ]);

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
    </div>
  );
}
