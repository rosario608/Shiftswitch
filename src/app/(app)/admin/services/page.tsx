import { ServicesManager } from "@/components/app/services-manager";
import { TemplatePicker } from "@/components/app/template-picker";
import { requirePageCapability } from "@/server/auth/page-guards";
import { listServices } from "@/server/domain/services";

export const dynamic = "force-dynamic";
export const metadata = { title: "Services" };

export default async function ServicesPage() {
  const context = await requirePageCapability("services.manage");
  const [services, rotations] = await Promise.all([
    listServices(context.program.id, "service"),
    listServices(context.program.id, "rotation"),
  ]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Services</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          The services and rotations your program runs. A shift belongs to one
          service; rotations are optional. Both appear wherever a schedule is
          created or imported, so setting them up here means the import has
          something to match against.
        </p>
      </header>

      {services.length === 0 ? <TemplatePicker /> : null}

      <ServicesManager
        services={services.map(toRow)}
        rotations={rotations.map(toRow)}
      />

      {services.length > 0 ? <TemplatePicker /> : null}
    </div>
  );
}

function toRow(record: Awaited<ReturnType<typeof listServices>>[number]) {
  return {
    id: record.id,
    name: record.name,
    abbreviation: record.abbreviation,
    active: record.active,
    tradeable: record.tradeable,
    shift_count: Number(record.shift_count),
    upcoming_shift_count: Number(record.upcoming_shift_count),
    site_name: record.site_name,
    coverage_count: Number(record.coverage_count),
    coverage_mandatory: record.coverage_mandatory,
  };
}
