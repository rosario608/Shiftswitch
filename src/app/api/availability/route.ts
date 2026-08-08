import { z } from "zod";
import { requireUser } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { forbidden } from "@/server/http/errors";
import { ABSENCE_KINDS, createAbsence, listAbsences } from "@/server/domain/availability";

export const dynamic = "force-dynamic";

/**
 * Availability is the one scheduling surface a resident writes to.
 *
 * So the guard is `requireUser` and the narrowing happens below rather than a
 * capability on the route: a resident may see and record their own, and only
 * `scheduling.plan` widens that to the programme. Putting a capability on the
 * route would either lock residents out of recording their own leave or open
 * everybody's leave to everybody, and both are wrong.
 */

const createSchema = z.object({
  residentId: z.string().uuid().optional(),
  kind: z.enum(ABSENCE_KINDS),
  startDate: z.string().date(),
  endDate: z.string().date(),
  hard: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

export const GET = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const url = new URL(request.url);
  const manages = can(context.user.role, "scheduling.plan");
  const requested = url.searchParams.get("residentId");

  /* A resident sees their own, whatever they ask for. Not an error — asking
     for the roster's leave is a reasonable thing for a screen to do, and the
     answer is simply the part of it they are entitled to. */
  const residentId = manages ? (requested ?? undefined) : context.resident?.id;
  if (!manages && !residentId) {
    /* Somebody with no resident record and no scheduling capability: an APD who
       does not work clinically. There is nothing of theirs to show. */
    return ok({ absences: [] });
  }

  const absences = await listAbsences(context.program.id, {
    residentId,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  return ok({ absences });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireUser();
  const input = await parseJson(request, createSchema);
  const residentId = input.residentId ?? context.resident?.id;
  if (!residentId) {
    throw forbidden("You do not hold a schedule, so there is nothing to record.");
  }
  const absence = await createAbsence(context, { ...input, residentId });
  return ok({ absence }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
