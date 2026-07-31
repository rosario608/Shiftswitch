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
 * "Offer my shift": loads the caller's eligible shifts with their match score
 * and rules result. Ineligible shifts are shown but cannot be selected, with the
 * exact reason — so a resident never submits an offer the server will reject.
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
  const [loading, setLoading] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  async function openSheet() {
    setOpen(true);
    if (candidates || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiFetch<{ candidates: Candidate[] }>(
        `/api/trades/${tradeRequestId}/candidates`,
      );
      setCandidates(result.candidates);
      const firstEligible = result.candidates.find((candidate) => candidate.eligible);
      setSelectedId(firstEligible?.shift.id ?? null);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "We couldn't check your shifts.",
      );
    } finally {
      setLoading(false);
    }
  }

  const selected = candidates?.find((candidate) => candidate.shift.id === selectedId) ?? null;

  const submit = useAction(
    async () =>
      apiFetch(`/api/trades/${tradeRequestId}/offers`, {
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

  return (
    <>
      <Button block onClick={openSheet} disabled={Boolean(disabledReason)}>
        <HandCoins className="h-4 w-4" aria-hidden="true" />
        Offer my shift
      </Button>
      {disabledReason ? (
        <p className="mt-2 text-center text-sm text-ink-muted">{disabledReason}</p>
      ) : null}

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
                  <span className="text-ink-muted">
                    {check.residentName ? (
                      <span className="font-medium text-ink">
                        {check.residentName}:{" "}
                      </span>
                    ) : null}
                    {check.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
