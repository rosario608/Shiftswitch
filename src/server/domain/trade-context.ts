import { getPool, query, queryOne, type Queryable } from "@/server/db/pool";
import type { ProgramRow, RuleRow, ShiftDetail } from "@/server/db/types";
import { notFound } from "@/server/http/errors";
import {
  countCompletedTradesThisMonth,
  countOpenOffers,
  getResidentInfo,
  getShiftDetail,
  listScheduleWindow,
  toShiftInfo,
} from "./schedule";
import type { TradeContext, TradeLegContext } from "./rules/types";
import { buildProposedSchedule } from "./validation";
import { checkTradeCoverage } from "./trade-coverage";

export async function listActiveRules(
  programId: string,
  executor: Queryable = getPool(),
): Promise<RuleRow[]> {
  return query<RuleRow>(
    "SELECT * FROM rules WHERE program_id = $1 AND active = true ORDER BY rule_type",
    [programId],
    executor,
  );
}

export interface BuildContextInput {
  program: ProgramRow;
  /** Shift the initiating resident is giving up. */
  sourceShift: ShiftDetail;
  /** Shift the offering resident is giving up. */
  offeredShift: ShiftDetail;
  now?: Date;
  executor?: Queryable;
}

/**
 * Materialises everything the rules engine needs for a 1:1 swap:
 * both residents, both schedules, their trade counters, and the program rules.
 *
 * Resident identity always comes from the *current active assignment* on each
 * shift, never from a client-supplied id — so a trade that was posted before an
 * administrator reassigned a shift is revalidated against reality.
 */
export async function buildTradeContext({
  program,
  sourceShift,
  offeredShift,
  now = new Date(),
  executor = getPool(),
}: BuildContextInput): Promise<TradeContext> {
  if (!sourceShift.resident_id || !offeredShift.resident_id) {
    throw notFound(
      "One of the shifts in this switch no longer has anybody on it.",
    );
  }
  // NOTE: these run sequentially on purpose — `executor` may be a transaction
  // client, and a single pg client cannot run queries concurrently.
  const residentA = await getResidentInfo(sourceShift.resident_id, executor);
  const residentB = await getResidentInfo(offeredShift.resident_id, executor);
  if (!residentA || !residentB) {
    throw notFound("One of the residents in this switch is no longer available.");
  }

  const sourceInfo = toShiftInfo(sourceShift);
  const offeredInfo = toShiftInfo(offeredShift);

  const scheduleA = await listScheduleWindow(residentA.id, sourceInfo.start, executor);
  const scheduleB = await listScheduleWindow(residentB.id, offeredInfo.start, executor);
  const tradesA = await countCompletedTradesThisMonth(residentA.id, now, program.timezone, executor);
  const tradesB = await countCompletedTradesThisMonth(residentB.id, now, program.timezone, executor);
  const offersA = await countOpenOffers(residentA.id, executor);
  const offersB = await countOpenOffers(residentB.id, executor);

  // Each resident's window is centred on their own shift; make sure the shift
  // they receive is considered even if it falls outside that window.
  const scheduleInfoA = scheduleA.map(toShiftInfo);
  const scheduleInfoB = scheduleB.map(toShiftInfo);

  const legA: TradeLegContext = buildProposedSchedule({
    resident: residentA,
    gives: sourceInfo,
    receives: offeredInfo,
    currentSchedule: scheduleInfoA,
    completedTradesThisMonth: tradesA,
    openOffers: offersA,
  });
  const legB: TradeLegContext = buildProposedSchedule({
    resident: residentB,
    gives: offeredInfo,
    receives: sourceInfo,
    currentSchedule: scheduleInfoB,
    completedTradesThisMonth: tradesB,
    openOffers: offersB,
  });

  const programInfo = {
    id: program.id,
    name: program.name,
    timezone: program.timezone,
  };

  return {
    program: {
      ...programInfo,
      defaultTradeApprovalRequired: program.default_trade_approval_required,
    },
    now,
    legs: [legA, legB],
    rules: await listActiveRules(program.id, executor),
    /* Asked here because this is the one place that already knows both shifts
       and both residents, and because a switch that leaves a ward short is not
       something the rules engine can see: every rule it evaluates is about one
       of the two people, and coverage is about the service. */
    coverageChecks: await checkTradeCoverage(
      programInfo,
      [
        { shift: sourceInfo, from: residentA.id, to: residentB.id },
        { shift: offeredInfo, from: residentB.id, to: residentA.id },
      ],
      now,
    ),
  };
}

