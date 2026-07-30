import type { AuthedContext } from "@/server/auth/guards";
import type { ShiftDetail } from "@/server/db/types";
import { notFound } from "@/server/http/errors";
import { rankCandidates, type MatchScore } from "./matching";
import { listOfferableShifts } from "./schedule";
import { buildTradeContextByShiftIds } from "./trade-context";
import { getTradeRequestDetail } from "./trades";
import { validateTrade } from "./validation";
import type { TradeValidationResult } from "./rules/types";

/** How many top-ranked shifts get a full rules evaluation. */
const VALIDATE_LIMIT = 12;

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
  const viewerPgy = request.shift.resident_pgy ?? 1;
  const residentPgy = await residentPgyLevel(context.resident.id, viewerPgy);

  const ranked = rankCandidates(
    request,
    request.shift,
    offerable,
    residentPgy,
    context.program,
  );

  const candidates: OfferCandidate[] = [];
  for (const [index, entry] of ranked.entries()) {
    if (index >= VALIDATE_LIMIT) {
      candidates.push({
        shift: entry.shift,
        match: entry.match,
        validation: null,
        eligible: true,
        blockingReason: null,
        requiresApproval: false,
      });
      continue;
    }
    const tradeContext = await buildTradeContextByShiftIds(
      context.program,
      request.source_shift_id,
      entry.shift.id,
    );
    const validation = validateTrade(tradeContext);
    candidates.push({
      shift: entry.shift,
      match: entry.match,
      validation,
      eligible: validation.valid,
      blockingReason: validation.valid ? null : validation.failures[0].message,
      requiresApproval: validation.requiresApproval,
    });
  }

  // Eligible shifts always sort above blocked ones, then by match score.
  candidates.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.match.score - a.match.score;
  });

  return { candidates, sourceShift: request.shift };
}

async function residentPgyLevel(residentId: string, fallback: number): Promise<number> {
  const { queryOne } = await import("@/server/db/pool");
  const row = await queryOne<{ pgy_level: number }>(
    "SELECT pgy_level FROM residents WHERE id = $1",
    [residentId],
  );
  return row?.pgy_level ?? fallback;
}
