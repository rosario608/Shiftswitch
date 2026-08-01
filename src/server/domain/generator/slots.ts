import { effectiveMinimum, requirementsFor } from "@/server/domain/coverage";
import type { CoverageRequirement } from "@/server/domain/coverage";
import { datesInPeriod } from "@/server/domain/constraints/shared";
import type { ScheduleSnapshot } from "@/server/domain/constraints/types";
import { zonedWallTimeToInstant } from "@/server/domain/time";
import type { Slot } from "./types";

/**
 * Turning "what this programme needs" into "the holes to fill".
 *
 * Coverage requirements are the demand: *MICU needs two people on weekdays, one
 * of them a senior*. A slot is one of those people on one of those days. Three
 * people every weekday for four weeks is sixty slots, and the generator's job
 * is to put a name in each.
 *
 * Slots are derived, never stored. The requirement is the configuration; a slot
 * is what it means for a particular Tuesday, and recomputing it is cheaper than
 * keeping it in step with a requirement somebody edited.
 */

/** 07:00–19:00 unless the service or the requirement says otherwise. */
const DEFAULT_START = "07:00";
const DEFAULT_HOURS = 12;

function timesFor(
  requirement: CoverageRequirement,
  service: { typicalShiftHours?: number | null },
): { startTime: string; endTime: string; overnight: boolean } {
  if (requirement.start_time && requirement.end_time) {
    const startTime = requirement.start_time.slice(0, 5);
    const endTime = requirement.end_time.slice(0, 5);
    return { startTime, endTime, overnight: endTime <= startTime };
  }
  const hours = service.typicalShiftHours ?? DEFAULT_HOURS;
  const [h, m] = DEFAULT_START.split(":").map(Number);
  const endHour = (h + hours) % 24;
  const overnight = h + hours >= 24;
  return {
    startTime: DEFAULT_START,
    endTime: `${String(Math.floor(endHour)).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    overnight,
  };
}

function nextDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * How many people a requirement wants, and how many of them are pinned to a
 * training level.
 *
 * A requirement asking for three people, one of whom must be a PGY-3, produces
 * one slot demanding a PGY-3 and two demanding nobody in particular. Modelling
 * the mix as *slots* rather than as a check afterwards is what lets the
 * generator satisfy it by construction instead of discovering at the end that
 * it filled every place with interns.
 */
function slotShape(requirement: CoverageRequirement): Array<number | null> {
  const shape: Array<number | null> = [];
  for (const entry of requirement.pgy_mix) {
    for (let index = 0; index < entry.min; index += 1) shape.push(entry.pgy);
  }
  const total = effectiveMinimum(requirement);
  while (shape.length < total) shape.push(null);
  /* Levelled first, so the most constrained slots are offered to the generator
     before the open ones. Sorted by level for a stable order. */
  return shape.sort((a, b) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });
}

export function expandSlots(
  snapshot: ScheduleSnapshot,
  period: { start: string; end: string },
): Slot[] {
  const services = new Map(snapshot.services.map((s) => [s.id, s]));
  const active = snapshot.coverage.filter((r) => r.active);
  const slots: Slot[] = [];

  for (const iso of datesInPeriod(period)) {
    let noon: Date;
    try {
      noon = zonedWallTimeToInstant(iso, "12:00", snapshot.program.timezone);
    } catch {
      /* A local date that does not exist — the hour a spring-forward skips
         cannot be noon, so this never fires in practice, but a generator that
         throws on a calendar is a generator nobody runs in March. */
      continue;
    }

    for (const requirement of requirementsFor(active, noon, snapshot.program.timezone)) {
      const service = services.get(requirement.service_id);
      if (!service || !service.active) continue;

      const { startTime, endTime, overnight } = timesFor(requirement, service);

      let start: Date;
      let end: Date;
      try {
        start = zonedWallTimeToInstant(iso, startTime, snapshot.program.timezone);
        end = zonedWallTimeToInstant(
          overnight ? nextDay(iso) : iso,
          endTime,
          snapshot.program.timezone,
        );
      } catch {
        /* The clocks changed and this wall time does not exist tonight. Skipped
           rather than shifted: moving a shift by an hour without saying so is
           how somebody arrives to an empty ward. It is reported as an unfilled
           slot by the caller only if it was ever fillable, which it was not. */
        continue;
      }

      slotShape(requirement).forEach((requiredPgy, index) => {
        slots.push({
          /* Content-addressed. Two runs over the same programme produce the
             same slot ids, which is half of what makes the output comparable. */
          id: `${requirement.id}:${iso}:${index}`,
          serviceId: service.id,
          serviceName: service.name,
          siteId: service.siteId,
          requirementId: requirement.id,
          requirementLabel: requirement.label,
          date: iso,
          start,
          end,
          shiftType: overnight ? "night" : "day",
          requiredPgy,
          servicePgyMin: service.pgyMin,
          servicePgyMax: service.pgyMax,
        });
      });
    }
  }

  /* Sorted by date, then service, then slot index — a total order that does not
     depend on the order rows came back from the database. */
  return slots.sort((a, b) => a.id.localeCompare(b.id)).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.serviceName !== b.serviceName) {
      return a.serviceName < b.serviceName ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
}
