"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ShieldAlert } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/field";
import { apiFetch } from "@/lib/api-client";
import { useAction, useOnline } from "@/lib/use-action";
import { PROVENANCE_LABEL_OWN, type ShiftView } from "@/lib/views";

export interface OfferView {
  id: string;
  status: string;
  offeringResidentName: string;
  offeringResidentPgy: number;
  offeredShift: ShiftView;
  matchScore: number | null;
  requiresApproval: boolean;
  expiresLabel: string;
}

/**
 * The decision surface for the resident who posted the shift.
 *
 * Accepting opens an explicit confirmation that spells out exactly what changes
 * — "You give" / "You receive" — before anything is written.
 */
export function OfferDecisionList({
  offers,
  sourceShift,
  requiresApproval,
}: {
  offers: OfferView[];
  sourceShift: ShiftView;
  requiresApproval: boolean;
}) {
  const router = useRouter();
  const online = useOnline();
  const [confirming, setConfirming] = React.useState<OfferView | null>(null);
  const [declining, setDeclining] = React.useState<OfferView | null>(null);
  const [declineReason, setDeclineReason] = React.useState("");

  const accept = useAction(
    async (offerId: unknown) =>
      apiFetch<{ status: string; completedTradeId?: string }>(
        `/api/offers/${offerId as string}/accept`,
        { method: "POST" },
      ),
    {
      onSuccess: (result) => {
        setConfirming(null);
        if (result.status === "completed" && result.completedTradeId) {
          router.push(`/switches/done/${result.completedTradeId}`);
        }
        router.refresh();
      },
    },
  );

  const decline = useAction(
    async (offerId: unknown) =>
      apiFetch(`/api/offers/${offerId as string}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: declineReason.trim() || undefined }),
      }),
    {
      onSuccess: () => {
        setDeclining(null);
        setDeclineReason("");
        router.refresh();
      },
    },
  );

  if (offers.length === 0) return null;

  return (
    <>
      <ul className="space-y-3">
        {offers.map((offer) => (
          <li key={offer.id}>
            <Card>
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">
                      {offer.offeringResidentName} · PGY-{offer.offeringResidentPgy}
                    </p>
                    <p className="mt-1 text-sm text-ink-muted">
                      Offers you {offer.offeredShift.dayLabel} ·{" "}
                      {offer.offeredShift.serviceName}
                    </p>
                    <p className="text-sm text-ink-muted">
                      {offer.offeredShift.timeRange}
                      {offer.offeredShift.location
                        ? ` · ${offer.offeredShift.location}`
                        : ""}
                    </p>
                    <p className="mt-1 text-xs text-ink-subtle">
                      Expires {offer.expiresLabel}
                    </p>
                  </div>
                  {offer.matchScore != null ? (
                    <Badge tone="positive">{offer.matchScore}% match</Badge>
                  ) : null}
                </div>

                {offer.status === "accepted" ? (
                  <Alert tone="warning" className="mt-3">
                    Accepted — waiting for a chief resident to approve the switch.
                  </Alert>
                ) : (
                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="secondary"
                      block
                      onClick={() => setDeclining(offer)}
                    >
                      Decline
                    </Button>
                    <Button block onClick={() => setConfirming(offer)}>
                      Accept
                    </Button>
                  </div>
                )}
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>

      <Sheet
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        title="Complete shift switch?"
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" block onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              block
              disabled={!online}
              loading={accept.pending}
              loadingLabel="Finalising switch…"
              onClick={() => confirming && accept.run(confirming.id)}
            >
              {requiresApproval || confirming?.requiresApproval
                ? "Send for approval"
                : "Complete switch"}
            </Button>
          </div>
        }
      >
        {accept.error ? (
          <Alert tone="error" className="mb-4">
            {accept.error}
          </Alert>
        ) : null}

        {confirming ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-border-base p-3">
              <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                You give
              </p>
              <p className="mt-1 font-semibold text-ink">
                {sourceShift.dateLabel} — {sourceShift.serviceName}{" "}
                <span className="font-normal text-ink-muted">
                  {sourceShift.timeRange}
                </span>
              </p>
              <p className="mt-1 text-sm text-ink-subtle">
                {PROVENANCE_LABEL_OWN[sourceShift.provenance]}
              </p>
            </div>
            <div className="flex justify-center text-ink-subtle">
              <ArrowLeftRight className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="rounded-xl border border-border-base p-3">
              <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                You receive
              </p>
              <p className="mt-1 font-semibold text-ink">
                {confirming.offeredShift.dateLabel} —{" "}
                {confirming.offeredShift.serviceName}{" "}
                <span className="font-normal text-ink-muted">
                  {confirming.offeredShift.timeRange}
                </span>
              </p>
              {/* Both sides, before anything is written. A resident taking
                  somebody's Saturday is entitled to know whether the program
                  confirmed those hours or the person typed them in — and the
                  moment to say so is here, not after the schedules moved. */}
              <p className="mt-1 text-sm text-ink-subtle">
                {confirming.offeredShift.provenanceLabel}
              </p>
            </div>

            {confirming.offeredShift.provenance === "self_reported" ||
            confirming.offeredShift.provenance === "provisional" ? (
              <Alert tone="warning">
                Your program has not confirmed the hours on the shift you would be
                taking. Check them with{" "}
                {confirming.offeringResidentName.split(" ")[0]} before you accept.
              </Alert>
            ) : null}

            {requiresApproval || confirming.requiresApproval ? (
              <Alert tone="warning" title="Chief approval required">
                <span className="flex items-start gap-1.5">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Your schedules will not change until a chief resident approves this
                  switch.
                </span>
              </Alert>
            ) : (
              <Alert tone="info">
                This action will permanently update both schedules.
              </Alert>
            )}
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={Boolean(declining)}
        onClose={() => setDeclining(null)}
        title="Decline this offer?"
        description="Your shift stays posted and other residents can still offer."
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" block onClick={() => setDeclining(null)}>
              Keep offer
            </Button>
            <Button
              variant="danger"
              block
              disabled={!online}
              loading={decline.pending}
              loadingLabel="Declining…"
              onClick={() => declining && decline.run(declining.id)}
            >
              Decline offer
            </Button>
          </div>
        }
      >
        {decline.error ? (
          <Alert tone="error" className="mb-4">
            {decline.error}
          </Alert>
        ) : null}
        <label htmlFor="decline-reason" className="mb-1.5 block text-sm font-medium">
          Reason (optional, shared with the other resident)
        </label>
        <Textarea
          id="decline-reason"
          rows={3}
          maxLength={500}
          value={declineReason}
          onChange={(event) => setDeclineReason(event.target.value)}
          placeholder="Thanks — I need a day shift rather than a night."
        />
      </Sheet>
    </>
  );
}
