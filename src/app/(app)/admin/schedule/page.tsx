import { Download } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ShiftCard } from "@/components/app/shift-card";
import { ShiftEditorButton } from "@/components/app/shift-editor";
import { ShiftCreateButton } from "@/components/app/shift-create";
import { requirePageRole } from "@/server/auth/page-guards";
import { listProgramSchedule } from "@/server/domain/admin";
import { listProgramResidents, listServices } from "@/server/domain/schedule-actions";
import { toShiftView } from "@/lib/views";

export const dynamic = "force-dynamic";
export const metadata = { title: "Program schedule" };

export default async function AdminSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    residentId?: string;
    serviceId?: string;
    pgy?: string;
    status?: string;
    search?: string;
  }>;
}) {
  const context = await requirePageRole("chief");
  const params = await searchParams;
  const [residents, services] = await Promise.all([
    listProgramResidents(context.program.id),
    listServices(context.program.id),
  ]);

  const shifts = await listProgramSchedule(context.program.id, {
    from: params.from,
    to: params.to,
    residentId: params.residentId || undefined,
    serviceId: params.serviceId || undefined,
    pgy: params.pgy ? Number(params.pgy) : undefined,
    status: params.status || undefined,
    search: params.search || undefined,
    limit: 200,
  });

  const exportQuery = new URLSearchParams({ scope: "program", format: "csv" });
  if (params.from) exportQuery.set("from", params.from);
  if (params.to) exportQuery.set("to", params.to);
  if (params.residentId) exportQuery.set("residentId", params.residentId);
  if (params.serviceId) exportQuery.set("serviceId", params.serviceId);

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Program schedule</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {shifts.length} shift{shifts.length === 1 ? "" : "s"} · times in{" "}
            {context.program.timezone}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <ShiftCreateButton
            services={services.map((service) => ({
              id: service.id,
              name: service.name,
            }))}
            residents={residents.map((resident) => ({
              id: resident.id,
              full_name: resident.full_name,
              pgy_level: resident.pgy_level,
              active: resident.active,
            }))}
            timezone={context.program.timezone}
          />
          <a
            href={`/api/admin/export?${exportQuery.toString()}`}
            className="flex min-h-[2.5rem] items-center gap-1.5 rounded-xl border border-border-strong px-3 text-sm font-semibold text-ink"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            CSV
          </a>
          <a
            href={`/api/admin/export?${new URLSearchParams({ ...Object.fromEntries(exportQuery), format: "xlsx" }).toString()}`}
            className="flex min-h-[2.5rem] items-center gap-1.5 rounded-xl border border-border-strong px-3 text-sm font-semibold text-ink"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            XLSX
          </a>
        </div>
      </header>

      <Card>
        <CardBody>
          <form method="get" className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink">From</span>
              <input
                type="date"
                name="from"
                defaultValue={params.from ?? ""}
                className="min-h-[2.75rem] w-full rounded-xl border border-border-strong bg-surface px-3"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink">To</span>
              <input
                type="date"
                name="to"
                defaultValue={params.to ?? ""}
                className="min-h-[2.75rem] w-full rounded-xl border border-border-strong bg-surface px-3"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink">Resident</span>
              <select
                name="residentId"
                defaultValue={params.residentId ?? ""}
                className="min-h-[2.75rem] w-full rounded-xl border border-border-strong bg-surface px-3"
              >
                <option value="">All residents</option>
                {residents.map((resident) => (
                  <option key={resident.id} value={resident.id}>
                    {resident.full_name} · PGY-{resident.pgy_level}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink">Service</span>
              <select
                name="serviceId"
                defaultValue={params.serviceId ?? ""}
                className="min-h-[2.75rem] w-full rounded-xl border border-border-strong bg-surface px-3"
              >
                <option value="">All services</option>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink">PGY</span>
              <select
                name="pgy"
                defaultValue={params.pgy ?? ""}
                className="min-h-[2.75rem] w-full rounded-xl border border-border-strong bg-surface px-3"
              >
                <option value="">Any</option>
                {[1, 2, 3, 4, 5].map((level) => (
                  <option key={level} value={level}>
                    PGY-{level}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium text-ink">Search</span>
              <input
                type="search"
                name="search"
                defaultValue={params.search ?? ""}
                placeholder="Name, service or location"
                className="min-h-[2.75rem] w-full rounded-xl border border-border-strong bg-surface px-3"
              />
            </label>
            <div className="sm:col-span-2">
              <button
                type="submit"
                className="min-h-[2.75rem] w-full rounded-xl bg-brand px-4 font-semibold text-white"
              >
                Apply filters
              </button>
            </div>
          </form>
        </CardBody>
      </Card>

      {shifts.length === 0 ? (
        <EmptyState
          title="No shifts match these filters"
          description="Try widening the date range or clearing a filter."
        />
      ) : (
        <ul className="space-y-2">
          {shifts.map((shift) => {
            const view = toShiftView(shift, context.program.timezone);
            return (
              <li key={shift.id}>
                <ShiftCard
                  shift={view}
                  showResident
                  action={
                    <ShiftEditorButton
                      shift={view}
                      residents={residents.map((resident) => ({
                        id: resident.id,
                        full_name: resident.full_name,
                        pgy_level: resident.pgy_level,
                        active: resident.active,
                      }))}
                    />
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
