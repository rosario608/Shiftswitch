import { resolveCalendarFeed } from "@/server/domain/account";
import { buildCalendar } from "@/server/domain/calendar";
import {
  getResidentInfo,
  listReleasedShifts,
  listResidentSchedule,
} from "@/server/domain/schedule";
import { getProgram } from "@/server/domain/trade-context";
import { apiHandler } from "@/server/http/api";

export const dynamic = "force-dynamic";

/**
 * Public iCalendar feed. The unguessable token in the path is the credential —
 * it is stored hashed, can be rotated from the app, and grants read-only access
 * to one resident's own shifts and nothing else.
 *
 * ## How far back it reaches
 *
 * Sixty days. The window is not about what a resident wants to see — a
 * calendar keeps whatever it has already been given — but about what still
 * needs *correcting*. A shift that ended two months ago cannot be switched,
 * so nothing about it can change, so republishing it achieves nothing. The
 * same window bounds the cancellations below, which is what keeps the feed a
 * fixed size instead of one that grows for every switch a resident ever makes.
 */
const LOOKBACK_DAYS = 60;

/**
 * Sent on both answers, so the 404 is not distinguishable by its headers.
 *
 * The URL *is* the credential, which makes this the one route in the product
 * where the address a resident pastes somewhere is worth as much as their
 * session. `noindex` covers the case that actually happens: a link forwarded
 * into a wiki, a shared document, or a support ticket that a crawler can
 * reach. Nothing here can stop a leaked link being used — rotation is what
 * does that, and the profile page offers it — but nothing should help.
 */
const PRIVATE_HEADERS = {
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
} as const;
export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ token: string }> }) => {
    const { token: raw } = await ctx.params;
    const token = raw.replace(/\.ics$/i, "");
    const feed = await resolveCalendarFeed(token);
    if (!feed) {
      /* Says nothing about why. A revoked token, a rotated one and a token
         that never existed are one answer, because distinguishing them tells
         somebody holding a guess whether they were close. */
      return new Response("Calendar not found", {
        status: 404,
        headers: { "content-type": "text/plain", ...PRIVATE_HEADERS },
      });
    }

    const from = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
    const [program, resident] = await Promise.all([
      getProgram(feed.programId),
      getResidentInfo(feed.residentId),
    ]);
    const [shifts, released] = await Promise.all([
      listResidentSchedule(feed.residentId, { from, limit: 500 }),
      listReleasedShifts(feed.residentId, { from }),
    ]);

    const body = buildCalendar(shifts, {
      programName: program.name,
      residentName: resident?.name ?? "Resident",
      timezone: program.timezone,
      appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
      reminderMinutes: 60,
      released,
    });

    return new Response(body, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        /* Five minutes. Long enough that a calendar app polling aggressively
           does not hit the database every time, short enough that a switch
           completed now is visible on the next poll rather than the one
           after. `private` keeps it out of any shared cache — the URL carries
           the credential, so a proxy holding the response holds the
           schedule. */
        "cache-control": "private, max-age=300",
        "content-disposition": 'inline; filename="shiftswitch.ics"',
        ...PRIVATE_HEADERS,
      },
    });
  },
);
