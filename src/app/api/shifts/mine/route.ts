import { requireCapability } from "@/server/auth/guards";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { selfShiftSchema } from "@/lib/schemas";
import { addOwnShifts } from "@/server/domain/self-report";

export const dynamic = "force-dynamic";

/**
 * A resident saying what they are working.
 *
 * `shifts.self_report` rather than `schedule.manage`: this touches nobody's
 * schedule but their own, and it is the one thing an account still waiting to
 * be confirmed may do — which is what stops somebody who joined this morning
 * from staring at an empty week until an administrator gets to them.
 */
export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("shifts.self_report");
  const input = await parseJson(request, selfShiftSchema);
  const result = await addOwnShifts(context, input);
  return ok({ result }, { status: 201 });
});
