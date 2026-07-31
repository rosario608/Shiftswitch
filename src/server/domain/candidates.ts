import type { AuthedContext } from "@/server/auth/guards";
import type { ProgramRow, ShiftDetail } from "@/server/db/types";
import { queryOne } from "@/server/db/pool";
import { notFound } from "@/server/http/errors";
import { rankCandidates, type MatchScore } from "./matching";
import {
  countCompletedTradesThisMonth,
  countOpenOffers,
  getResidentInfo,
  listAllOfferableShifts,
  listOfferableShifts,
  listScheduleRange,
  toShiftInfo,
} from "./schedule";
import { listActiveRules } from "./trade-context";
import { getTradeRequestDetail } from "./trades";
import { buildProposedSchedule, validateTrade } from "./validation";
import type { TradeContext, TradeValidationResult } from "./rules/types";

/** How many top-ranked shifts get a full rules evaluation. */
const VALIDATE_LIMIT = 12;
/** Rule windows never look further than 28 days; 45 gives comfortable margin. */
const WINDOW_MS = 45 * 86_400_000;

export interface OfferCandidate {
  shift: ShiftDetail;
  match: MatchScore;
  validation: TradeValidationResult | null;
  eligible: boolean;
  blockingReason: string | null;
  requiresApproval: boolean;
}

/**
 * The shifts the caller could offer for a posted shift, ranked by match score
 * and checked against the rules engine.
 *
 * The UI uses `eligible` to stop a resident from ever selecting a shift that
 * would be rejected — and `blockingReason` to explain why it cannot be picked.
 *
 * Both residents' schedules, the program rules and the trade counters are
 * fetched once and reused for every candidate; only the pure rule evaluation
 * runs per candidate.
 */
export async function getOfferCandidates(
  context: AuthedContext & { resident: { id: string } },
  tradeRequestId: string,
): Promise<{ candidates: OfferCandidate[]; sourceShift: ShiftDetail }> {
  const request = await getTradeRequestDetail(tradeRequestId, context.program.id);
  if (!request) throw notFound("That trade post no longer exists.");

  const offerable = await listOfferableShifts(
    context.resident.id,
    request.source_shift_id,
  );
  const viewer = await getResidentInfo(context.resident.id);
  if (!viewer) throw notFound("Your resident record is no longer available.");

  const ranked = rankCandidates(
    request,
    request.shift,
    offerable,
    viewer.pgyLevel,
    context.program,
  );

  const evaluate = await prepareEvaluator(
    context.program,
    request.shift,
    viewer.id,
    ranked.slice(0, VALIDATE_LIMIT).map((entry) => entry.shift),
  );

  const candidates: OfferCandidate[] = ranked.map((entry, index) => {
    if (index >= VALIDATE_LIMIT || !evaluate) {
      return {
        shift: entry.shift,
        match: entry.match,
        validation: null,
        eligible: true,
        blockingReason: null,
        requiresApproval: false,
      };
    }
    const validation = validateTrade(evaluate(entry.shift));
    return {
      shift: entry.shift,
      match: entry.match,
      validation,
      eligible: validation.valid,
      blockingReason: validation.valid ? null : validation.failures[0].message,
      requiresApproval: validation.requiresApproval,
    };
  });

  // Eligible shifts always sort above blocked ones, then by match score.
  candidates.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.match.score - a.match.score;
  });

  return { candidates, sourceShift: request.shift };
}

/**
 * Loads everything the rules engine needs once, and returns a pure function
 * that produces the `TradeContext` for a given candidate shift.
 */
