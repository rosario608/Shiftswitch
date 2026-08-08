import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { loadWorkspace } from "@/server/domain/schedule-workspace";

export const dynamic = "force-dynamic";

/**
 * The whole working surface in one payload.
 *
 * A POST because it is not free — it loads the window, runs every constraint
 * over it and expands every coverage cell — and because the client sends a
 * period and a version rather than fetching a fixed page.
 */
const requestSchema = z.object({
  /** Omitted looks at the live schedule from today onwards. */
  versionId: z.string().uuid().nullable().optional(),
  periodStart: z.string().date().optional(),
  periodEnd: z.string().date().optional(),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("scheduling.plan");
  const input = await parseJson(request, requestSchema);

  const workspace = await loadWorkspace(context, {
    versionId: input.versionId ?? null,
    period:
      input.periodStart && input.periodEnd
        ? { start: input.periodStart, end: input.periodEnd }
        : undefined,
  });

  return ok({ workspace });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
