"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Label, Select, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction, type ActionState } from "@/lib/use-action";
import { ActionAlert } from "@/components/app/action-alert";

/**
 * Changing a schedule people are already working, and the record of every time
 * it has happened.
 *
 * The list is the point as much as the button is. A published schedule that has
 * been corrected four times looks identical to one that has never been touched
 * unless somebody keeps the record where a reader will find it — and "why am I
 * not on Tuesday any more" is the question this exists to answer.
 *
 * The form is deliberately slower than the draft editor: one shift, a reason
 * that cannot be skipped, and the impact reported back before the sheet closes.
 */

export interface CorrectionView {
  id: string;
  shiftId: string;
  date: string;
  serviceName: string;
  previousResidentName: string | null;
  newResidentName: string | null;
  reason: string;
  summary: string | null;
  safe: boolean | null;
  correctedByName: string | null;
  at: string;
}

export interface CorrectableShift {
  id: string;
  label: string;
  residentName: string | null;
}

export function CorrectionsPanel({
  corrections,
  shifts,
  residents,
}: {
  corrections: CorrectionView[];
  shifts: CorrectableShift[];
  residents: Array<{ id: string; name: string; pgyLevel: number }>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<{
    summary: string;
    safe: boolean;
    notified: string[];
    cancelledTrades: number;
  } | null>(null);

  const correct = useAction(
    async (body: unknown) =>
      apiFetch<{
        impact: { summary: string; safe: boolean } | null;
        notified: string[];
        cancelledTrades: number;
      }>("/api/admin/corrections", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    {
      onSuccess: (response) => {
        setResult({
          summary: response.impact?.summary ?? "Changed.",
          safe: response.impact?.safe ?? true,
          notified: response.notified,
          cancelledTrades: response.cancelledTrades,
        });
        setOpen(false);
        router.refresh();
      },
    },
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-ink-muted">
          Residents are already working this schedule. A correction tells
          everybody affected, cancels any switch against the shift, and is
          recorded here with the reason.
        </p>
        <Button onClick={() => setOpen(true)} disabled={shifts.length === 0}>
          Correct a shift
        </Button>
      </div>

      {/* Announced, not merely displayed. The sheet closes on success, so a
          chief using a screen reader would otherwise be returned to the page
          with no indication that anything happened — and the summary names who
          was told, which is the part they need. */}
      {result ? (
        <Alert tone={result.safe ? "success" : "warning"} title="Corrected" live>
          <p>{result.summary}</p>
          {result.notified.length > 0 ? (
            <p className="mt-1">Told: {result.notified.join(", ")}.</p>
          ) : null}
          {result.cancelledTrades > 0 ? (
            <p className="mt-1">
              {result.cancelledTrades} live switch
              {result.cancelledTrades === 1 ? " was" : "es were"} cancelled, and
              everybody involved was told.
            </p>
          ) : null}
        </Alert>
      ) : null}

      {corrections.length === 0 ? (
        <EmptyState
          title="Nothing has been corrected"
          description="The published schedule is exactly what was published."
        />
      ) : (
        <Card className="divide-y divide-border-base">
          {corrections.map((correction) => (
            <div key={correction.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  {correction.serviceName}{" "}
                  <span className="font-normal text-ink-muted">
                    {correction.date}
                  </span>
                </p>
                <Badge tone={correction.safe === false ? "critical" : "neutral"}>
                  {correction.safe === false ? "Broke something" : "Corrected"}
                </Badge>
              </div>
              <p className="mt-0.5 text-sm text-ink-muted">
                {correction.previousResidentName ?? "Nobody"} →{" "}
                {correction.newResidentName ?? "nobody"}
              </p>
              <p className="mt-1 text-sm text-ink italic">
                &ldquo;{correction.reason}&rdquo;
              </p>
              {correction.summary ? (
                <p className="mt-1 text-sm text-ink-subtle">{correction.summary}</p>
              ) : null}
              <p className="mt-1 text-sm text-ink-subtle">
                {correction.correctedByName ?? "Somebody"} · {correction.at}
              </p>
            </div>
          ))}
        </Card>
      )}

      <CorrectionSheet
        open={open}
        onClose={() => setOpen(false)}
        shifts={shifts}
        residents={residents}
        pending={correct.pending}
        action={correct}
        onSubmit={(body) => correct.run(body)}
      />
    </div>
  );
}

function CorrectionSheet({
  open,
  onClose,
  shifts,
  residents,
  pending,
  action,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  shifts: CorrectableShift[];
  residents: Array<{ id: string; name: string; pgyLevel: number }>;
  pending: boolean;
  /* The whole action, not just its message. A correction interrupted mid-flight
     may already have moved somebody's shift, and a red "it failed" would invite
     a chief to do it twice. */
  action: Pick<ActionState<unknown>, "error" | "uncertain" | "requestId">;
  onSubmit: (body: unknown) => void;
}) {
  const [shiftId, setShiftId] = React.useState(shifts[0]?.id ?? "");
  const [residentId, setResidentId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const chosen = shifts.find((shift) => shift.id === shiftId);

  return (
    <Sheet open={open} onClose={onClose} title="Correct a published shift">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ shiftId, residentId: residentId || null, reason });
        }}
      >
        <ActionAlert action={action} />

        <div>
          <Label htmlFor="correction-shift">Which shift</Label>
          <Select
            id="correction-shift"
            value={shiftId}
            onChange={(event) => setShiftId(event.target.value)}
          >
            {shifts.map((shift) => (
              <option key={shift.id} value={shift.id}>
                {shift.label}
              </option>
            ))}
          </Select>
          {chosen ? (
            <p className="mt-1 text-sm text-ink-muted">
              Currently {chosen.residentName ?? "nobody"}.
            </p>
          ) : null}
        </div>

        <div>
          <Label htmlFor="correction-resident">Who works it now</Label>
          <Select
            id="correction-resident"
            value={residentId}
            onChange={(event) => setResidentId(event.target.value)}
          >
            <option value="">Nobody</option>
            {residents.map((resident) => (
              <option key={resident.id} value={resident.id}>
                {resident.name} · PGY-{resident.pgyLevel}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="correction-reason">Why</Label>
          <Textarea
            id="correction-reason"
            rows={3}
            required
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Nadia is on sick leave from Monday; Femi is covering."
          />
          <p className="mt-1 text-sm text-ink-muted">
            Both residents are told, and this is what they read.
          </p>
        </div>

        <Button type="submit" disabled={pending || !reason.trim()} className="w-full">
          {pending ? "Correcting…" : "Correct this shift"}
        </Button>
      </form>
    </Sheet>
  );
}
