import { getPool, query, queryOne, type Queryable } from "@/server/db/pool";
import { instantToZonedParts } from "@/server/domain/time";
import type { NotificationType } from "./notifications";
import {
  NOTIFICATION_EVENTS,
  notificationEvent,
  UNCATALOGUED_DEFAULT,
  type NotificationEventSpec,
} from "./notification-events";

/**
 * Which channels a notification may actually use, decided on the server.
 *
 * ## Why the server and not the client
 *
 * Because "sent and hidden" is not a preference, it is a lie with extra steps.
 * A notification suppressed in the browser has still been written to the
 * database, still counted as unread, and still pushed to a phone. The only
 * version of "off" worth offering is one where nothing leaves.
 *
 * The in-app row was the specific offender: `notify()` inserted it
 * unconditionally, so the `in_app` column a resident could set on the
 * preferences screen did precisely nothing. It was stored, shown back to them
 * as if it had taken effect, and read by no code path at all.
 */

export interface ChannelChoice {
  push: boolean;
  inApp: boolean;
  email: boolean;
}

export interface ResolvedDelivery extends ChannelChoice {
  /** True when push was dropped because the resident is asleep. */
  heldForQuietHours: boolean;
}

interface PreferenceRow {
  category: string;
  push: boolean;
  in_app: boolean;
  email: boolean;
}

function defaultsFor(spec: NotificationEventSpec | undefined): ChannelChoice {
  return spec ? spec.defaults : UNCATALOGUED_DEFAULT;
}

/**
 * Whether `at` falls inside the user's quiet hours, in the programme's timezone.
 *
 * Handles the window that wraps midnight, which is the normal case — 22:00 to
 * 07:00 is what somebody means by quiet hours, and a naive `start <= t <= end`
 * comparison is false for every minute of it.
 */
export function withinQuietHours(
  start: string | null,
  end: string | null,
  at: Date,
  timezone: string,
): boolean {
  if (!start || !end) return false;
  const { hour, minute } = instantToZonedParts(at, timezone);
  const minutes = hour * 60 + minute;
  const toMinutes = (value: string) => {
    const [h, m] = value.split(":");
    return Number(h) * 60 + Number(m);
  };
  const from = toMinutes(start);
  const to = toMinutes(end);
  /* Equal start and end would be an empty window under one reading and a
     whole day under the other. Treated as empty: a resident who set both to
     the same time did not mean "never notify me again". */
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * The channels this notification may use for this user, right now.
 *
 * One query, because this runs once per recipient per notification and a trade
 * notifies several people inside a transaction.
 */
export async function resolveDelivery(
  userId: string,
  type: NotificationType,
  executor: Queryable = getPool(),
  at: Date = new Date(),
): Promise<ResolvedDelivery> {
  const spec = notificationEvent(type);
  const base = defaultsFor(spec);

  const row = await queryOne<{
    push: boolean | null;
    in_app: boolean | null;
    email: boolean | null;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    timezone: string;
  }>(
    `SELECT p.push, p.in_app, p.email,
            u.quiet_hours_start::text AS quiet_hours_start,
            u.quiet_hours_end::text   AS quiet_hours_end,
            pr.timezone
       FROM users u
       JOIN programs pr ON pr.id = u.program_id
       LEFT JOIN notification_preferences p
              ON p.user_id = u.id AND p.category = $2
      WHERE u.id = $1`,
    [userId, type],
    executor,
  );

  /* No user row is not a preference, it is a missing recipient. Nothing is
     sent, and the caller's insert would have failed anyway. */
  if (!row) return { push: false, inApp: false, email: false, heldForQuietHours: false };

  const chosen: ChannelChoice = {
    push: row.push ?? base.push,
    inApp: row.in_app ?? base.inApp,
    email: row.email ?? base.email,
  };

  const quiet =
    chosen.push &&
    !(spec?.urgent ?? true) &&
    withinQuietHours(row.quiet_hours_start, row.quiet_hours_end, at, row.timezone);

  return {
    push: chosen.push && !quiet,
    /* Quiet hours are about interrupting somebody, not about withholding.
       The in-app row is written either way, so a resident who wakes up and
       opens the app finds what happened overnight. */
    inApp: chosen.inApp,
    email: chosen.email,
    heldForQuietHours: quiet,
  };
}

export interface PreferenceView extends NotificationEventSpec {
  current: ChannelChoice;
  /** True when this resident has expressed a choice rather than inheriting one. */
  chosen: boolean;
}

/** The settings screen's whole model: every event, with what is set now. */
export async function listPreferences(
  userId: string,
  audience: NotificationEventSpec["audience"] | "all" = "all",
): Promise<PreferenceView[]> {
  const rows = await query<PreferenceRow>(
    "SELECT category, push, in_app, email FROM notification_preferences WHERE user_id = $1",
    [userId],
  );
  const byKey = new Map(rows.map((row) => [row.category, row]));
  return NOTIFICATION_EVENTS.filter(
    (event) => audience === "all" || event.audience === audience,
  ).map((event) => {
    const row = byKey.get(event.key);
    return {
      ...event,
      chosen: Boolean(row),
      current: row
        ? { push: row.push, inApp: row.in_app, email: row.email }
        : { ...event.defaults },
    };
  });
}

export async function setPreference(
  userId: string,
  key: NotificationType,
  values: Partial<ChannelChoice>,
): Promise<void> {
  const spec = notificationEvent(key);
  /* An unknown key would insert a row nothing ever reads, and the resident
     would see a switch that does nothing — which is the defect this module
     exists to remove, reintroduced through the front door. */
  if (!spec) throw new Error(`Unknown notification event: ${key}`);
  const base = spec.defaults;
  await query(
    `INSERT INTO notification_preferences (user_id, category, push, in_app, email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, category) DO UPDATE
        SET push = COALESCE($3, notification_preferences.push),
            in_app = COALESCE($4, notification_preferences.in_app),
            email = COALESCE($5, notification_preferences.email),
            updated_at = now()`,
    [
      userId,
      key,
      values.push ?? base.push,
      values.inApp ?? base.inApp,
      values.email ?? base.email,
    ],
  );
}

export async function setQuietHours(
  userId: string,
  hours: { start: string; end: string } | null,
): Promise<void> {
  await query(
    "UPDATE users SET quiet_hours_start = $2::time, quiet_hours_end = $3::time WHERE id = $1",
    [userId, hours?.start ?? null, hours?.end ?? null],
  );
}

export async function getQuietHours(
  userId: string,
): Promise<{ start: string; end: string } | null> {
  const row = await queryOne<{ start: string | null; end: string | null }>(
    `SELECT quiet_hours_start::text AS start, quiet_hours_end::text AS end
       FROM users WHERE id = $1`,
    [userId],
  );
  return row?.start && row.end ? { start: row.start, end: row.end } : null;
}
