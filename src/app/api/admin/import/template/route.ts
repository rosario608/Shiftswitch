import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight } from "@/server/http/api";

export const dynamic = "force-dynamic";

/**
 * The downloadable schedule template.
 *
 * Generated rather than checked in as a static file so the example dates are
 * always in the near future — a template full of last year's dates invites an
 * administrator to import a schedule that is already in the past, and every row
 * would then be rejected for a reason that looks like a bug.
 *
 * The columns are the interchange format — Resident, PGY, Date, Start, End,
 * Service, Rotation, Shift type, Location, Status — and `parseScheduleFile`
 * also accepts the aliases other systems export (Email, Start time, Overnight,
 * Type…), so a file exported from somewhere else usually imports without being
 * rewritten.
 *
 * The example rows name people by name rather than by address, because that is
 * what a programme's own published schedule looks like and it now imports:
 * rows for people who have not joined are held and attached when they do.
 *
 * Wrapped in `apiHandler` like every other route even though it returns CSV
 * rather than JSON: without it the guard's `forbidden` would escape as an
 * unhandled exception and a resident poking at this URL would get a 500.
 */
export const GET = apiHandler(async (): Promise<Response> => {
  const context = await requireCapability("schedule.manage");

  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  // Four example rows: a day shift, an overnight one, a row with the optional
  // columns left blank — the case people most often get wrong — and a row
  // identified by name alone, which is how most published schedules read.
  const rows = [
    "Resident,PGY,Date,Start,End,Service,Rotation,Shift type,Location,Status",
    `Alex Rivera,2,${day(7)},07:00,19:00,MICU,Critical Care,day,ICU Tower 4,confirmed`,
    `Sam Okafor,3,${day(7)},19:00,07:00,MICU,Critical Care,night,ICU Tower 4,confirmed`,
    `Alex Rivera,2,${day(8)},08:00,17:00,Wards,,,,`,
    `Jordan Blake,1,${day(9)},07:00,19:00,MICU,Critical Care,day,ICU Tower 4,draft`,
  ];

  return new Response(`${rows.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        'attachment; filename="shiftswitch-schedule-template.csv"',
      "cache-control": "no-store",
      // Informational, but it saves a support question: the response records
      // the timezone the times in this file will be interpreted in.
      "x-shiftswitch-timezone": context.program.timezone,
    },
  });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
