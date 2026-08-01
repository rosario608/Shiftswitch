import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CycleOverrides } from "@/components/app/cycle-overrides";
import { requirePageCapability } from "@/server/auth/page-guards";
import {
  ROTATION_STATE_LABEL,
  listAllExceptions,
  listRotationPatterns,
  winterHolidayRange,
} from "@/server/domain/rotation-cycles";
import { query } from "@/server/db/pool";

export const dynamic = "force-dynamic";
export const metadata = { title: "Coverage cycles" };

/**
 * How each service is covered, expressed as a cycle rather than a week.
 *
 * The reason this screen exists at all is that the real schedules do not fit a
 * week: days off rotate. MICU is off Saturday; VA general medicine is off
 * Wednesday one week and Saturday the next; nights are off Monday and Saturday,
 * then Thursday. A weekday/weekend table can express none of that, and a
 * fourteen-day cycle expresses all of it.
 *
 * So the page shows each cycle as the sequence it is, day by day, and lets
 * somebody suspend one over a range with a reason — the winter holiday block
 * being the case every programme has.
 */
export default async function CyclesPage() {
  const context = await requirePageCapability("scheduling.plan");

  const patterns = await listRotationPatterns(context.program.id);
  const exceptions = await listAllExceptions(context.program.id);

  const serviceNames = new Map(
    (
      await query<{ id: string; name: string }>(
        "SELECT id, name FROM services WHERE program_id = $1",
        [context.program.id],
      )
    ).map((row) => [row.id, row.name]),
  );

  const year = new Date().getUTCMonth() >= 5
    ? new Date().getUTCFullYear()
    : new Date().getUTCFullYear() - 1;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Coverage cycles</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          {patterns.length === 0
            ? "No cycles yet. Set up services first — a starting configuration brings its cycles with it."
            : `${patterns.length} cycle${patterns.length === 1 ? "" : "s"}. A cycle is a length and an ordered list of days, which is what a rotating day off actually is — a week is one shape of a cycle, not the model.`}
        </p>
      </header>

      {patterns.length === 0 ? (
        <EmptyState
          title="Nothing to show yet"
          description="Cycles arrive with a starting configuration, or you can create them per service."
        />
      ) : (
        <Card>
          <CardBody className="space-y-4">
            {patterns.map((pattern) => (
              <div
                key={pattern.id}
                className="border-b border-border-base pb-4 last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {pattern.service_id
                        ? `${serviceNames.get(pattern.service_id) ?? ""} · `
                        : ""}
                      {pattern.name}
                    </p>
                    <p className="text-sm text-ink-muted">
                      {pattern.cycle_days}-day cycle, starting{" "}
                      {pattern.anchor_date.toISOString().slice(0, 10)}
                    </p>
                  </div>
                  {pattern.provenance === "assumed" ? (
                    <Badge tone="caution">Our guess</Badge>
                  ) : pattern.provenance === "confirmed" ? (
                    <Badge tone="positive">Confirmed</Badge>
                  ) : (
                    <Badge tone="neutral">From your document</Badge>
                  )}
                </div>

                {/* The sequence itself, because "q3 call" means nothing to
                    somebody who has not seen it written out and everything to
                    somebody who has. */}
                <ol className="mt-2 flex flex-wrap gap-1">
                  {pattern.states.map((state, index) => (
                    <li
                      key={index}
                      className="rounded-lg bg-surface-muted px-2 py-1 text-xs font-medium text-ink-muted"
                    >
                      {ROTATION_STATE_LABEL[state]}
                    </li>
                  ))}
                </ol>

                {pattern.notes ? (
                  <p className="mt-2 text-sm text-ink-subtle">{pattern.notes}</p>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <CycleOverrides
        cycles={patterns.map((pattern) => ({
          id: pattern.id,
          name: pattern.name,
          serviceName: pattern.service_id
            ? (serviceNames.get(pattern.service_id) ?? null)
            : null,
          cycleDays: pattern.cycle_days,
          provenance: pattern.provenance,
        }))}
        overrides={exceptions.map((exception) => ({
          id: exception.id,
          startsOn: exception.starts_on.toISOString().slice(0, 10),
          endsOn: exception.ends_on.toISOString().slice(0, 10),
          reason: exception.reason,
          appliesTo:
            exception.pattern_name ??
            exception.service_name ??
            exception.resident_name ??
            "the whole program",
          replaces:
            exception.replacement_states && exception.replacement_states.length > 0
              ? exception.replacement_states
                  .map((state) => ROTATION_STATE_LABEL[state])
                  .join(", ")
              : "nothing — decided elsewhere",
        }))}
        holidayPreset={winterHolidayRange(year)}
      />
    </div>
  );
}
