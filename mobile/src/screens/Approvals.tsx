import { useState } from "react";
import { api, ApiError } from "@/api/client";
import type { TradeRequestDetail } from "@/api/types";
import { Screen } from "@/components/Screen";
import { ShiftCard, ValidationChecks } from "@/components/ShiftCard";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineNotice,
  SectionHeading,
  Sheet,
  Skeleton,
  useToast,
} from "@/components/ui";
import { relativeTime } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { useAuth } from "@/auth/AuthProvider";
import { successFeedback, warningFeedback } from "@/native/shell";

/**
 * The chief resident's approval queue.
 *
 * Every entry shows what the rules engine found at the time the switch was
 * accepted, so a chief approves with the same information the residents saw.
 * Overriding a failed rule is possible but always requires a written reason —
 * that reason is stored on the approval and in the audit log.
 */
export function ApprovalsScreen() {
  const { session } = useAuth();
  const toast = useToast();
  const timezone = session?.program?.timezone ?? "UTC";

  const resource = useResource<{ approvals: TradeRequestDetail[] }>(
    (signal) =>
      api.get<{ approvals: TradeRequestDetail[] }>("/api/approvals", { signal }),
    [],
  );

  const [decision, setDecision] = useState<{
    trade: TradeRequestDetail;
    action: "approve" | "reject" | "changes";
  } | null>(null);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    if (!decision) return;
    setBusy(true);
    setFailure(null);
    try {
      const { trade, action } = decision;
      if (action === "approve") {
        await api.post(`/api/approvals/${trade.id}/approve`, {
          notes: reason.trim() || undefined,
          override: override ? { reason: reason.trim() } : undefined,
        });
        toast.show("Approved. Both residents have been notified.");
      } else if (action === "reject") {
        await api.post(`/api/approvals/${trade.id}/reject`, {
          reason: reason.trim(),
        });
        toast.show("Rejected.");
      } else {
        await api.post(`/api/approvals/${trade.id}/request-changes`, {
          reason: reason.trim(),
        });
        toast.show("Sent back to the residents.");
      }
      await successFeedback();
      setDecision(null);
      setReason("");
      setOverride(false);
      await resource.reload();
    } catch (caught) {
      await warningFeedback();
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "That did not go through. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const needsReason = decision?.action !== "approve";
  const canSubmit = needsReason || override ? reason.trim().length >= 3 : true;

  return (
    <Screen
      title="Approvals"
      subtitle="Switches waiting on you"
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
    >
      {resource.loading && (
        <div className="space-y-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      )}

      {resource.error && !resource.data && (
        <ErrorState
          message={resource.error.message}
          onRetry={() => void resource.reload()}
          retryable={resource.error.retryable}
        />
      )}

      {resource.data?.approvals.length === 0 && (
        <EmptyState
          title="Nothing waiting"
          detail="Switches that need a chief's approval will appear here."
        />
      )}

      <ul className="space-y-4">
        {resource.data?.approvals.map((trade) => {
          const accepted = trade.offers.find(
            (offer) => offer.status === "accepted",
          );
          return (
            <li key={trade.id}>
              <Card>
                <p className="text-xs text-ink-subtle">
                  Accepted {relativeTime(trade.updated_at)}
                </p>

                <div className="mt-3 space-y-3">
                  <div>
                    <SectionHeading>
                      {trade.initiator_name} gives up
                    </SectionHeading>
                    <ShiftCard shift={trade.shift} timezone={timezone} />
                  </div>
                  {accepted && (
                    <div>
                      <SectionHeading>
                        {accepted.offering_resident_name} gives up
                      </SectionHeading>
                      <ShiftCard
                        shift={accepted.offered_shift}
                        timezone={timezone}
                      />
                    </div>
                  )}
                </div>

                {accepted?.validation_snapshot && (
                  <div className="mt-4">
                    <SectionHeading>Rule check</SectionHeading>
                    <ValidationChecks
                      checks={accepted.validation_snapshot.checks}
                      emptyMessage="Passes every program rule."
                    />
                    {accepted.validation_snapshot.approvalReasons.length > 0 && (
                      <ul className="mt-2 space-y-1 text-xs text-ink-muted">
                        {accepted.validation_snapshot.approvalReasons.map(
                          (approvalReason) => (
                            <li key={approvalReason}>· {approvalReason}</li>
                          ),
                        )}
                      </ul>
                    )}
                  </div>
                )}

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button
                    onClick={() => {
                      setReason("");
                      setOverride(
                        !(accepted?.validation_snapshot?.valid ?? true),
                      );
                      setFailure(null);
                      setDecision({ trade, action: "approve" });
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setReason("");
                      setOverride(false);
                      setFailure(null);
                      setDecision({ trade, action: "reject" });
                    }}
                  >
                    Reject
                  </Button>
                  <Button
                    variant="ghost"
                    className="col-span-2"
                    onClick={() => {
                      setReason("");
                      setOverride(false);
                      setFailure(null);
                      setDecision({ trade, action: "changes" });
                    }}
                  >
                    Ask for changes
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      <Sheet
        open={Boolean(decision)}
        onClose={() => setDecision(null)}
        title={
          decision?.action === "approve"
            ? "Approve this switch"
            : decision?.action === "reject"
              ? "Reject this switch"
              : "Ask for changes"
        }
      >
        {decision?.action === "approve" && override && (
          <InlineNotice tone="caution" title="This overrides a failed rule">
            One of your program&rsquo;s rules does not pass. Approving anyway is
            recorded against your name with the reason you give.
          </InlineNotice>
        )}

        <label
          htmlFor="approval-reason"
          className="mt-4 block text-sm font-medium text-ink"
        >
          {decision?.action === "approve"
            ? override
              ? "Reason for the override (required)"
              : "Note (optional)"
            : "Reason (required)"}
        </label>
        <textarea
          id="approval-reason"
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-ink"
        />
        <p className="mt-1 text-xs text-ink-subtle">
          This is shown to both residents and kept in the audit log.
        </p>

        {failure && (
          <div className="mt-3">
            <InlineNotice tone="critical">{failure}</InlineNotice>
          </div>
        )}

        <Button
          block
          className="mt-5"
          busy={busy}
          disabled={!canSubmit}
          variant={decision?.action === "reject" ? "danger" : "primary"}
          onClick={() => void submit()}
        >
          {decision?.action === "approve"
            ? "Approve"
            : decision?.action === "reject"
              ? "Reject"
              : "Send back"}
        </Button>
        {!canSubmit && (
          <p className="mt-2 text-center text-xs text-ink-subtle">
            Please give a short reason first.
          </p>
        )}
      </Sheet>

      {toast.node}
    </Screen>
  );
}