async function prepareEvaluator(
  program: ProgramRow,
  sourceShift: ShiftDetail,
  viewerResidentId: string,
  candidateShifts: ShiftDetail[],
): Promise<((candidate: ShiftDetail) => TradeContext) | null> {
  if (candidateShifts.length === 0) return null;
  if (!sourceShift.resident_id) return null;

  const poster = await getResidentInfo(sourceShift.resident_id);
  const viewer = await getResidentInfo(viewerResidentId);
  if (!poster || !viewer) return null;

  const instants = [
    sourceShift.start_datetime,
    ...candidateShifts.map((shift) => shift.start_datetime),
  ].map((date) => date.getTime());
  const from = new Date(Math.min(...instants) - WINDOW_MS);
  const to = new Date(Math.max(...instants) + WINDOW_MS);

  const posterSchedule = (await listScheduleRange(poster.id, from, to)).map(toShiftInfo);
  const viewerSchedule = (await listScheduleRange(viewer.id, from, to)).map(toShiftInfo);
  const posterTrades = await countCompletedTradesThisMonth(
    poster.id,
    new Date(),
    program.timezone,
  );
  const viewerTrades = await countCompletedTradesThisMonth(
    viewer.id,
    new Date(),
    program.timezone,
  );
  const posterOffers = await countOpenOffers(poster.id);
  const viewerOffers = await countOpenOffers(viewer.id);
  const rules = await listActiveRules(program.id);
  const source = toShiftInfo(sourceShift);

  return (candidateShift: ShiftDetail): TradeContext => {
    const candidate = toShiftInfo(candidateShift);
    return {
      program: {
        id: program.id,
        name: program.name,
        timezone: program.timezone,
        defaultTradeApprovalRequired: program.default_trade_approval_required,
      },
      now: new Date(),
      legs: [
        buildProposedSchedule({
          resident: poster,
          gives: source,
          receives: candidate,
          currentSchedule: posterSchedule,
          completedTradesThisMonth: posterTrades,
          openOffers: posterOffers,
        }),
        buildProposedSchedule({
          resident: viewer,
          gives: candidate,
          receives: source,
          currentSchedule: viewerSchedule,
          completedTradesThisMonth: viewerTrades,
          openOffers: viewerOffers,
        }),
      ],
      rules,
    };
  };
}

export interface TradeMatchSummary {
  tradeRequestId: string;
  bestScore: number | null;
  bestReasons: string[];
  candidateCount: number;
  /**
   * The score as something a person can act on.
   *
   * A raw percentage was worse than useless here: a swap that is same-service,
   * same-type, similar-length and in the same week scores 99 every time, so
   * every row on the board read "99% match" and the number differentiated
   * nothing while implying a precision the arithmetic does not have. A band
   * plus the count of shifts that actually fit is what a resident needs to
   * decide which posting to open first.
   */
  band: MatchBand | null;
}

export type MatchBand = "strong" | "good" | "possible" | "weak";

export function matchBand(score: number): MatchBand {
  if (score >= 90) return "strong";
  if (score >= 78) return "good";
  if (score >= 65) return "possible";
  return "weak";
}

export const MATCH_BAND_LABEL: Record<MatchBand, string> = {
  strong: "Strong match",
  good: "Good match",
  possible: "Possible match",
  weak: "Weak match",
};

/**
 * Cheap match preview for the "Available trades" list: scores the viewer's
 * offerable shifts against each posted shift without running the full rules
 * engine (that happens when they open the trade).
 */
export async function summariseMatches(
  context: AuthedContext & { resident: { id: string } },
  trades: Array<{
    id: string;
    source_shift_id: string;
    preferences: unknown;
    shift: ShiftDetail;
  }>,
): Promise<Map<string, TradeMatchSummary>> {
  const summaries = new Map<string, TradeMatchSummary>();
  if (trades.length === 0) return summaries;

  const residentRow = await queryOne<{ pgy_level: number }>(
    "SELECT pgy_level FROM residents WHERE id = $1",
    [context.resident.id],
  );
  const pgy = residentRow?.pgy_level ?? 1;

  /* One query for the whole board, not one per row. The only thing that
     differs between postings is that the posting's own shift is excluded, and
     that is a filter, not a query. */
  const allOfferable = await listAllOfferableShifts(context.resident.id);

  for (const trade of trades) {
    const offerable = allOfferable.filter(
      (shift) => shift.id !== trade.source_shift_id,
    );
    const ranked = rankCandidates(
      { preferences: (trade.preferences ?? {}) as never },
      trade.shift,
      offerable,
      pgy,
      context.program,
    );
    const best = ranked[0]?.match.score ?? null;
    summaries.set(trade.id, {
      tradeRequestId: trade.id,
      bestScore: best,
      bestReasons: ranked[0]?.match.reasons.slice(0, 3) ?? [],
      candidateCount: ranked.length,
      band: best === null ? null : matchBand(best),
    });
  }
  return summaries;
}
