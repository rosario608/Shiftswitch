import { isPending, requireResident, requireUser } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { postShiftSchema } from "@/lib/schemas";
import { listAvailableTrades, postShiftForTrade } from "@/server/domain/trades";

export const dynamic = "force-dynamic";

/** Shifts you can take in the caller's program (excluding their own posts). */
export const GET = apiHandler(async (request: Request) => {
  const context = await requireUser();
  /* The board page refuses an unconfirmed account and this did not, so the
     restriction held only for somebody using the web interface — the native
     client and anything else calling the API got the whole programme's
     postings, with names. The rule belongs on the data, not on one screen. */
  if (isPending(context)) return ok({ trades: [] });
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const trades = await listAvailableTrades(
    context.program.id,
    context.resident?.id ?? null,
    { limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0 },
  );
  return ok({ trades });
});

/** Post one of the caller's own shifts for trade. */
export const POST = apiHandler(async (request: Request) => {
  const context = await requireResident();
  const input = await parseJson(request, postShiftSchema);
  const tradeRequest = await postShiftForTrade(context, {
    shiftId: input.shiftId,
    notes: input.notes,
    preferences: input.preferences,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    kind: input.kind,
  });
  return ok({ tradeRequest }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
