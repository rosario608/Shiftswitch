import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { listUnmatched } from "@/server/domain/held-rows";

export const dynamic = "force-dynamic";

/** Whose shifts are waiting for them to sign in. */
export const GET = apiHandler(async () => {
  const context = await requireCapability("schedule.manage");
  return ok({ unmatched: await listUnmatched(context.program.id) });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
