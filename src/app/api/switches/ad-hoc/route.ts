import { requireResident } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { adHocPostSchema } from "@/lib/schemas";
import { postAdHocShift } from "@/server/domain/ad-hoc";

export const dynamic = "force-dynamic";

/**
 * Naming a shift and posting it, for a resident whose programme has nothing
 * set up yet.
 *
 * Separate from `POST /api/switches` because the input is genuinely different
 * — there is no shift id to send, since the shift does not exist until this
 * call — and folding the two into one endpoint with half its fields optional
 * would make the ordinary post harder to read for the sake of saving a file.
 */
export const POST = apiHandler(async (request: Request) => {
  const context = await requireResident();
  const input = await parseJson(request, adHocPostSchema);
  const result = await postAdHocShift(context, input);
  return ok(
    {
      tradeRequest: result.tradeRequest,
      shift: result.shift,
      alreadyHadIt: result.alreadyHadIt,
    },
    { status: 201 },
  );
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
