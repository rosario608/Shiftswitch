import { z } from "zod";
import { requireCapability, requireUser } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { deleteAbsence, updateAbsence } from "@/server/domain/availability";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  /* Confirming a request — turning "I hope to go to this conference" into "the
     programme agrees you are away" — is the scheduler's decision, which is why
     PATCH is capability-guarded and DELETE is not. */
  hard: z.boolean().optional(),
  notes: z.string().max(500).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
});

export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { id } = await params;
  const input = await parseJson(request, patchSchema);
  const absence = await updateAbsence(context, id, input);
  return ok({ absence });
});

export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  /* A resident may withdraw a request of their own; the domain refuses to let
     them delete one the programme confirmed. */
  const context = await requireUser();
  const { id } = await params;
  await deleteAbsence(context, id);
  return ok({ deleted: true });
});
