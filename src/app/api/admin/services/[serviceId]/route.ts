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
  /* Scheduling configuration. Every one optional, because the two screens that
     write here send different subsets: the services list edits the name and
     tradeability, the configuration screen edits the rest. */
  siteId: z.string().uuid().nullable().optional(),
  pgyMin: z.number().int().min(1).max(10).optional(),
  pgyMax: z.number().int().min(1).max(10).optional(),
  typicalShiftHours: z.number().min(0.5).max(48).nullable().optional(),
  coverageMandatory: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
  contactName: z.string().max(120).optional(),
  contactEmail: z.string().max(200).optional(),
  contactPhone: z.string().max(40).optional(),
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
      siteId: input.siteId,
      pgyMin: input.pgyMin,
      pgyMax: input.pgyMax,
      typicalShiftHours: input.typicalShiftHours,
      coverageMandatory: input.coverageMandatory,
      notes: input.notes,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
    });
    return ok({ record });
  },
);
