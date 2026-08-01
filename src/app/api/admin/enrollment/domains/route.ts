import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import {
  addEmailDomain,
  listEmailDomains,
  removeEmailDomain,
} from "@/server/domain/enrollment";

export const dynamic = "force-dynamic";

/**
 * The program's own email domains. Listing one is a statement that an address
 * inside it belongs to this program, which is why it sits under
 * `program.manage` — the same authority as the program's name and timezone —
 * and not under whoever happens to be issuing links.
 */

export const GET = apiHandler(async () => {
  const context = await requireCapability("program.manage");
  return ok({ domains: await listEmailDomains(context.program.id) });
});

const domainSchema = z.object({ domain: z.string().min(3).max(120) });

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("program.manage");
  const { domain } = await parseJson(request, domainSchema);
  return ok({ domain: await addEmailDomain(context, domain) }, { status: 201 });
});

export const DELETE = apiHandler(async (request: Request) => {
  const context = await requireCapability("program.manage");
  const { domain } = await parseJson(request, domainSchema);
  await removeEmailDomain(context, domain);
  return ok({ removed: domain });
});
