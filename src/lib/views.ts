import type { ShiftDetail } from "@/server/db/types";
import { dayLabel, fmtDate, fmtDateLong, fmtDuration, fmtRange } from "./format";

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
  };
}
