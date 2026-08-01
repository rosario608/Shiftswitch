import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "@/api/client";
import type { ShiftDetail as Shift } from "@/api/types";
import { Screen } from "@/components/Screen";
import {
  Button,
  Card,
  ErrorState,
  InlineNotice,
  Pill,
  Sheet,
  Skeleton,
  toneForStatus,
  useToast,
} from "@/components/ui";
import { formatLongDate, formatTime, statusLabel } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { useAuth } from "@/auth/AuthProvider";
import { successFeedback, warningFeedback } from "@/native/shell";

interface ShiftResponse {
  shift: Shift;
  timezone: string;
}

/**
 * One shift, and the single action that matters on it: posting it for switch.
 *
 * The server decides whether a shift can be posted (deadline, tradeability,
 * an existing post). The app asks and reports what it is told rather than
 * predicting — a shift that looks postable but is past its trade deadline gets
 * a real explanation, not a silent failure.
 */
export function ShiftDetailScreen() {
  const { shiftId } = useParams<{ shiftId: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const toast = useToast();

  const [posting, setPosting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [postError, setPostError] = useState<string | null>(null);

  const resource = useResource<ShiftResponse>(
    (signal) => api.get<ShiftResponse>(`/api/shifts/${shiftId}`, { signal }),
    [shiftId],
  );

  const shift = resource.data?.shift;
  const timezone = resource.data?.timezone ?? "UTC";
  const isMine = Boolean(
    shift?.resident_id && shift.resident_id === session?.residentId,
  );
  const alreadyPosted =
    shift?.status === "posted" || shift?.status === "offer_pending";

  async function postForSwitch() {
    if (!shiftId) return;
    setPosting(true);
    setPostError(null);
    try {
      const result = await api.post<{ tradeRequest: { id: string } }>(
        "/api/switches",
        { shiftId, notes: notes.trim() || undefined },
      );
      await successFeedback();
      setSheetOpen(false);
      navigate(`/switches/${result.tradeRequest.id}`);
    } catch (caught) {
      await warningFeedback();
      setPostError(
        caught instanceof ApiError
          ? caught.message
          : "Could not post this shift. Please try again.",
      );
    } finally {
      setPosting(false);
    }
  }

  return (
    <Screen
      title="Shift"
      back
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
    >
      {resource.loading && <Skeleton className="h-56" />}

      {resource.error && !shift && (
        <ErrorState
          message={resource.error.message}
          onRetry={() => void resource.reload()}
          retryable={resource.error.retryable}
        />
      )}

      {shift && (
        <div className="space-y-4">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-ink">
                  {shift.service_name}
                </h2>
                <p className="text-ink-muted">
                  {formatLongDate(shift.start_datetime, timezone)}
                </p>
              </div>
              <Pill tone={toneForStatus(shift.status)}>
                {statusLabel(shift.status)}
              </Pill>
            </div>

            <dl className="mt-4 space-y-3 text-sm">
              <Row label="Time">
                {formatTime(shift.start_datetime, timezone)} –{" "}
                {formatTime(shift.end_datetime, timezone)}
              </Row>
              <Row label="Location">{shift.location}</Row>
              <Row label="Type">{shift.shift_type.replace(/_/g, " ")}</Row>
              {shift.rotation_name && (
                <Row label="Rotation">{shift.rotation_name}</Row>
              )}
              <Row label="Assigned to">
                {shift.resident_name ?? "Unassigned"}
                {shift.resident_pgy ? ` · PGY-${shift.resident_pgy}` : ""}
              </Row>
              <Row label="Eligible levels">
                PGY-{shift.required_pgy_min} to PGY-{shift.required_pgy_max}
              </Row>
              {shift.trade_deadline && (
                <Row label="Switch deadline">
                  {formatLongDate(shift.trade_deadline, timezone)}{" "}
                  {formatTime(shift.trade_deadline, timezone)}
                </Row>
              )}
            </dl>
          </Card>

          {shift.approval_required && (
            <InlineNotice tone="caution" title="Chief approval required">
              A switch involving this shift has to be approved by a chief
              resident before it takes effect.
            </InlineNotice>
          )}

          {isMine && !shift.tradeable && (
            <InlineNotice tone="neutral" title="Not available for switching">
              Your program has marked this shift as cannot be switched.
            </InlineNotice>
          )}

          {isMine && alreadyPosted && (
            <InlineNotice tone="brand" title="Already posted">
              This shift is on the switch board. Open Switches to see the offers.
            </InlineNotice>
          )}

          {isMine && shift.tradeable && !alreadyPosted && (
            <Button block onClick={() => setSheetOpen(true)}>
              Post this shift for switch
            </Button>
          )}
        </div>
      )}

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Post for switch"
      >
        <p className="text-sm text-ink-muted">
          Your co-residents will see this shift and can offer one of theirs in
          return. Nothing changes until you accept an offer.
        </p>
        <label
          htmlFor="post-notes"
          className="mt-4 block text-sm font-medium text-ink"
        >
          Note (optional)
        </label>
        <textarea
          id="post-notes"
          value={notes}
          maxLength={500}
          rows={3}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="e.g. Family event — happy to take any weekday in return."
          className="mt-1 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-ink"
        />
        <p className="mt-1 text-xs text-ink-subtle">
          {notes.length}/500 · visible to residents in your program
        </p>

        {postError && (
          <div className="mt-3">
            <InlineNotice tone="critical" title="Could not post">
              {postError}
            </InlineNotice>
          </div>
        )}

        <Button
          block
          className="mt-5"
          busy={posting}
          onClick={() => void postForSwitch()}
        >
          Post for switch
        </Button>
      </Sheet>

      {toast.node}
    </Screen>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="text-right font-medium text-ink capitalize">{children}</dd>
    </div>
  );
}
