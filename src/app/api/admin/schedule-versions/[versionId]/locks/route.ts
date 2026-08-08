import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import { LOCK_KINDS, addLock, listLocks, removeLock } from "@/server/domain/schedule-locks";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ versionId: string }> };

const createSchema = z.object({
  kind: z.enum(LOCK_KINDS as [string, ...string[]]),
  targetId: z.string().uuid().nullable().optional(),
  targetDate: z.string().date().nullable().optional(),
  reason: z.string().max(300).optional(),
});

const deleteSchema = z.object({ lockId: z.string().uuid() });

export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  const locks = await listLocks(context.program.id, versionId);
  return ok({ locks });
});

export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  const input = await parseJson(request, createSchema);
  const lock = await addLock(context, versionId, {
    ...input,
    kind: input.kind as (typeof LOCK_KINDS)[number],
  });
  return ok({ lock }, { status: 201 });
});

/* The lock id travels in the body rather than the path: a lock is addressed
   only in the context of the draft it protects, and a `/locks/[lockId]` route
   would invite deleting one by id alone from a draft it does not belong to. */
export const DELETE = apiHandler(async (request: Request, { params }: Params) => {
  const context = await requireCapability("scheduling.plan");
  const { versionId } = await params;
  const { lockId } = await parseJson(request, deleteSchema);
  await removeLock(context, versionId, lockId);
  return ok({ removed: true });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
