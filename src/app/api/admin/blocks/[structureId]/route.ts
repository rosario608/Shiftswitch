import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { deleteBlockStructure, listBlocks } from "@/server/domain/blocks";
import {
  assignCohortToBlock,
  clearBlockAssignment,
  clearResidentOverride,
  listBlockAssignments,
  listResidentOverrides,
  setResidentOverride,
} from "@/server/domain/cohorts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ structureId: string }> };

const assignSchema = z.object({
  cohortId: z.string().uuid().optional(),
  residentId: z.string().uuid().optional(),
  blockId: z.string().uuid(),
  serviceId: z.string().uuid().nullable().optional(),
  rotationId: z.string().uuid().nullable().optional(),
  label: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  /** Required for a resident override — an override without one is a mystery. */
  reason: z.string().max(2000).optional(),
  clear: z.boolean().optional(),
});

export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { structureId } = await params;
  const [blocks, assignments, overrides] = await Promise.all([
    listBlocks(context.program.id, structureId),
    listBlockAssignments(context.program.id, structureId),
    listResidentOverrides(context.program.id, structureId),
  ]);
  return ok({ blocks, assignments, overrides });
});

export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  await params;
  const input = await parseJson(request, assignSchema);

  if (input.residentId && input.clear) {
    await clearResidentOverride(context, input.residentId, input.blockId);
    return ok({ updated: true });
  }

  if (input.residentId) {
    await setResidentOverride(context, {
      residentId: input.residentId,
      blockId: input.blockId,
      serviceId: input.serviceId,
      rotationId: input.rotationId,
      label: input.label,
      reason: input.reason ?? "",
    });
    return ok({ updated: true });
  }

  if (!input.cohortId) {
    return ok({ updated: false });
  }
  if (input.clear) {
    await clearBlockAssignment(context, input.cohortId, input.blockId);
    return ok({ updated: true });
  }
  await assignCohortToBlock(context, {
    cohortId: input.cohortId,
    blockId: input.blockId,
    serviceId: input.serviceId,
    rotationId: input.rotationId,
    label: input.label,
    notes: input.notes,
  });
  return ok({ updated: true });
});

export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { structureId } = await params;
  await deleteBlockStructure(context, structureId);
  return ok({ deleted: true });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
