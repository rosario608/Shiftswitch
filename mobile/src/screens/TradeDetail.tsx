import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "@/api/client";
import type {
  AcceptOutcome,
  OfferCandidate,
  TradeOffer,
  TradeRequestDetail,
} from "@/api/types";
import { Screen } from "@/components/Screen";
import { ShiftCard, ValidationChecks } from "@/components/ShiftCard";
import {
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  InlineNotice,
  Pill,
  SectionHeading,
  Sheet,
  Skeleton,
  toneForStatus,
  useToast,
} from "@/components/ui";
import { relativeTime, statusLabel } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { useAuth } from "@/auth/AuthProvider";
import { successFeedback, warningFeedback } from "@/native/shell";

/**
 * A posted shift, from both sides.
 *
 * If it is your post you are here to judge offers. If it is someone else's you
 * are here to offer one of your shifts. The screen shows one of those two jobs,
 * never a blend of both.
 */
export function TradeDetailScreen() {
  const { tradeId } = useParams<{ tradeId: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const toast = useToast();
  const timezone = session?.program?.timezone ?? "UTC";

  const resource = useResource<{ trade: TradeRequestDetail }>(
    (signal) =>
      api.get<{ trade: TradeRequestDetail }>(`/api/trades/${tradeId}`, { signal }),
    [tradeId],
  );

  const trade = resource.data?.trade;
  const isMine = trade?.initiating_resident_id === session?.residentId;
  const myOffer = trade?.offers.find(
    (offer) =>
      offer.offering_resident_id === session?.residentId &&
      ["pending", "accepted"].includes(offer.status),
  );
  const pendingOffers = trade?.offers.filter((o) => o.status === "pending") ?? [];
  const live =
    trade && !trade.expired && ["open", "offer_pending"].includes(trade.status);

  return (
    <Screen
      title={isMine ? "Your post" : "Switch request"}
      back
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
    >
      {resource.loading && <Skeleton className="h-64" />}

      {resource.error && !trade && (
        <ErrorState
          message={resource.error.message}
          onRetry={() => void resource.reload()}
          retryable={resource.error.retryable}
        />
      )}

      {trade && (
        <div className="space-y-5">
          <section>
            <SectionHeading>
              {isMine ? "The shift you posted" : "The shift on offer"}
            </SectionHeading>
            <ShiftCard shift={trade.shift} timezone={timezone} showResident />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Pill tone={toneForStatus(trade.status)}>
                {statusLabel(trade.status)}
              </Pill>
              {trade.expired ? (
                <Pill tone="critical">Expired</Pill>
              ) : (
                <span className="text-xs text-ink-subtle">
                  Expires {relativeTime(trade.expires_at)}
                </span>
              )}
            </div>
            {trade.notes && (
              <Card className="mt-3">
                <p className="text-sm text-ink-muted">
                  &ldquo;{trade.notes}&rdquo;
                </p>
                <p className="mt-1 text-xs text-ink-subtle">
                  — {trade.initiator_name}
                </p>
              </Card>
            )}
          </section>

          {trade.status === "pending_approval" && (
            <InlineNotice tone="caution" title="Waiting for chief approval">
              A chief resident has to approve this switch before the schedule
              changes. Both of you will be notified when they do.
            </InlineNotice>
          )}

          {isMine ? (
            <OwnerView
              trade={trade}
              pendingOffers={pendingOffers}
              timezone={timezone}
              live={Boolean(live)}
              onChanged={resource.reload}
              onCompleted={(id) => navigate(`/switches/${id}`)}
              notify={toast.show}
            />
          ) : (
            <OffererView
              tradeId={trade.id}
              myOffer={myOffer}
              timezone={timezone}
              live={Boolean(live)}
              onChanged={resource.reload}
              notify={toast.show}
            />
          )}
        </div>
      )}

      {toast.node}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// The person who posted the shift
// ---------------------------------------------------------------------------

function OwnerView({
  trade,
  pendingOffers,
  timezone,
  live,
  onChanged,
  onCompleted,
  notify,
}: {
  trade: TradeRequestDetail;
  pendingOffers: TradeOffer[];
  timezone: string;
  live: boolean;
  onChanged: () => Promise<void>;
  onCompleted: (completedTradeId: string) => void;
  notify: (message: string, tone?: "positive" | "critical") => void;
}) {
  const [busyOffer, setBusyOffer] = useState<string | null>(null);
  const [confirmAccept, setConfirmAccept] = useState<TradeOffer | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function act(
    offerId: string,
    action: "accept" | "reject",
  ): Promise<void> {
    setBusyOffer(offerId);
    setFailure(null);
    try {
      if (action === "accept") {
        const outcome = await api.post<AcceptOutcome>(
          `/api/offers/${offerId}/accept`,
        );
        await successFeedback();
        setConfirmAccept(null);
        if (outcome.status === "completed") {
          onCompleted(outcome.completedTradeId);
          return;
        }
        notify("Accepted — now waiting for chief approval.");
      } else {
        await api.post(`/api/offers/${offerId}/reject`, {});
        notify("Offer declined.");
      }
      await onChanged();
    } catch (caught) {
      await warningFeedback();
      setConfirmAccept(null);
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "That did not go through. Please try again.",
      );
    } finally {
      setBusyOffer(null);
    }
  }

  return (
    <>
      <section>
        <SectionHeading>
          {pendingOffers.length > 0
            ? `${pendingOffers.length} ${pendingOffers.length === 1 ? "offer" : "offers"}`
            : "Offers"}
        </SectionHeading>

        {failure && (
          <div className="mb-3">
            <InlineNotice tone="critical" title="Could not complete that">
              {failure}
            </InlineNotice>
          </div>
        )}

        {pendingOffers.length === 0 ? (
          <EmptyState
            title="No offers yet"
            detail={
              live
                ? "Your co-residents can see this post. We'll notify you the moment someone offers."
                : "This post is no longer taking offers."
            }
          />
        ) : (
          <ul className="space-y-3">
            {pendingOffers.map((offer) => (
              <li key={offer.id}>
                <Card>
                  <p className="text-sm text-ink-muted">
                    <span className="font-semibold text-ink">
                      {offer.offering_resident_name}
                    </span>{" "}
                    · PGY-{offer.offering_resident_pgy} offers you
                  </p>
                  <div className="mt-2">
                    <ShiftCard
                      shift={offer.offered_shift}
                      timezone={timezone}
                    />
                  </div>

                  {offer.validation_snapshot && (
                    <div className="mt-3">
                      <ValidationChecks
                        checks={offer.validation_snapshot.checks}
                        emptyMessage="Passes every program rule."
                      />
                      {offer.validation_snapshot.requiresApproval && (
                        <p className="mt-2 text-xs text-caution">
                          Accepting sends this to a chief for approval.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="mt-4 flex gap-2">
                    <Button
                      className="flex-1"
                      busy={busyOffer === offer.id}
                      disabled={!live}
                      onClick={() => setConfirmAccept(offer)}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1"
                      disabled={!live || busyOffer === offer.id}
                      onClick={() => void act(offer.id, "reject")}
                    >
                      Decline
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {live && (
        <Button
          block
          variant="secondary"
          onClick={() => setConfirmCancel(true)}
        >
          Take this post down
        </Button>
      )}

      <ConfirmSheet
        open={Boolean(confirmAccept)}
        title="Accept this switch?"
        busy={busyOffer !== null}
        confirmLabel="Yes, accept"
        onCancel={() => setConfirmAccept(null)}
        onConfirm={() => confirmAccept && void act(confirmAccept.id, "accept")}
        body={
          confirmAccept && (
            <>
              <p>
                You will work{" "}
                <span className="font-semibold text-ink">
                  {confirmAccept.offered_shift.service_name}
                </span>{" "}
                and {confirmAccept.offering_resident_name} will take your{" "}
                <span className="font-semibold text-ink">
                  {trade.shift.service_name}
                </span>{" "}
                shift.
              </p>
              {confirmAccept.validation_snapshot?.requiresApproval ? (
                <p>
                  Because of your program&rsquo;s rules this goes to a chief
                  resident for approval first. Nothing changes until they
                  approve it.
                </p>
              ) : (
                <p>
                  The schedule changes immediately, and you&rsquo;ll be able to
                  send your program the notification email.
                </p>
              )}
            </>
          )
        }
      />

      <ConfirmSheet
        open={confirmCancel}
        title="Take this post down?"
        destructive
        confirmLabel="Take it down"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={async () => {
          try {
            await api.post(`/api/trades/${trade.id}/cancel`, {});
            setConfirmCancel(false);
            notify("Post taken down.");
            await onChanged();
          } catch (caught) {
            setConfirmCancel(false);
            setFailure(
              caught instanceof ApiError ? caught.message : "Could not cancel.",
            );
          }
        }}
        body={
          <p>
            Your shift stays yours. Any pending offers are withdrawn and the
            residents who made them are notified.
          </p>
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Everyone else
// ---------------------------------------------------------------------------

function OffererView({
  tradeId,
  myOffer,
  timezone,
  live,
  onChanged,
  notify,
}: {
  tradeId: string;
  myOffer: TradeOffer | undefined;
  timezone: string;
  live: boolean;
  onChanged: () => Promise<void>;
  notify: (message: string, tone?: "positive" | "critical") => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const candidates = useResource<{ candidates: OfferCandidate[] }>(
    (signal) =>
      pickerOpen
        ? api.get<{ candidates: OfferCandidate[] }>(
            `/api/trades/${tradeId}/candidates`,
            { signal },
          )
        : Promise.resolve({ candidates: [] }),
    [pickerOpen, tradeId],
  );

  async function offer(shiftId: string) {
    setSubmitting(true);
    setFailure(null);
    try {
      await api.post(`/api/trades/${tradeId}/offers`, {
        offeredShiftId: shiftId,
      });
      await successFeedback();
      setPickerOpen(false);
      notify("Offer sent.");
      await onChanged();
    } catch (caught) {
      await warningFeedback();
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "Could not send that offer. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (myOffer) {
    return (
      <section>
        <SectionHeading>Your offer</SectionHeading>
        <ShiftCard shift={myOffer.offered_shift} timezone={timezone} />
        <div className="mt-2">
          <Pill tone={toneForStatus(myOffer.status)}>
            {statusLabel(myOffer.status)}
          </Pill>
        </div>
        {myOffer.status === "pending" && (
          <>
            <p className="mt-3 text-sm text-ink-muted">
              Waiting for a decision. You&rsquo;ll get a notification either way.
            </p>
            <Button
              block
              variant="secondary"
              className="mt-3"
              busy={submitting}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await api.post(`/api/offers/${myOffer.id}/withdraw`);
                  notify("Offer withdrawn.");
                  await onChanged();
                } catch (caught) {
                  setFailure(
                    caught instanceof ApiError
                      ? caught.message
                      : "Could not withdraw that offer.",
                  );
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              Withdraw my offer
            </Button>
          </>
        )}
        {failure && (
          <div className="mt-3">
            <InlineNotice tone="critical">{failure}</InlineNotice>
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      <section>
        <SectionHeading>Want it?</SectionHeading>
        {live ? (
          <>
            <p className="text-sm text-ink-muted">
              Offer one of your own shifts in return. We check your
              program&rsquo;s rules before you can pick one, so you can only
              offer something that would actually be allowed.
            </p>
            <Button
              block
              className="mt-3"
              onClick={() => {
                setFailure(null);
                setPickerOpen(true);
              }}
            >
              Offer one of my shifts
            </Button>
          </>
        ) : (
          <EmptyState
            title="No longer available"
            detail="This post has expired or has already been settled."
          />
        )}
        {failure && (
          <div className="mt-3">
            <InlineNotice tone="critical">{failure}</InlineNotice>
          </div>
        )}
      </section>

      <Sheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Choose a shift to offer"
      >
        {candidates.loading && <Skeleton className="h-40" />}

        {candidates.error && (
          <ErrorState
            message={candidates.error.message}
            onRetry={() => void candidates.reload()}
            retryable={candidates.error.retryable}
          />
        )}

        {candidates.data?.candidates.length === 0 && (
          <EmptyState
            title="Nothing you can offer"
            detail="None of your upcoming shifts can be swapped for this one under your program's rules."
          />
        )}

        <ul className="space-y-3">
          {candidates.data?.candidates.map((candidate) => (
            <li key={candidate.shift.id}>
              <Card
                className={candidate.eligible ? "" : "opacity-70"}
              >
                <ShiftCard shift={candidate.shift} timezone={timezone} />

                {candidate.match.reasons.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-positive">
                    {candidate.match.reasons.map((reason) => (
                      <li key={reason}>+ {reason}</li>
                    ))}
                  </ul>
                )}
                {candidate.match.caveats.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-ink-subtle">
                    {candidate.match.caveats.map((caveat) => (
                      <li key={caveat}>· {caveat}</li>
                    ))}
                  </ul>
                )}

                {candidate.eligible ? (
                  <>
                    {candidate.requiresApproval && (
                      <p className="mt-2 text-xs text-caution">
                        Would need chief approval.
                      </p>
                    )}
                    {candidate.validation && (
                      <div className="mt-2">
                        <ValidationChecks
                          checks={candidate.validation.checks}
                          emptyMessage=""
                        />
                      </div>
                    )}
                    <Button
                      block
                      className="mt-3"
                      busy={submitting}
                      onClick={() => void offer(candidate.shift.id)}
                    >
                      Offer this shift
                    </Button>
                  </>
                ) : (
                  <InlineNotice tone="critical" title="Can&rsquo;t offer this">
                    {candidate.blockingReason ??
                      "This shift breaks one of your program's rules."}
                  </InlineNotice>
                )}
              </Card>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}
