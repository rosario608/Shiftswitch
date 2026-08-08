import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { shiftCorrectionSchema } from "@/lib/schemas";
import { correctOwnShift } from "@/server/domain/self-report";

export const dynamic = "force-dynamic";

/**
 * Fixing the hours on a shift you hold. The domain refuses one you do not,
 * with the same message it gives for a shift that does not exist — somebody
 * probing ids should not learn which of them are real.
 */
export const POST = apiHandler(
  async (request: Request, context: { params: Promise<{ shiftId: string }> }) => {
    const authed = await requireCapability("shifts.self_report");
    const { shiftId } = await context.params;
    const input = await parseJson(request, shiftCorrectionSchema);
    const shift = await correctOwnShift(authed, shiftId, input);
    return ok({ shift });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
