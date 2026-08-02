import { withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { forbidden, validationFailed } from "@/server/http/errors";
import type { ShiftDetail, TradePreferences, TradeRequestRow } from "@/server/db/types";
import { queryOne } from "@/server/db/pool";
import { SHIFT_DETAIL_SELECT } from "./schedule";
import { placeSelfReportedShift, readTime } from "./self-report";
import { resolveServiceId } from "./shift-write";
import { postShiftWithin } from "./trades";

/**
 * A shift needs nothing behind it.
 *
 * ## The programme this is written for
 *
 * No services. No block year. No cohorts, no coverage requirements, no
 * published schedule, no uploaded file. One resident who has just signed in,
 * holding a phone, who works Saturday and cannot work Saturday.
 *
 * Everything else in this codebase assumes a programme that has been set up.
 * That assumption is right for the scheduler and wrong for the marketplace,
 * and it is wrong in the specific way that kills a product before it starts:
 * the first person to open it has nothing to do, so they close it, and the
 * second person never hears about it. A switch is worth something to two
 * residents who agree; it does not become worth something when a coordinator
 * finishes configuring rotations.
 *
 * So this path exists, and it deliberately touches none of the scheduler's
 * concepts. It asks for what a resident already knows without looking anything
 * up — **which day, which hours, what to call it** — and it produces a shift
 * that is posted for switch by the time they put the phone down.
 *
 * ## What it is not
 *
 * It is not a schedule. The shift is `self_reported`, exactly as if they had
 * typed it into the week form, and it says so on every screen that shows it to
 * anybody — including the colleague deciding whether to take it. Nothing here
 * confirms anything: a resident vouching for their own hours is the one thing
 * provenance exists to prevent. When the programme's real schedule arrives,
 * these shifts sit beside it saying where they came from, and somebody with
 * `shifts.confirm` can vouch for them or not.
 *
 * It also invents no service taxonomy. `resolveServiceId` creates a service
 * named whatever the resident typed, which is the same thing the importer does
 * with the first file it sees — one code path, so a programme that starts with
 * "Night float" typed by a resident and later imports a file naming
 * "Night Float" gets one service, not two.
 *
 * ## Why creating and posting are one call
 *
 * Because from where the resident is standing they are one act, and the
 * failure mode of splitting them is the worst one available: a shift sitting on
 * their schedule that they believe they have given away. One transaction, or
 * neither — `postShiftWithin` exists for exactly this.
 */

export interface AdHocShiftInput {
  /** `giveaway` posts it one-way; omitted means a switch, as before. */
  kind?: "switch" | "giveaway";
  date: string;
  startTime: string;
  endTime: string;
  endsNextDay?: boolean;
  /** What the resident calls it. Free text; an existing service is reused. */
  service: string;
  location?: string;
  notes?: string;
  preferences?: TradePreferences;
}

export interface AdHocPostResult {
  tradeRequest: TradeRequestRow;
  shift: ShiftDetail;
  /**
   * True when the resident already held this exact shift and it was posted
   * rather than created. Worth saying on the screen: they asked for a shift to
   * exist and be posted, and both are now true, but only one of them because
   * of this request.
   */
  alreadyHadIt: boolean;
}

/**
 * Names a shift and posts it, in one transaction.
 *
 * The capability is `trade.participate` rather than `shifts.self_report`: this
 * publishes something to the whole programme, which is the thing a pending
 * account may not do. A resident waiting to be confirmed can still enter the
 * shift on `/schedule/add` and post it the moment somebody admits them — that
 * split is deliberate and is the whole of what "pending" means.
 */
export async function postAdHocShift(
  context: AuthedContext,
  input: AdHocShiftInput,
): Promise<AdHocPostResult> {
  if (!can(context.user.role, "trade.participate")) {
    throw forbidden("Only residents can post and offer shifts.");
  }
  if (!context.resident) {
    throw validationFailed(
      "Your account is not attached to a schedule yet, so there is nobody to post the shift for. Ask whoever sent you the link to add you as a resident.",
    );
  }
  const resident = context.resident;

  const service = input.service.trim();
  if (!service) {
    throw validationFailed("Say which service this is, for example MICU or Wards.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw validationFailed(`"${input.date}" is not a date.`);
  }

  const startTime = readTime(input.startTime);
  const endTime = readTime(input.endTime);
  const endsNextDay = input.endsNextDay ?? endTime <= startTime;

  return withTransaction(async (client) => {
    const resolved = await resolveServiceId(context.program.id, service, client);

    const placed = await placeSelfReportedShift(
      context,
      resident.id,
      {
        date: input.date,
        startTime,
        endTime,
        endsNextDay,
        serviceId: resolved.id,
        location: input.location,
      },
      client,
    );

    const tradeRequest = await postShiftWithin(
      { ...context, resident },
      {
        shiftId: placed.shiftId,
        notes: input.notes,
        preferences: input.preferences,
        kind: input.kind,
      },
      client,
    );

    const shift = await queryOne<ShiftDetail>(
      `${SHIFT_DETAIL_SELECT} WHERE s.id = $1`,
      [placed.shiftId],
      client,
    );

    return {
      tradeRequest,
      shift: shift!,
      alreadyHadIt: placed.outcome === "duplicate",
    };
  });
}
