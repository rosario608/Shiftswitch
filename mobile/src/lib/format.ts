/**
 * Formatting, always in the program's timezone.
 *
 * A resident travelling, or a phone left on a hospital-network timezone, must
 * never be shown a shift an hour out. Every function here takes the timezone
 * explicitly rather than falling back to the device's — a shift that starts at
 * 07:00 in the program's zone reads "7:00 AM" wherever the phone is.
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  cache.set(key, created);
  return created;
}

export function formatDate(iso: string, timeZone: string): string {
  return formatter(timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

export function formatLongDate(iso: string, timeZone: string): string {
  return formatter(timeZone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone: string): string {
  return formatter(timeZone, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "Tue, Mar 4 · 7:00 AM – 7:00 PM", with the overnight case made explicit. */
export function formatShiftWindow(
  startIso: string,
  endIso: string,
  timeZone: string,
): string {
  const startDay = formatDate(startIso, timeZone);
  const endDay = formatDate(endIso, timeZone);
  const window = `${formatTime(startIso, timeZone)} – ${formatTime(endIso, timeZone)}`;
  return startDay === endDay
    ? `${startDay} · ${window}`
    : `${startDay} · ${formatTime(startIso, timeZone)} – ${endDay} ${formatTime(endIso, timeZone)}`;
}

export function isOvernight(
  startIso: string,
  endIso: string,
  timeZone: string,
): boolean {
  return formatDate(startIso, timeZone) !== formatDate(endIso, timeZone);
}

/** "in 3 days", "in 2 hours", "12 minutes ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "";
  const deltaSeconds = Math.round((target - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

  if (absolute < 60) return relative.format(deltaSeconds, "second");
  if (absolute < 3600) {
    return relative.format(Math.round(deltaSeconds / 60), "minute");
  }
  if (absolute < 86_400) {
    return relative.format(Math.round(deltaSeconds / 3600), "hour");
  }
  return relative.format(Math.round(deltaSeconds / 86_400), "day");
}

export function pluralise(count: number, singular: string, plural?: string) {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  offer_pending: "Offers received",
  accepted: "Accepted",
  pending_approval: "Awaiting approval",
  approved: "Approved",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
  scheduled: "Scheduled",
  posted: "Posted to switch",
  pending: "Pending",
  rejected: "Declined",
  withdrawn: "Withdrawn",
  invalidated: "No longer valid",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}
