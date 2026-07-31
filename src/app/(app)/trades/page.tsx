import Link from "next/link";
import { ChevronRight, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requirePageUser } from "@/server/auth/page-guards";
import { summariseMatches } from "@/server/domain/candidates";
import {
  listAvailableTrades,
  listCompletedTradesForResident,
  listMyTradeActivity,
} from "@/server/domain/trades";
import { REQUEST_STATUS_LABELS, OFFER_STATUS_LABELS } from "@/server/domain/status";
import { toShiftView } from "@/lib/views";
import { fmtTimestamp } from "@/lib/format";
import type { TradeRequestStatus, TradeOfferStatus } from "@/server/db/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trades" };

const TABS = [
  { key: "available", label: "Available" },
  { key: "mine", label: "My trades" },
  { key: "history", label: "History" },
] as const;

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

  const available =
    tab === "available"
      ? await listAvailableTrades(context.program.id, residentId, { limit: 50 })
      : [];
  const matches =
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

  const activity =
    tab === "mine" && residentId
      ? await listMyTradeActivity(residentId, context.program.id)
      : { posted: [], offersMade: [] };

  const history =
    tab === "history" && residentId
      ? await listCompletedTradesForResident(residentId, context.program.id, 30)
      : [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Trades</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Offer one of your shifts for a colleague&rsquo;s posted shift.
        </p>
      </header>

      <nav aria-label="Trade views" className="flex gap-2">
        {TABS.map((item) => (
          <Link
            key={item.key}
            href={`/trades?tab=${item.key}`}
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
            title="No available trades"
            description="There are currently no compatible shifts available. Try expanding your date or service preferences, or post one of your own shifts."
          />
        ) : (
          <ul className="space-y-2">
            {available.map((trade) => {
              const view = toShiftView(trade.shift, timezone);
              const match = matches.get(trade.id);
              return (
                <li key={trade.id}>
                  <Card>
                    <Link
                      href={`/trades/${trade.id}`}
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
                          {match?.bestScore != null ? (
                            <p className="mt-2 flex flex-wrap items-center gap-1.5">
                              <Badge tone="positive">{match.bestScore}% match</Badge>
                              {match.bestReasons.map((reason: string) => (
                                <span key={reason} className="text-xs text-ink-subtle">
                                  {reason}
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
                description="Post a shift from your schedule and colleagues can offer a swap."
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
                          href={`/trades/${post.id}`}
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
                                {pending > 0
                                  ? `${pending} offer${pending === 1 ? "" : "s"} waiting for you`
                                  : "No offers yet"}
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
                          href={`/trades/${offer.trade_request_id}`}
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
                      href={`/switches/${trade.id}`}
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
