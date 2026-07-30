import { requireAdmin } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { listManagedUsers } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  const context = await requireAdmin();
  const url = new URL(request.url);
  const users = await listManagedUsers(context.program.id, {
    includeUnassigned: url.searchParams.get("includeUnassigned") !== "false",
    search: url.searchParams.get("search") ?? undefined,
  });
  return ok({ users });
});
