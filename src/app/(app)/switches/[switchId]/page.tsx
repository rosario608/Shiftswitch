import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Clock } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, SectionHeading } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ShiftCard } from "@/components/app/shift-card";
import { OfferShiftSheet } from "@/components/app/offer-sheet";
import { OfferDecisionList, type OfferView } from "@/components/app/offer-decision";
import { CancelPostButton, WithdrawOfferButton } from "@/components/app/trade-actions";
import { NotificationPrompt } from "@/components/app/notification-prompt";
import { ShareButton } from "@/components/app/share-button";
import { requirePageUser } from "@/server/auth/page-guards";
import { getTradeRequestDetail } from "@/server/domain/trades";
import { REQUEST_STATUS_LABELS } from "@/server/domain/status";
import { queryOne } from "@/server/db/pool";
import { isUuid } from "@/lib/cn";
import { toShiftView } from "@/lib/views";
import { fmtRelative, fmtTimestamp } from "@/lib/format";
import type { TradeRequestStatus } from "@/server/db/types";

export const dynamic = "force-dynamic";

export default async function TradeDetailPage({
  params,
}: {
  params: Promise<{ switchId: string }>;
}) {
  /* The share link lands here, and the recipient may not be signed in yet —
     which is the normal case for the person a shift is sent to. Passing the
     path through sign-in is what makes the link do what the sender meant:
     without it they arrive, sign in, and are dropped on the home screen with
     no idea which shift they were sent. */
  const { switchId } = await params;
  const context = await requirePageUser(`/switches/${switchId}`);
  if (!isUuid(switchId)) notFound();
  const trade = await getTradeRequestDetail(switchId, context.program.id);
  if (!trade) notFound();

  const timezone = context.program.timezone;
  const sourceShift = toShiftView(trade.shift, timezone);
  const isOwner = context.resident?.id === trade.initiating_resident_id;
  /* Read on the server: the public key is not a secret — every subscribing
     browser receives it — but there is no reason to ship it to people who are
     not being asked, and its absence is how the prompt knows to render
     nothing. */
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? null;
  const myOffer = trade.offers.find(
    (offer) =>
      offer.offering_resident_id === context.resident?.id &&
      ["pending", "accepted"].includes(offer.status),
  );
  const pendingOffers = trade.offers.filter((offer) =>
    ["pending", "accepted"].includes(offer.status),
  );
  const expired = trade.expired;
  const closed = ["completed", "cancelled", "expired"].includes(trade.status);

  const completed = closed
    ? await queryOne<{ id: string }>(
        "SELECT id FROM completed_trades WHERE trade_request_id = $1",
        [trade.id],
      )
    : null;

  const offerViews: OfferView[] = pendingOffers.map((offer) => {
    const snapshot = offer.validation_snapshot as
      | { requiresApproval?: boolean }
      | null;
    return {
      id: offer.id,
      status: offer.status,
      offeringResidentName: offer.offering_resident_name,
      offeringResidentPgy: offer.offering_resident_pgy,
      offeredShift: toShiftView(offer.offered_shift, timezone),
      matchScore: null,
      requiresApproval: Boolean(snapshot?.requiresApproval),
      expiresLabel: fmtRelative(offer.expires_at),
    };
  });

  return (
    <div className="space-y-5">
      <Link
        href="/switches"
        className="inline-flex min-h-[2.5rem] items-center gap-1.5 text-sm font-semibold text-brand-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Switches
      </Link>

      {/* The one moment worth asking. A resident who has just posted a shift is
          waiting for exactly the thing a notification would tell them about, so
          the answer to "why would I want this" is the screen they are looking
          at. Asked anywhere earlier it is the prompt people deny, and a denial
          is close to permanent. Renders nothing for anyone but the person who
          posted, and nothing at all on a deployment with no VAPID keys. */}
      {isOwner && trade.status === "open" ? (
        <NotificationPrompt vapidPublicKey={vapidPublicKey} />
      ) : null}

      {/* Sharing an open shift is how a resident actually asks — the app is
          not where they go first, a group chat is. The link carries a path and
          nothing else: whoever opens it signs in and sees the shift only if
          their programme owns it, so the message itself names nobody. Only
          while it is open, because a link to something already settled sends
          somebody to a dead end. */}
      {!closed ? (
        <div className="flex justify-end">
          <ShareButton
            path={`/switches/${switchId}`}
            title="A shift on ShiftSwitch"
            label="Send this to someone"
            variant="ghost"
          />
        </div>
      ) : null}

      <header>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold text-ink">
            {isOwner ? "Your posted shift" : `${trade.initiator_name}'s shift`}
          </h1>
          <Badge
            tone={
              trade.status === "completed"
                ? "positive"
                : trade.status === "pending_approval"
                  ? "caution"
                  : closed
                    ? "neutral"
                    : "brand"
            }
          >
            {REQUEST_STATUS_LABELS[trade.status as TradeRequestStatus]}
          </Badge>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-muted">
          <Clock className="h-4 w-4" aria-hidden="true" />
          {closed
            ? `Closed · ${fmtTimestamp(trade.updated_at, timezone)}`
            : `Expires ${fmtTimestamp(trade.expires_at, timezone)}`}
        </p>
      </header>

      <ShiftCard shift={sourceShift} showResident />

      {trade.notes ? (
        <Card>
          <CardBody>
            <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              Note from {trade.initiator_name}
            </p>
            <p className="mt-1 text-ink">{trade.notes}</p>
          </CardBody>
        </Card>
      ) : null}

      {trade.status === "pending_approval" ? (
        <Alert tone="warning" title="Waiting for chief approval">
          The switch has been accepted by both residents. Schedules change once a
          chief resident approves it.
        </Alert>
      ) : null}

      {trade.status === "completed" && completed ? (
        <Alert tone="success" title="Switch completed">
          <Link href={`/switches/done/${completed.id}`} className="font-semibold underline">
            View the switch and notify your program
          </Link>
        </Alert>
      ) : null}

      {expired && !closed ? (
        <Alert tone="warning" title="This post has expired">
          Expired posts can no longer receive offers.
        </Alert>
      ) : null}

      {isOwner ? (
        <section aria-labelledby="offers-heading">
          <SectionHeading id="offers-heading" title="Offers received" />
          {offerViews.length === 0 ? (
            <EmptyState
              title="No offers yet"
              description="You'll get a notification as soon as a colleague offers one of their shifts."
            />
          ) : (
            <OfferDecisionList
              offers={offerViews}
              sourceShift={sourceShift}
              requiresApproval={sourceShift.approvalRequired}
            />
          )}
          {!closed ? (
            <div className="mt-4">
              <CancelPostButton tradeRequestId={trade.id} />
            </div>
          ) : null}
        </section>
      ) : (
        <section aria-label="Offer one of your shifts">
          {myOffer ? (
            <Card>
              <CardBody className="space-y-3">
                <div>
                  <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                    Your offer
                  </p>
                  <p className="mt-1 font-semibold text-ink">
                    {toShiftView(myOffer.offered_shift, timezone).dayLabel} ·{" "}
                    {myOffer.offered_shift.service_name}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {toShiftView(myOffer.offered_shift, timezone).timeRange}
                  </p>
                </div>
                {myOffer.status === "accepted" ? (
                  <Alert tone="warning">
                    {trade.initiator_name} accepted your offer. It is waiting for chief
                    approval.
                  </Alert>
                ) : (
                  <>
                    <Alert tone="info">
                      Waiting for {trade.initiator_name} to accept or decline.
                    </Alert>
                    <WithdrawOfferButton offerId={myOffer.id} />
                  </>
                )}
              </CardBody>
            </Card>
          ) : closed || expired ? (
            <EmptyState
              title="This switch is closed"
              description="You can no longer offer a shift for this post."
            />
          ) : (
            <Card>
              <CardBody>
                <OfferShiftSheet
                  tradeRequestId={trade.id}
                  timezone={timezone}
                  disabledReason={
                    context.resident
                      ? null
                      : "Only residents with a schedule can offer a shift."
                  }
                />
              </CardBody>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
