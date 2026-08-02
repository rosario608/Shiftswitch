import { z } from "zod";
import { getSessionContext } from "@/server/auth/session";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { unauthenticated } from "@/server/http/errors";
import { registerDevice, unregisterDevice } from "@/server/domain/push";

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  installId: z.string().min(8).max(128),
  platform: z.enum(["ios", "android", "web"]),
  pushToken: z.string().min(10).max(4096).nullable().optional(),
  /* A browser subscription's two keys. Base64url, and short — the sizes are
     fixed by the spec, so a generous bound still refuses anything that is not
     one of these. */
  pushKeys: z
    .object({
      p256dh: z.string().min(20).max(255),
      auth: z.string().min(8).max(255),
    })
    .nullable()
    .optional(),
  appVersion: z.string().max(40).optional(),
  osVersion: z.string().max(60).optional(),
  model: z.string().max(80).optional(),
});

/**
 * Registers this installation for push. Deliberately available to any signed-in
 * account, configured or not, so a pending user still receives the notification
 * that their account has been set up.
 */
export const POST = apiHandler(async (request: Request) => {
  const context = await getSessionContext();
  if (!context) throw unauthenticated();
  const input = await parseJson(request, registerSchema);
  const device = await registerDevice(context.user.id, input);
  return ok({ deviceId: device.id });
});

export const DELETE = apiHandler(async (request: Request) => {
  const context = await getSessionContext();
  if (!context) throw unauthenticated();
  const installId = new URL(request.url).searchParams.get("installId");
  if (installId) await unregisterDevice(context.user.id, installId);
  return ok({ unregistered: true });
});
