import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok } from "@/server/http/api";
import { notFound } from "@/server/http/errors";
import { deletePatternException } from "@/server/domain/rotation-cycles";

export const dynamic = "force-dynamic";

/** Removing an override, which puts the cycle underneath it back. */
export const DELETE = apiHandler(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const authed = await requireCapability("scheduling.plan");
    const { id } = await context.params;
    if (!(await deletePatternException(authed.program.id, id))) {
      throw notFound("That override no longer exists.");
    }
    return ok({ removed: id });
  },
);
