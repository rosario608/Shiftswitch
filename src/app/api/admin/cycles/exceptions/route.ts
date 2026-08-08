import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import {
  createPatternException,
  listAllExceptions,
  ROTATION_STATES,
} from "@/server/domain/rotation-cycles";

export const dynamic = "force-dynamic";

/**
 * Overrides on a rotation cycle: a date range, what applies instead, and why.
 *
 * `scheduling.plan` rather than `services.manage` — this is the shape of the
 * programme's year, which belongs to whoever builds the schedule, and in most
 * programmes that is a chief resident rather than the PD.
 */
export const GET = apiHandler(async () => {
  const context = await requireCapability("scheduling.plan");
  return ok({ exceptions: await listAllExceptions(context.program.id) });
});

const createSchema = z.object({
  patternId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  residentId: z.string().uuid().nullable().optional(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /* Empty means "nothing applies here" — the holiday roster, decided elsewhere.
     Deliberately distinct from a cycle of `off`: "nobody has said" and "this
     person is off" are different facts and only one is safe to schedule
     against. */
  replacementStates: z.array(z.enum(ROTATION_STATES as unknown as [string, ...string[]])).max(366).optional(),
  reason: z.string().min(3).max(300),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("scheduling.plan");
  const input = await parseJson(request, createSchema);
  const exception = await createPatternException(
    {
      programId: context.program.id,
      patternId: input.patternId ?? null,
      serviceId: input.serviceId ?? null,
      residentId: input.residentId ?? null,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      replacementStates: (input.replacementStates ?? []) as never,
      reason: input.reason,
    },
    context.user.id,
  );
  return ok({ exception }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
