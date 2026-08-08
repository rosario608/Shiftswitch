import { requireResident } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import {
  ensureCalendarFeed,
  hasCalendarFeed,
  revokeCalendarFeed,
  rotateCalendarFeed,
} from "@/server/domain/account";
import { recordAudit } from "@/server/domain/audit";

export const dynamic = "force-dynamic";

function feedUrl(token: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/calendar/${token}.ics`;
}

export const GET = apiHandler(async () => {
  const context = await requireResident();
  return ok({ active: await hasCalendarFeed(context.resident.id) });
});

/** Creates the subscription (or rotates it, invalidating the previous link). */
export const POST = apiHandler(async () => {
  const context = await requireResident();
  const existed = await hasCalendarFeed(context.resident.id);
  const token = existed
    ? await rotateCalendarFeed(context.resident.id)
    : await ensureCalendarFeed(context.resident.id);
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: existed ? "user.updated" : "user.created",
    entityType: "calendar_feed",
    entityId: context.resident.id,
    newState: { rotated: existed },
  });
  return ok({ url: feedUrl(token), rotated: existed });
});

export const DELETE = apiHandler(async () => {
  const context = await requireResident();
  await revokeCalendarFeed(context.resident.id);
  return ok({ active: false });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
