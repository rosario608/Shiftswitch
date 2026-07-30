import { assertOwnResidentOrElevated, requireUser } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { forbidden } from "@/server/http/errors";
import { listResidentSchedule } from "@/server/domain/schedule";

export const dynamic = "force-dynamic";

/**
 * A resident's schedule. Without `residentId` it returns the caller's own
 * schedule; with one it is only served to the owner, a chief, or an admin.
 */
export const GET = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const url = new URL(request.url);
  const requested = url.searchParams.get("residentId");
  const residentId = requested ?? context.resident?.id;
  if (!residentId) {
    throw forbidden("Your account does not have a resident schedule.");
  }
  assertOwnResidentOrElevated(context, residentId);
  const shifts = await listResidentSchedule(residentId, {
    includePast: url.searchParams.get("includePast") === "true",
    limit: Number(url.searchParams.get("limit") ?? 100),
  });
  return ok({ shifts, timezone: context.program.timezone });
});
