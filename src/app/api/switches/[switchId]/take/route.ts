import { z } from "zod";
import { requireResident } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { previewTake, takeShift } from "@/server/domain/giveaway";

export const dynamic = "force-dynamic";

/**
 * Picking up a shift somebody is giving away.
 *
 * `GET` is what the resident is taking on; `POST` is them taking it. Two
 * calls rather than one, because the warnings have to be on screen *before*
 * the button that accepts them — a single endpoint that returned the warnings
 * and performed the take would either show them too late or trust the client
 * to have shown them at all.
 */
export const GET = apiHandler(
  async (_request: Request, { params }: { params: Promise<{ switchId: string }> }) => {
    const context = await requireResident();
    const { switchId } = await params;
    return ok(await previewTake(context, switchId));
  },
);

const takeSchema = z.object({
  /* The keys of the warnings the resident read and accepted. Checked against
     what the server computes inside the same transaction, so this is a record
     of what they were shown rather than a claim they get to make. */
  acknowledgedWarnings: z.array(z.string()).default([]),
});

export const POST = apiHandler(
  async (request: Request, { params }: { params: Promise<{ switchId: string }> }) => {
    const context = await requireResident();
    const { switchId } = await params;
    const input = await parseJson(request, takeSchema);
    return ok(await takeShift(context, switchId, input));
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
