import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { createService, listServices, type ServiceKind } from "@/server/domain/services";

export const dynamic = "force-dynamic";

const kindSchema = z.enum(["service", "rotation"]).default("service");

const createSchema = z.object({
  kind: kindSchema,
  name: z.string().min(1).max(120),
  abbreviation: z.string().max(16).optional(),
  tradeable: z.boolean().optional(),
});

/** Both lists in one response: the screen shows them together. */
export const GET = apiHandler(async () => {
  const context = await requireCapability("services.manage");
  const [services, rotations] = await Promise.all([
    listServices(context.program.id, "service"),
    listServices(context.program.id, "rotation"),
  ]);
  return ok({ services, rotations });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("services.manage");
  const input = await parseJson(request, createSchema);
  const record = await createService(context, input.kind as ServiceKind, {
    name: input.name,
    abbreviation: input.abbreviation,
    tradeable: input.tradeable,
  });
  return ok({ record }, { status: 201 });
});
