import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { confirmShift } from "@/server/domain/self-report";

export const dynamic = "force-dynamic";

/**
 * Vouching for a shift, which is a statement to everybody else that the program
 * has checked it. Never a resident's about their own — that is the entire point
 * of it being a separate capability from correcting one.
 */
export const POST = apiHandler(
  async (_request: Request, context: { params: Promise<{ shiftId: string }> }) => {
    const authed = await requireCapability("shifts.confirm");
    const { shiftId } = await context.params;
    const shift = await confirmShift(authed, shiftId);
    return ok({ shift });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
