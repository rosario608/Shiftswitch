import { localDateString } from "@/server/domain/time";
import type { ScheduleAssignment, ScheduleSnapshot } from "@/server/domain/constraints/types";
import type { ScheduleRecord } from "@/server/domain/schedule-sources/types";

/**
 * A generated schedule, expressed as the records every other source produces.
 *
 * This is what makes "generated" and "imported" the same kind of thing
 * downstream. The generator does not get its own write path, its own
 * validation, or its own duplicate handling — it produces the same flat rows a
 * coordinator's spreadsheet produces, and they go through `validateImport` and
 * `commitImport` like everything else.
 *
 * The alternative — a generator that inserts shifts directly — would mean two
 * ways into the schedule model, and the second one would be the one nobody
 * remembered to update when the first grew a rule.
 */
export function assignmentsToRecords(
  assignments: ScheduleAssignment[],
  snapshot: ScheduleSnapshot,
): ScheduleRecord[] {
  const zone = snapshot.program.timezone;
  const emailById = new Map(
    snapshot.residents.map((resident) => [resident.id, resident.email]),
  );

  return assignments
    .filter((assignment) => assignment.residentId)
    .map((assignment) => {
      const date = localDateString(assignment.start, zone);
      const endDate = localDateString(assignment.end, zone);
      return {
        Email: emailById.get(assignment.residentId!) ?? "",
        Date: date,
        "Start time": timeIn(assignment.start, zone),
        "End time": timeIn(assignment.end, zone),
        "Ends next day": endDate !== date ? "yes" : "no",
        Service: assignment.serviceName,
        Rotation: assignment.rotationName ?? "",
        "Shift type": assignment.shiftType,
        Location: assignment.location,
        PGY: "",
      };
    })
    /* Sorted so two runs producing the same schedule produce the same file,
       which is what makes a generated schedule diffable against an imported
       one. */
    .sort((a, b) =>
      `${a.Date}|${a["Start time"]}|${a.Service}|${a.Email}`.localeCompare(
        `${b.Date}|${b["Start time"]}|${b.Service}|${b.Email}`,
      ),
    );
}

function timeIn(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}
