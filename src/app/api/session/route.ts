import { getSessionContext } from "@/server/auth/session";
import { apiHandler, ok } from "@/server/http/api";

export const dynamic = "force-dynamic";

/** Lightweight session probe used by the offline banner and the client shell. */
export const GET = apiHandler(async () => {
  const context = await getSessionContext();
  if (!context) return ok({ authenticated: false });
  return ok({
    authenticated: true,
    configured: Boolean(context.user.role && context.user.programId),
    user: {
      id: context.user.id,
      email: context.user.email,
      fullName: context.user.fullName,
      role: context.user.role,
      pictureUrl: context.user.pictureUrl,
    },
    program: context.program
      ? {
          id: context.program.id,
          name: context.program.name,
          institution: context.program.institution,
          timezone: context.program.timezone,
        }
      : null,
    residentId: context.resident?.id ?? null,
  });
});
