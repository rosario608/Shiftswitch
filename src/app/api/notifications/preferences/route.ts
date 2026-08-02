import { z } from "zod";
import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import {
  getQuietHours,
  listPreferences,
  setPreference,
  setQuietHours,
} from "@/server/domain/notification-preferences";
import { NOTIFICATION_EVENTS } from "@/server/domain/notification-events";
import { can } from "@/server/auth/roles";
import type { NotificationType } from "@/server/domain/notifications";

export const dynamic = "force-dynamic";

/**
 * A resident sees the events that are theirs. Somebody who oversees coverage
 * also sees the oversight ones — decided by capability, never by a role
 * literal, because that is how the approvals queue came to notify nobody when
 * APD and PD were added.
 */
function visibleTo(role: Parameters<typeof can>[0]) {
  return can(role, "approvals.decide") ? ("all" as const) : ("resident" as const);
}

export const GET = apiHandler(async () => {
  const context = await requireUser();
  const [events, quietHours] = await Promise.all([
    listPreferences(context.user.id, visibleTo(context.user.role)),
    getQuietHours(context.user.id),
  ]);
  return ok({ events, quietHours });
});

const eventKeys = NOTIFICATION_EVENTS.map((event) => event.key) as [
  NotificationType,
  ...NotificationType[],
];

const patchSchema = z.union([
  z.object({
    event: z.enum(eventKeys),
    push: z.boolean().optional(),
    inApp: z.boolean().optional(),
    email: z.boolean().optional(),
  }),
  z.object({
    /* `null` clears them. A resident who has decided they want to be woken up
       has to be able to say so as plainly as they said the opposite. */
    quietHours: z
      .object({
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/),
      })
      .nullable(),
  }),
]);

export const PATCH = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const input = await parseJson(request, patchSchema);

  if ("quietHours" in input) {
    await setQuietHours(context.user.id, input.quietHours);
  } else {
    const spec = NOTIFICATION_EVENTS.find((event) => event.key === input.event);
    /* An oversight event is not a resident's to configure. Without this a
       resident could turn off the chief's "a switch needs your decision" on
       their own account — harmless in effect, since they never receive it, but
       it would put a switch on their settings screen that does nothing, which
       is exactly the class of defect this rewrite removes. */
    if (spec?.audience === "oversight" && !can(context.user.role, "approvals.decide")) {
      return ok({ events: await listPreferences(context.user.id, "resident") });
    }
    await setPreference(context.user.id, input.event, {
      push: input.push,
      inApp: input.inApp,
      email: input.email,
    });
  }

  const [events, quietHours] = await Promise.all([
    listPreferences(context.user.id, visibleTo(context.user.role)),
    getQuietHours(context.user.id),
  ]);
  return ok({ events, quietHours });
});