export async function buildTradeContextByShiftIds(
  program: ProgramRow,
  sourceShiftId: string,
  offeredShiftId: string,
  options: { now?: Date; executor?: Queryable } = {},
): Promise<TradeContext> {
  const executor = options.executor ?? getPool();
  const sourceShift = await getShiftDetail(sourceShiftId, executor);
  const offeredShift = await getShiftDetail(offeredShiftId, executor);
  if (!sourceShift || !offeredShift) {
    throw notFound("One of the shifts in this switch no longer exists.");
  }
  return buildTradeContext({
    program,
    sourceShift,
    offeredShift,
    now: options.now,
    executor,
  });
}

export async function getProgram(
  programId: string,
  executor: Queryable = getPool(),
): Promise<ProgramRow> {
  const program = await queryOne<ProgramRow>(
    "SELECT * FROM programs WHERE id = $1",
    [programId],
    executor,
  );
  if (!program) throw notFound("Program not found.");
  return program;
}

/**
 * Everything the rules engine needs for a resident **taking** a shift and
 * giving none back.
 *
 * One leg, because one schedule changes. That is not a simplification of the
 * switch case — it is the whole reason this shape needs its own attention.
 * A switch hands the rest and workload rules a schedule of unchanged size and
 * asks whether the pieces still fit; a giveaway hands them a longer one. The
 * rules that exist precisely for "am I working too much" are decorative in the
 * first case and load-bearing in the second.
 *
 * Coverage is asked with a single leg too. The shift is counted once before
 * and once after: it does not disappear and it does not duplicate — it changes
 * hands. A programme that was covered before a giveaway is covered after it,
 * unless the taker was already on that service at that hour, which is the
 * overlap check's business and is refused outright.
 */
export async function buildGiveawayContext({
  program,
  shift,
  takerResidentId,
  now = new Date(),
  executor = getPool(),
}: {
  program: ProgramRow;
  /** The shift being given away, still held by the poster. */
  shift: ShiftDetail;
  takerResidentId: string;
  now?: Date;
  executor?: Queryable;
}): Promise<TradeContext> {
  if (!shift.resident_id) {
    throw notFound("That shift no longer has anybody on it.");
  }
  const taker = await getResidentInfo(takerResidentId, executor);
  if (!taker) throw notFound("That resident is no longer available.");

  const shiftInfo = toShiftInfo(shift);
  const schedule = await listScheduleWindow(taker.id, shiftInfo.start, executor);
  const trades = await countCompletedTradesThisMonth(
    taker.id,
    now,
    program.timezone,
    executor,
  );
  const offers = await countOpenOffers(taker.id, executor);

  const leg: TradeLegContext = buildProposedSchedule({
    resident: taker,
    /* Nothing goes back. `buildProposedSchedule` subtracts nothing, so the
       proposed schedule is the current one plus this shift. */
    gives: null,
    receives: shiftInfo,
    currentSchedule: schedule.map(toShiftInfo),
    completedTradesThisMonth: trades,
    openOffers: offers,
  });

  const programInfo = {
    id: program.id,
    name: program.name,
    timezone: program.timezone,
  };

  return {
    program: {
      ...programInfo,
      defaultTradeApprovalRequired: program.default_trade_approval_required,
    },
    now,
    legs: [leg],
    rules: await listActiveRules(program.id, executor),
    coverageChecks: await checkTradeCoverage(
      programInfo,
      [{ shift: shiftInfo, from: shift.resident_id, to: taker.id }],
      now,
    ),
  };
}
