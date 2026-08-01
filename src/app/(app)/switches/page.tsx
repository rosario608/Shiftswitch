import Link from "next/link";
import { CalendarPlus, ChevronRight, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requirePageUser } from "@/server/auth/page-guards";
import {
  MATCH_BAND_LABEL,
  summariseMatches,
  type MatchBand,
  type TradeMatchSummary,
} from "@/server/domain/candidates";
import {
  listAvailableTrades,
  listCompletedTradesForResident,
  listMyTradeActivity,
  type ResolvedOutcome,
} from "@/server/domain/trades";
import { REQUEST_STATUS_LABELS, OFFER_STATUS_LABELS } from "@/server/domain/status";
import { PostShiftButton } from "@/components/app/post-shift-sheet";
import { listOfferableForPosting } from "@/server/domain/schedule-actions";
import { toShiftView } from "@/lib/views";
import { fmtTimestamp } from "@/lib/format";
import type { TradeRequestStatus, TradeOfferStatus } from "@/server/db/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Switches" };

const BAND_TONE: Record<MatchBand, "positive" | "brand" | "caution" | "neutral"> = {
  strong: "positive",
  good: "brand",
  possible: "caution",
  weak: "neutral",
};

const TABS = [
  { key: "available", label: "Available" },
  { key: "mine", label: "Mine" },
  { key: "history", label: "History" },
] as const;

/**
 * What is actually happening to a posting, in the resident's own terms.
 *
 * This line used to be a count of *pending* offers, with "No offers yet" as the
 * else. Once an offer was accepted it stopped being pending, so a posting
 * waiting on a chief said "No offers yet" directly beneath a badge reading
 * "Pending approval" — the screen contradicting itself about the one thing the
 * resident opened it to find out. A count only describes a posting nobody has
 * acted on yet; every state after that needs to say what it is waiting for.
 */
function describePosting(status: TradeRequestStatus, pendingOffers: number): string {
  switch (status) {
    case "accepted":
      return "You accepted an offer. Finishing the switch now.";
    case "pending_approval":
      return "You accepted an offer. A chief resident is reviewing the switch.";
    case "approved":
      return "Approved. The switch is being applied to both schedules.";
    default:
      return pendingOffers > 0
        ? `${pendingOffers} offer${pendingOffers === 1 ? "" : "s"} waiting for you`
        : "No offers yet";
  }
}

const OUTCOME_TONE: Record<ResolvedOutcome, "neutral" | "caution"> = {
  declined: "caution",
  unavailable: "caution",
  withdrawn: "neutral",
  expired: "neutral",
  cancelled: "neutral",
};

