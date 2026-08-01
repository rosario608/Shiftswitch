"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, HandCoins, Info, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction, useOnline } from "@/lib/use-action";
import { fmtRange, dayLabel } from "@/lib/format";
import { ActionAlert } from "@/components/app/action-alert";

interface CandidateShift {
  id: string;
  service_name: string;
  location: string;
  start_datetime: string;
  end_datetime: string;
  shift_type: string;
}

interface ValidationCheckView {
  key: string;
  status: string;
  message: string;
  label: string;
  residentName?: string;
}

interface Candidate {
  shift: CandidateShift;
  match: { score: number; reasons: string[]; caveats: string[] };
  eligible: boolean;
  blockingReason: string | null;
  requiresApproval: boolean;
  validation: { checks: ValidationCheckView[] } | null;
}

/**
 * Offering one of your shifts, in one tap when the obvious answer is right.
 *
 * The candidates — every shift of the caller's, scored against this posting and
 * checked against the rules — are loaded when the screen loads rather than when
 * a sheet opens. That is the whole point: the best eligible one can then be
 * *named on the button*, so a resident who agrees with the match (which is most
 * of them, because the match is computed from the same rules the server will
 * apply) offers without opening anything.
 *
 * Choosing a different shift is still one tap away, and the sheet behind it is
 * unchanged: every shift with its score, its caveats, and the exact reason an
 * ineligible one cannot be offered — so nobody submits an offer the server will
 * refuse.
 *
 * Offering is reversible; it can be withdrawn until it is accepted. That is why
 * it gets a direct button, and why *accepting* — which is not reversible — keeps
 * its confirmation.
 */
