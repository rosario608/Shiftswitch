import { requireChief } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { shiftCreateSchema } from "@/lib/schemas";
import { createShift, listProgramSchedule } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  const context = await requireChief();
  const url = new URL(request.url);
  const shifts = await listProgramSchedule(context.program.id, {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    residentId: url.searchParams.get("residentId") ?? undefined,
    serviceId: url.searchParams.get("serviceId") ?? undefined,
    pgy: url.searchParams.get("pgy") ? Number(url.searchParams.get("pgy")) : undefined,
    status: url.searchParams.get("status") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
    offset: Number(url.searchParams.get("offset") ?? 0),
  });
  return ok({ shifts });
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireChief();
  const input = await parseJson(request, shiftCreateSchema);
  const shift = await createShift(context, input);
  return ok({ shift }, { status: 201 });
});
