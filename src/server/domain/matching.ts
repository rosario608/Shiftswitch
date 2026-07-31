import type { ProgramRow, ShiftDetail, TradeRequestRow } from "@/server/db/types";
import { durationHours, isNightShift, localDayDiff } from "./time";
import { toShiftInfo } from "./schedule";
import type { ShiftInfo } from "./rules/types";

/**
 * Rules-based match scoring.
 *
 * This is deterministic arithmetic over the program's own criteria — it is not
 * a prediction and is never described as one in the UI. Every point awarded is
 * accompanied by the human-readable reason that produced it.
 */

export interface MatchScore {
  score: number;
  reasons: string[];
  caveats: string[];
}

export interface MatchInput {
  request: Pick<TradeRequestRow, "preferences">;
  /** The shift the viewer would receive. */
  sourceShift: ShiftInfo;
  /** The shift the viewer would give up. */
  candidateShift: ShiftInfo;
  viewerPgy: number;
  program: Pick<ProgramRow, "timezone">;
}

const BASE_SCORE = 55;

export function scoreMatch(input: MatchInput): MatchScore {
  const { request, sourceShift, candidateShift, viewerPgy, program } = input;
  const preferences = request.preferences ?? {};
  const reasons: string[] = [];
  const caveats: string[] = [];
  let score = BASE_SCORE;

  // Eligibility for the shift being received.
  if (
    viewerPgy >= sourceShift.requiredPgyMin &&
    viewerPgy <= sourceShift.requiredPgyMax
  ) {
    score += 10;
    reasons.push("Eligible PGY");
  }

  if (candidateShift.serviceId === sourceShift.serviceId) {
    score += 12;
    reasons.push("Same service");
  } else {
    caveats.push(`Different service (${candidateShift.serviceName})`);
  }

  if (candidateShift.shiftType === sourceShift.shiftType) {
    score += 8;
    reasons.push("Same shift type");
  }

  const wantsSpecificShift = preferences.desiredShiftId === candidateShift.id;
  if (wantsSpecificShift) {
    score += 15;
    reasons.push("Exactly the shift they asked for");
  }

  const preferredDates = preferences.preferredDates ?? [];
  if (preferredDates.includes(candidateShift.date)) {
    score += 10;
    reasons.push("Preferred date");
  } else if (preferredDates.length > 0) {
    caveats.push("Outside their preferred dates");
  }

  const preferredServices = preferences.preferredServiceIds ?? [];
  if (preferredServices.includes(candidateShift.serviceId)) {
    score += 8;
    reasons.push("Preferred service");
  }

  const preferredTypes = preferences.preferredShiftTypes ?? [];
  if (preferredTypes.includes(candidateShift.shiftType)) {
    score += 5;
    reasons.push("Preferred shift type");
  }

  // Comparable workload keeps the swap fair in both directions.
  const sourceHours = durationHours(sourceShift.start, sourceShift.end);
  const candidateHours = durationHours(candidateShift.start, candidateShift.end);
  if (Math.abs(sourceHours - candidateHours) <= 2) {
    score += 6;
    reasons.push("Similar shift length");
  } else {
    caveats.push(
      `${Math.abs(Math.round(sourceHours - candidateHours))}h difference in shift length`,
    );
  }

  const sourceNight = isNightShift(sourceShift.start, sourceShift.end, program.timezone);
  const candidateNight = isNightShift(
    candidateShift.start,
    candidateShift.end,
    program.timezone,
  );
  if (sourceNight === candidateNight) {
    score += 4;
    reasons.push(sourceNight ? "Both are night shifts" : "Both are day shifts");
  } else {
    caveats.push(sourceNight ? "You would pick up a night shift" : "You would give up a night shift");
  }

  const daysApart = Math.abs(localDayDiff(candidateShift.date, sourceShift.date));
  if (daysApart <= 7) {
    score += 4;
    reasons.push("Within the same week");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    caveats,
  };
}

export interface CandidateMatch {
  shift: ShiftDetail;
  match: MatchScore;
}

/** Ranks a viewer's offerable shifts against a posted shift. */
export function rankCandidates(
  request: Pick<TradeRequestRow, "preferences">,
  sourceShift: ShiftDetail,
  candidates: ShiftDetail[],
  viewerPgy: number,
  program: Pick<ProgramRow, "timezone">,
): CandidateMatch[] {
  const source = toShiftInfo(sourceShift);
  return candidates
    .map((shift) => ({
      shift,
      match: scoreMatch({
        request,
        sourceShift: source,
        candidateShift: toShiftInfo(shift),
        viewerPgy,
        program,
      }),
    }))
    .sort((a, b) => b.match.score - a.match.score);
}

export function bestMatch(matches: CandidateMatch[]): CandidateMatch | null {
  return matches.length > 0 ? matches[0] : null;
}
