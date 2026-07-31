import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import {
  diffScheduleVersion,
  discardScheduleVersion,
  publishScheduleVersion,
} from "@/server/domain/schedule-versions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ versionId: string }> };

const actionSchema = z.object({
  action: z.enum(["publish", "diff"]),
  /** Publishing over live switches is deliberate and audited, never a default. */
  force: z.boolean().optional(),
});

export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  const diff = await diffScheduleVersion(
    context.program.id,
    versionId,
    context.program.timezone,
  );
  return ok({ diff });
});

export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  const input = await parseJson(request, actionSchema);

  if (input.action === "diff") {
    const diff = await diffScheduleVersion(
      context.program.id,
      versionId,
      context.program.timezone,
    );
    return ok({ diff });
  }

  const result = await publishScheduleVersion(context, versionId, { force: input.force });
  return ok(result);
});

export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  await discardScheduleVersion(context, versionId);
  return ok({ discarded: true });
});