const OUTCOME_LABEL: Record<ResolvedOutcome, string> = {
  declined: "Declined",
  unavailable: "No longer available",
  withdrawn: "Withdrawn",
  expired: "Expired",
  cancelled: "Cancelled",
};

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const context = await requirePageUser();
  const params = await searchParams;
  const tab = (TABS.find((t) => t.key === params.tab)?.key ?? "available") as
    | "available"
    | "mine"
    | "history";
  const timezone = context.program.timezone;
  const residentId = context.resident?.id ?? null;
  const postable = context.resident
    ? await listOfferableForPosting(context.resident.id)
    : [];

  const available =
    tab === "available"
      ? await listAvailableTrades(context.program.id, residentId, { limit: 50 })
      : [];
  const matches: Map<string, TradeMatchSummary> =
    tab === "available" && context.resident
      ? await summariseMatches(
          context as never,
          available.map((trade) => ({
            id: trade.id,
            source_shift_id: trade.source_shift_id,
            preferences: trade.preferences,
            shift: trade.shift,
          })),
        )
      : new Map();

  /* Sorted by how well it fits *this* resident, not by when it was posted.
     Somebody scanning the board between patients should meet the postings they
     can actually take first; a chronological list buries them. Postings with
     nothing offerable sink to the bottom rather than disappearing, because
     "there is nothing you can swap for this" is still worth seeing. */
  const ordered =
    tab === "available"
      ? [...available].sort((a, b) => {
          const scoreA = matches.get(a.id)?.bestScore ?? -1;
          const scoreB = matches.get(b.id)?.bestScore ?? -1;
          if (scoreA !== scoreB) return scoreB - scoreA;
          return (
            new Date(a.shift.start_datetime).getTime() -
            new Date(b.shift.start_datetime).getTime()
          );
        })
      : available;

  const activity =
    tab === "mine" && residentId
      ? await listMyTradeActivity(residentId, context.program.id)
      : { posted: [], offersMade: [], recentlyClosed: [] };

  const history =
    tab === "history" && residentId
      ? await listCompletedTradesForResident(residentId, context.program.id, 30)
      : [];

  return (
    <div className="space-y-5">
      {/* The heading names the screen; the button is the one thing a resident
          can start from here. Everything below it is somebody else's posting,
          which they can only respond to. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Switches</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Offer one of your shifts for a colleague&rsquo;s posted shift.
          </p>
        </div>
        {context.resident ? (
          <PostShiftButton
            shifts={postable.map((shift) => toShiftView(shift, timezone))}
            label="Post a shift"
            variant="secondary"
            icon={<CalendarPlus className="h-4 w-4" aria-hidden="true" />}
          />
        ) : null}
      </header>

      <nav aria-label="Switch views" className="flex gap-2">
        {TABS.map((item) => (
          <Link
            key={item.key}
            href={`/switches?tab=${item.key}`}
            aria-current={tab === item.key ? "page" : undefined}
            className={`min-h-[2.5rem] flex-1 rounded-xl px-3 py-2 text-center text-sm font-semibold ${
              tab === item.key
                ? "bg-brand text-white"
                : "border border-border-strong text-ink-muted"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {tab === "available" ? (
        available.length === 0 ? (
          <EmptyState
            icon={<Repeat className="h-5 w-5" aria-hidden="true" />}
            title="Nobody has posted a shift"
            description="There are currently no compatible shifts available. Try expanding your date or service preferences, or post one of your own shifts."
          />
        ) : (
          <ul className="space-y-2">
            {ordered.map((trade) => {
              const view = toShiftView(trade.shift, timezone);
              const match = matches.get(trade.id);
              return (
                <li key={trade.id}>
                  <Card>
                    <Link
                      href={`/switches/${trade.id}`}
                      className="block px-4 py-3.5 hover:bg-surface-muted"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink">
                            {view.dayLabel} · {view.serviceName}
                          </p>
                          <p className="mt-0.5 text-sm text-ink-muted">
                            {view.timeRange}
                            {view.location ? ` · ${view.location}` : ""}
                          </p>
                          <p className="mt-1 text-sm text-ink-subtle">
                            Posted by {trade.initiator_name} · PGY-{trade.initiator_pgy}
                          </p>
                          {trade.notes ? (
                            <p className="mt-1.5 line-clamp-2 text-sm text-ink-muted italic">
                              &ldquo;{trade.notes}&rdquo;
                            </p>
                          ) : null}
                          {match ? (
                            <p className="mt-2 flex flex-wrap items-center gap-1.5">
                              {match.band ? (
                                <Badge tone={BAND_TONE[match.band]}>
                                  {MATCH_BAND_LABEL[match.band]}
                                </Badge>
                              ) : (
                                <Badge tone="neutral">Nothing to offer</Badge>
                              )}
                              <span className="text-xs text-ink-subtle">
                                {match.candidateCount === 0
                                  ? "none of your shifts fit"
                                  : `${match.candidateCount} of your shifts fit`}
                              </span>
                              {match.bestReasons.slice(0, 2).map((reason: string) => (
                                <span key={reason} className="text-xs text-ink-subtle">
                                  · {reason}
                                </span>
                              ))}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {trade.my_offer_id ? (
                            <Badge tone="brand">You offered</Badge>
                          ) : null}
                          {trade.offer_count > 0 ? (
                            <span className="text-xs text-ink-subtle">
                              {trade.offer_count} offer
                              {trade.offer_count === 1 ? "" : "s"}
                            </span>
                          ) : null}
                          <ChevronRight
                            className="h-5 w-5 text-ink-subtle"
                            aria-hidden="true"
                          />
                        </div>
                      </div>
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {tab === "mine" ? (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase">
              Shifts you posted
            </h2>
            {activity.posted.length === 0 ? (
              <EmptyState
                title="You haven't posted any shifts"
                description="Post a shift from your schedule and a colleague can offer one of theirs."
              />
            ) : (
              <ul className="space-y-2">
                {activity.posted.map((post) => {
                  const view = toShiftView(post.shift, timezone);
                  const pending = post.offers.filter((o) => o.status === "pending").length;
                  return (
                    <li key={post.id}>
                      <Card>
                        <Link
                          href={`/switches/${post.id}`}
                          className="block px-4 py-3.5 hover:bg-surface-muted"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-semibold text-ink">
                                {view.dayLabel} · {view.serviceName}
                              </p>
                              <p className="mt-0.5 text-sm text-ink-muted">
                                {view.timeRange}
                              </p>
                              <p className="mt-1 text-sm text-ink-subtle">
                                {describePosting(post.status as TradeRequestStatus, pending)}
                              </p>
                            </div>
                            <Badge
                              tone={
                                post.status === "pending_approval" ? "caution" : "brand"
                              }
                            >
                              {REQUEST_STATUS_LABELS[post.status as TradeRequestStatus]}
                            </Badge>
                          </div>
                        </Link>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase">
              Offers you made
            </h2>
            {activity.offersMade.length === 0 ? (
              <EmptyState
                title="No open offers"
                description="Offers you make on other residents' shifts appear here until they're accepted or declined."
              />
            ) : (
              <ul className="space-y-2">
                {activity.offersMade.map((offer) => {
                  const view = toShiftView(offer.request.shift, timezone);
                  return (
                    <li key={offer.id}>
                      <Card>
                        <Link
                          href={`/switches/${offer.trade_request_id}`}
                          className="block px-4 py-3.5 hover:bg-surface-muted"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-semibold text-ink">
                                {view.dayLabel} · {view.serviceName}
                              </p>
                              <p className="mt-0.5 text-sm text-ink-muted">
                                You offered one of your shifts to{" "}
                                {offer.request.initiator_name}
                              </p>
                            </div>
                            <Badge
                              tone={offer.status === "accepted" ? "caution" : "neutral"}
                            >
                              {OFFER_STATUS_LABELS[offer.status as TradeOfferStatus]}
                            </Badge>
                          </div>
                        </Link>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Trades that ended without a switch.
              Completed ones live in History; these had nowhere to go, so they
              simply disappeared — a resident told "your offer was declined"
              found no trace of it anywhere in the app. Two weeks of them, with
              the reason spelled out, so every notification has somewhere to
              land. Absent entirely when there are none: an empty state here
              would imply something ought to have gone wrong. */}
          {activity.recentlyClosed.length > 0 ? (
            <section>
              <h2 className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase">
                Recently closed
              </h2>
              <ul className="space-y-2">
                {activity.recentlyClosed.map((entry) => {
                  const view = toShiftView(entry.shift, timezone);
                  return (
                    <li key={`${entry.kind}-${entry.id}`}>
                      <Card>
                        <Link
                          href={`/switches/${entry.requestId}`}
                          className="block px-4 py-3.5 hover:bg-surface-muted"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-semibold text-ink">
                                {view.dayLabel} · {view.serviceName}
                              </p>
                              <p className="mt-0.5 text-sm text-ink-muted">
                                {entry.detail}
                              </p>
                              <p className="mt-1 text-xs text-ink-subtle">
                                {fmtTimestamp(entry.at, timezone)}
                              </p>
                            </div>
                            <Badge tone={OUTCOME_TONE[entry.outcome]}>
                              {OUTCOME_LABEL[entry.outcome]}
                            </Badge>
                          </div>
                        </Link>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

      {tab === "history" ? (
        history.length === 0 ? (
          <EmptyState
            title="No completed switches yet"
            description="Once a switch completes, it stays here as a permanent record."
          />
        ) : (
          <ul className="space-y-2">
            {history.map((trade) => {
              const source = toShiftView(trade.source_shift, timezone);
              const destination = toShiftView(trade.destination_shift, timezone);
              return (
                <li key={trade.id}>
                  <Card>
                    <Link
                      href={`/switches/done/${trade.id}`}
                      className="block px-4 py-3.5 hover:bg-surface-muted"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink">
                            {source.serviceName} ({source.dateLabel}) ↔{" "}
                            {destination.serviceName} ({destination.dateLabel})
                          </p>
                          <p className="mt-0.5 text-sm text-ink-muted">
                            {trade.resident_a_name} and {trade.resident_b_name}
                          </p>
                          <p className="mt-1 text-xs text-ink-subtle">
                            Completed {fmtTimestamp(trade.completed_at, timezone)}
                          </p>
                        </div>
                        <Badge tone={trade.email_status ? "positive" : "caution"}>
                          {trade.email_status === "marked_sent"
                            ? "Program notified"
                            : trade.email_status
                              ? "Email drafted"
                              : "Notify program"}
                        </Badge>
                      </div>
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
