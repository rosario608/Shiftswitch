import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { notFound } from "@/server/http/errors";
import { assistedRowReviewSchema } from "@/lib/schemas";
import { loadExtraction, reviewRow } from "@/server/domain/assisted-import/store";

export const dynamic = "force-dynamic";

/** The proposal, flagged rows first, for the reviewer to work through. */
export const GET = apiHandler(
  async (_request: Request, route: { params: Promise<{ id: string }> }) => {
    const context = await requireCapability("schedule.manage");
    const { id } = await route.params;
    const extraction = await loadExtraction(context.program.id, id);
    if (!extraction) throw notFound("That upload is not in this program.");
    return ok({ extraction });
  },
);

/**
 * A reviewer working one row: correcting it, or confirming it as it stands.
 *
 * Both are `PATCH` on the row, and both record that it was looked at. Sending
 * no `correction` means "I read this against the file and it is right", which
 * is a real answer and the commonest one — the alternative, making them retype
 * a correct row to clear the flag, would teach them to retype without reading.
 */
export const PATCH = apiHandler(
  async (request: Request, route: { params: Promise<{ id: string }> }) => {
    const context = await requireCapability("schedule.manage");
    const { id } = await route.params;
    const input = await parseJson(request, assistedRowReviewSchema);
    const row = await reviewRow(context, id, input.rowId, input.correction ?? null);
    return ok({ row });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
