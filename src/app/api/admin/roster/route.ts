import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { listRoster } from "@/server/domain/roster";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const context = await requireCapability("scheduling.plan");
  // `listRoster` omits the phone column entirely unless the caller holds
  // `residents.contact_info`, so this response cannot leak it.
  const roster = await listRoster(context);
  return ok({ roster });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
