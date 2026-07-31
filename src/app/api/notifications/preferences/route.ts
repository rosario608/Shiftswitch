import { z } from "zod";
import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import {
  CATEGORY_LABELS,
  getNotificationPreferences,
  setNotificationPreference,
} from "@/server/domain/push";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireUser();
  const preferences = await getNotificationPreferences(context.user.id);
  return ok({ preferences, labels: CATEGORY_LABELS });
});

const patchSchema = z.object({
  category: z.enum(["offers", "approvals", "schedule", "switches"]),
  push: z.boolean().optional(),
  inApp: z.boolean().optional(),
});

export const PATCH = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const input = await parseJson(request, patchSchema);
  await setNotificationPreference(context.user.id, input.category, {
    push: input.push,
    inApp: input.inApp,
  });
  const preferences = await getNotificationPreferences(context.user.id);
  return ok({ preferences });
});