export function OfferShiftSheet({
  tradeRequestId,
  timezone,
  disabledReason,
}: {
  tradeRequestId: string;
  timezone: string;
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const online = useOnline();
  const [open, setOpen] = React.useState(false);
  const [candidates, setCandidates] = React.useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  /* True from the first paint unless there is nothing to check: the button
     starts as "Checking your shifts…" rather than flashing a generic label and
     then changing under the resident's thumb. */
  const [loading, setLoading] = React.useState(!disabledReason);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  /* Loaded when the screen loads, not when a sheet opens, so the best match can
     be named on the button. Written as a subscription — every state change
     happens in a callback rather than in the effect body — because a
     synchronous setState here would cascade a render on every mount. */
  React.useEffect(() => {
    if (disabledReason) return;
    let cancelled = false;
    apiFetch<{ candidates: Candidate[] }>(`/api/switches/${tradeRequestId}/candidates`)
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.candidates);
        const firstEligible = result.candidates.find((candidate) => candidate.eligible);
        setSelectedId(firstEligible?.shift.id ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(
          error instanceof Error ? error.message : "We couldn\u2019t check your shifts.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [disabledReason, tradeRequestId]);

  function openSheet() {
    setOpen(true);
  }

  const selected = candidates?.find((candidate) => candidate.shift.id === selectedId) ?? null;

  const submit = useAction(
    async () =>
      apiFetch(`/api/switches/${tradeRequestId}/offers`, {
        method: "POST",
        body: JSON.stringify({ offeredShiftId: selectedId }),
      }),
    {
      onSuccess: () => {
        setOpen(false);
        router.refresh();
      },
    },
  );

  /* The one the button names: best-scoring shift that actually passes the
     rules. Ranking is the server's, not a re-sort here. */
  const best = candidates?.find((candidate) => candidate.eligible) ?? null;
  const canOfferDirectly = Boolean(best) && !disabledReason;

  return (
    <>
      {canOfferDirectly && best ? (
        <>
          <Button
            block
            loading={submit.pending}
            loadingLabel="Sending offer…"
            disabled={!online}
            onClick={() => {
              setSelectedId(best.shift.id);
              submit.run();
            }}
          >
            <HandCoins className="h-4 w-4" aria-hidden="true" />
            Offer {dayLabel(best.shift.start_datetime, timezone)} ·{" "}
            {best.shift.service_name}
          </Button>
          <p className="mt-1.5 text-center text-sm text-ink-muted">
            {fmtRange(best.shift.start_datetime, best.shift.end_datetime, timezone)}
            {best.requiresApproval ? " · needs a chief\u2019s approval" : ""}
          </p>
          <Button variant="secondary" block className="mt-2" onClick={openSheet}>
            Offer a different shift
          </Button>
          <ActionAlert action={submit} className="mt-2" />
        </>
      ) : (
        <>
          <Button
            block
            onClick={openSheet}
            disabled={Boolean(disabledReason)}
            loading={loading && !candidates}
            loadingLabel="Checking your shifts…"
          >
            <HandCoins className="h-4 w-4" aria-hidden="true" />
            Offer my shift
          </Button>
          {disabledReason ? (
            <p className="mt-2 text-center text-sm text-ink-muted">{disabledReason}</p>
          ) : null}
        </>
      )}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Offer one of your shifts"
        description="Only shifts that pass your program's rules can be offered."
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" block onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              block
              disabled={!selected?.eligible || !online}
              loading={submit.pending}
              loadingLabel="Sending offer…"
              onClick={() => submit.run()}
            >
              Send offer
            </Button>
          </div>
        }
      >
        {submit.error ? (
          <Alert tone="error" className="mb-4">
            {submit.error}
          </Alert>
        ) : null}
        {loadError ? (
          <Alert tone="error" className="mb-4">
            {loadError}
          </Alert>
        ) : null}
        {!online ? (
          <Alert tone="warning" className="mb-4">
            You&rsquo;re offline. Schedule changes require an internet connection.
          </Alert>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-ink-muted">
            <Spinner /> Checking eligibility…
          </p>
        ) : null}

        {candidates && candidates.length === 0 ? (
          <Alert tone="info">
            You don&rsquo;t have any shifts available to offer right now. Shifts that
            are already posted, already offered, or in the past can&rsquo;t be used.
          </Alert>
        ) : null}

        {candidates && candidates.length > 0 ? (
          <ul className="space-y-2">
            {candidates.map((candidate) => {
              const active = selectedId === candidate.shift.id;
              return (
                <li key={candidate.shift.id}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                      active
                        ? "border-brand bg-brand-soft"
                        : candidate.eligible
                          ? "border-border-base"
                          : "border-border-base opacity-70"
                    }`}
                  >
                    <input
                      type="radio"
                      name="candidate"
                      className="mt-1 h-4 w-4 accent-[var(--brand)]"
                      checked={active}
                      disabled={!candidate.eligible}
                      onChange={() => setSelectedId(candidate.shift.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-ink">
                          {dayLabel(candidate.shift.start_datetime, timezone)} ·{" "}
                          {candidate.shift.service_name}
                        </span>
                        {candidate.eligible ? (
                          <Badge tone="positive">{candidate.match.score}% match</Badge>
                        ) : (
                          <Badge tone="critical">Not allowed</Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block text-sm text-ink-muted">
                        {fmtRange(
                          candidate.shift.start_datetime,
                          candidate.shift.end_datetime,
                          timezone,
                        )}
                        {candidate.shift.location ? ` · ${candidate.shift.location}` : ""}
                      </span>
                      {candidate.eligible ? (
                        <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                          {candidate.match.reasons.map((reason) => (
                            <span
                              key={reason}
                              className="flex items-center gap-1 text-xs text-positive"
                            >
                              <Check className="h-3 w-3" aria-hidden="true" />
                              {reason}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="mt-1.5 flex items-start gap-1 text-sm text-critical">
                          <X className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {candidate.blockingReason}
                        </span>
                      )}
                      {candidate.requiresApproval && candidate.eligible ? (
                        <span className="mt-1 flex items-center gap-1 text-xs text-caution">
                          <Info className="h-3 w-3" aria-hidden="true" />
                          Needs chief approval
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}

        {selected?.validation ? (
          <div className="mt-5 rounded-xl bg-surface-muted p-3">
            <p className="mb-2 text-sm font-semibold text-ink">Validation checks</p>
            <ul className="space-y-1">
              {selected.validation.checks.slice(0, 8).map((check) => (
                <li key={check.key} className="flex items-start gap-2 text-sm">
                  {check.status === "pass" ? (
                    <Check
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-positive"
                      aria-hidden="true"
                    />
                  ) : (
                    <X
                      className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                        check.status === "fail" ? "text-critical" : "text-caution"
                      }`}
                      aria-hidden="true"
                    />
                  )}
                  {/* No name prefix. This list is what *you* would run into by
                      making this offer, so naming yourself on every line is
                      noise — and it read as a stutter when the message named
                      the resident too. The approvals queue still prefixes,
                      because two people's checks are interleaved there. */}
                  <span className="text-ink-muted">{check.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
