import { requireCapability } from "@/server/auth/guards";
import { apiHandler } from "@/server/http/api";

export const dynamic = "force-dynamic";

/**
 * The downloadable schedule template.
 *
 * Generated rather than checked in as a static file so the example dates are
 * always in the near future — a template full of last year's dates invites an
 * administrator to import a schedule that is already in the past, and every row
 * would then be rejected for a reason that looks like a bug.
 *
 * The column names here are the canonical ones. `parseScheduleFile` also
 * accepts common aliases (Name, Start, End, Overnight, Type…), so a file
 * exported from another system usually imports without being rewritten.
 *
 * Wrapped in `apiHandler` like every other route even though it returns CSV
 * rather than JSON: without it the guard's `forbidden` would escape as an
 * unhandled exception and a resident poking at this URL would get a 500.
 */
export const GET = apiHandler(async (): Promise<Response> => {
  const context = await requireCapability("schedule.manage");

  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  // Three example rows: a day shift, an overnight one, and a row with the
  // optional columns left blank — the case people most often get wrong.
  const rows = [
    "Email,Date,Start time,End time,Ends next day,Service,Rotation,Shift type,Location",
    `resident.one@example.org,${day(7)},07:00,19:00,no,MICU,Critical Care,day,ICU Tower 4`,
    `resident.two@example.org,${day(7)},19:00,07:00,yes,MICU,Critical Care,night,ICU Tower 4`,
    `resident.one@example.org,${day(8)},08:00,17:00,no,Wards,,,`,
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
