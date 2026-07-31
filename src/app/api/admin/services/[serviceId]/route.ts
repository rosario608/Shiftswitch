import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson, requireUuid } from "@/server/http/api";
import { updateService, type ServiceKind } from "@/server/domain/services";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  kind: z.enum(["service", "rotation"]).default("service"),
  name: z.string().min(1).max(120).optional(),
  abbreviation: z.string().max(16).optional(),
  tradeable: z.boolean().optional(),
  active: z.boolean().optional(),
});

/**
 * There is no DELETE. Shifts reference services with ON DELETE RESTRICT, so a
 * service that has ever been used cannot be removed without taking a schedule
 * with it. Deactivating keeps the history and stops it appearing in new work,
 * which is what "remove this service" actually means to a program.
 */
export const PATCH = apiHandler(
  async (request: Request, ctx: { params: Promise<{ serviceId: string }> }) => {
    const context = await requireCapability("services.manage");
    const { serviceId: raw } = await ctx.params;
    const id = requireUuid(raw, "service");
    const input = await parseJson(request, patchSchema);
    const record = await updateService(context, input.kind as ServiceKind, id, {
      name: input.name,
      abbreviation: input.abbreviation,
      tradeable: input.tradeable,
      active: input.active,
    });
    return ok({ record });
  },
);
