import type { ShiftDetail, ShiftProvenance } from "@/server/db/types";

export type { ShiftProvenance };
import { dayLabel, fmtDate, fmtDateLong, fmtDuration, fmtRange } from "./format";

/**
 * How a shift's origin reads on a screen, to both parties, before either of
 * them agrees to anything.
 *
 * Short enough to sit next to a date on a phone. It says who is vouching, not
 * how the row was created — "the resident entered this" and "the program
 * confirmed this" are the two facts somebody deciding on a switch wants.
 *
 * Here rather than beside the domain code that sets it, because a client
 * component renders it and must not pull the database pool into the browser
 * bundle to find out what a word means.
 */
export const PROVENANCE_LABEL: Record<ShiftProvenance, string> = {
  provisional: "Not confirmed yet",
  self_reported: "Entered by the resident",
  imported: "From the program's schedule",
  confirmed: "Confirmed by the program",
};

/** The same fact, for the person whose own shift it is. */
export const PROVENANCE_LABEL_OWN: Record<ShiftProvenance, string> = {
  provisional: "Not confirmed yet",
  self_reported: "You entered this",
  imported: "From your program's schedule",
  confirmed: "Confirmed by your program",
};

/**
 * Serialisable projections passed from server components to client components.
 * Formatting happens once, on the server, in the program timezone.
 */
export interface ShiftView {
  id: string;
  date: string;
  dateLabel: string;
  dayLabel: string;
  dateLong: string;
  timeRange: string;
  duration: string;
  startIso: string;
  endIso: string;
  /* Wall-clock values in the program timezone, so an editor can show and patch
     exactly what the schedule says rather than reverse-engineering a label. */
  startTime: string;
  endTime: string;
  endsNextDay: boolean;
  serviceId: string;
  serviceName: string;
  rotationName: string | null;
  shiftType: string;
  location: string;
  status: string;
  tradeable: boolean;
  approvalRequired: boolean;
  requiredPgyMin: number;
  requiredPgyMax: number;
  residentId: string | null;
  residentName: string | null;
  residentPgy: number | null;
  /* Where this shift came from. Carried on every view because both sides of a
     switch see it before either agrees — a resident taking somebody's Saturday
     is entitled to know whether the program confirmed those hours or the person
     typed them in. */
  provenance: ShiftProvenance;
  provenanceLabel: string;
}

function wallClock(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

function localDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function toShiftView(shift: ShiftDetail, timezone: string): ShiftView {
  const start = shift.start_datetime;
  const end = shift.end_datetime;
  return {
    id: shift.id,
    date: typeof shift.date === "string" ? shift.date : String(shift.date),
    dateLabel: fmtDate(start, timezone),
    dayLabel: dayLabel(start, timezone),
    dateLong: fmtDateLong(start, timezone),
    timeRange: fmtRange(start, end, timezone),
    duration: fmtDuration(start, end),
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startTime: wallClock(start, timezone),
    endTime: wallClock(end, timezone),
    endsNextDay: localDate(start, timezone) !== localDate(end, timezone),
    serviceId: shift.service_id,
    serviceName: shift.service_name,
    rotationName: shift.rotation_name,
    shiftType: shift.shift_type,
    location: shift.location,
    status: shift.status,
    tradeable: shift.tradeable,
    approvalRequired: shift.approval_required,
    requiredPgyMin: shift.required_pgy_min,
    requiredPgyMax: shift.required_pgy_max,
    residentId: shift.resident_id,
    residentName: shift.resident_name,
    residentPgy: shift.resident_pgy,
    provenance: shift.provenance,
    provenanceLabel: PROVENANCE_LABEL[shift.provenance],
  };
}
