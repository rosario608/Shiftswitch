import { resolveCalendarFeed } from "@/server/domain/account";
import { buildCalendar } from "@/server/domain/calendar";
import { getResidentInfo, listResidentSchedule } from "@/server/domain/schedule";
import { getProgram } from "@/server/domain/trade-context";
import { apiHandler } from "@/server/http/api";

export const dynamic = "force-dynamic";

/**
 * Public iCalendar feed. The unguessable token in the path is the credential —
 * it is stored hashed, can be rotated from the app, and grants read-only access
 * to one resident's own shifts and nothing else.
 */
export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ token: string }> }) => {
    const { token: raw } = await ctx.params;
    const token = raw.replace(/\.ics$/i, "");
    const feed = await resolveCalendarFeed(token);
    if (!feed) {
      return new Response("Calendar not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }

    const [program, resident] = await Promise.all([
      getProgram(feed.programId),
      getResidentInfo(feed.residentId),
    ]);
    const shifts = await listResidentSchedule(feed.residentId, {
      from: new Date(Date.now() - 60 * 86_400_000),
      limit: 500,
    });

    const body = buildCalendar(shifts, {
      programName: program.name,
      residentName: resident?.name ?? "Resident",
      timezone: program.timezone,
      appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
      reminderMinutes: 60,
    });

    return new Response(body, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "cache-control": "private, max-age=300",
        "content-disposition": 'inline; filename="shiftswitch.ics"',
      },
    });
  },
);
