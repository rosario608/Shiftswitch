import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok } from "@/server/http/api";
import { listManagedUsers } from "@/server/domain/admin";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  const context = await requireCapability("users.manage");
  const url = new URL(request.url);
  const users = await listManagedUsers(context.program.id, {
    includeUnassigned: url.searchParams.get("includeUnassigned") !== "false",
    search: url.searchParams.get("search") ?? undefined,
  });
  return ok({ users });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
