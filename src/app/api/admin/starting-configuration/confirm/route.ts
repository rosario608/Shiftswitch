import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { confirmDefault } from "@/server/domain/starting-configuration";

export const dynamic = "force-dynamic";

/**
 * Vouching for a default that shipped as a guess.
 *
 * The only thing that turns an ASSUMED default into one the importer will fill
 * a blank Start from. Until this happens the guess is inert, which is the point:
 * the wrongest schedule is the confident one, and three hundred shifts built
 * from an hour this software invented would look exactly as authoritative as
 * three hundred from the program's own file.
 */
const confirmSchema = z.object({
  kind: z.enum(["position", "cycle"]),
  id: z.string().uuid(),
  defaultStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  defaultMinutes: z.number().int().min(30).max(1800).optional(),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("services.manage");
  const input = await parseJson(request, confirmSchema);
  await confirmDefault(context, input.kind, input.id, {
    defaultStart: input.defaultStart,
    defaultMinutes: input.defaultMinutes,
  });
  return ok({ confirmed: input.id });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
