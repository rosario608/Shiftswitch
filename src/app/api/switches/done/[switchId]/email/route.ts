import { requireUser } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, requireUuid } from "@/server/http/api";
import { generateSwitchEmail, listEmailRecords } from "@/server/domain/email";

export const dynamic = "force-dynamic";

/** Generates (or returns) the program-notification email for a completed switch. */
export const POST = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ switchId: string }> }) => {
    const context = await requireUser();
    const { switchId: rawId } = await ctx.params;
    const switchId = requireUuid(rawId, "switch");
    const email = await generateSwitchEmail(context, switchId);
    return ok({ email });
  },
);

export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ switchId: string }> }) => {
    const context = await requireUser();
    const { switchId: rawId } = await ctx.params;
    const switchId = requireUuid(rawId, "switch");
    const records = await listEmailRecords(switchId, context.program.id);
    return ok({ records });
  },
);

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
