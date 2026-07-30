import { requireUser } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { generateSwitchEmail, listEmailRecords } from "@/server/domain/email";

export const dynamic = "force-dynamic";

/** Generates (or returns) the program-notification email for a completed switch. */
export const POST = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireUser();
    const { tradeId } = await ctx.params;
    const email = await generateSwitchEmail(context, tradeId);
    return ok({ email });
  },
);

export const GET = apiHandler(
  async (_request: Request, ctx: { params: Promise<{ tradeId: string }> }) => {
    const context = await requireUser();
    const { tradeId } = await ctx.params;
    const records = await listEmailRecords(tradeId, context.program.id);
    return ok({ records });
  },
);
