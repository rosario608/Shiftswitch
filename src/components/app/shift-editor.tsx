"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";
import type { ShiftView } from "@/lib/views";

interface ResidentOption {
  id: string;
  full_name: string;
  pgy_level: number;
  active: boolean;
}

/**
 * Administrative shift editing. Reassigning, cancelling, or removing
 * tradeability invalidates any live trade activity for the shift — the server
 * does that inside the same transaction and notifies the residents involved.
 */
export function ShiftEditorButton({
  shift,
  residents,
}: {
  shift: ShiftView;
  residents: ResidentOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [residentId, setResidentId] = React.useState(shift.residentId ?? "");
  const [location, setLocation] = React.useState(shift.location);
  const [tradeable, setTradeable] = React.useState(shift.tradeable);
  const [approvalRequired, setApprovalRequired] = React.useState(shift.approvalRequired);
  const [cancelShift, setCancelShift] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const save = useAction(
    async () =>
      apiFetch(`/api/admin/shifts/${shift.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          residentId: residentId || null,
          location,
          tradeable,
          approvalRequired,
          status: cancelShift ? "cancelled" : undefined,
          reason: reason.trim() || undefined,
        }),
      }),
    {
      onSuccess: () => {
        setOpen(false);
        setCancelShift(false);
        setReason("");
        router.refresh();
      },
    },
  );

  const reassigning = (residentId || null) !== shift.residentId;
  const disruptive = reassigning || cancelShift || (!tradeable && shift.tradeable);

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Edit shift"
        description={`${shift.dateLong} · ${shift.serviceName} · ${shift.timeRange}`}
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" block onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              block
              variant={cancelShift ? "danger" : "primary"}
              loading={save.pending}
              loadingLabel="Saving…"
              disabled={disruptive && reason.trim().length < 3}
              onClick={() => save.run()}
            >
              {cancelShift ? "Cancel shift" : "Save changes"}
            </Button>
          </div>
        }
      >
        {save.error ? (
          <Alert tone="error" className="mb-3">
            {save.error}
          </Alert>
        ) : null}

        <Field label="Assigned resident" htmlFor={`resident-${shift.id}`}>
          <Select
            id={`resident-${shift.id}`}
            value={residentId}
            onChange={(event) => setResidentId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {residents
              .filter((resident) => resident.active)
              .map((resident) => (
                <option key={resident.id} value={resident.id}>
                  {resident.full_name} · PGY-{resident.pgy_level}
                </option>
              ))}
          </Select>
        </Field>

        <Field label="Location" htmlFor={`location-${shift.id}`}>
          <Input
            id={`location-${shift.id}`}
            value={location}
            onChange={(event) => setLocation(event.target.value)}
          />
        </Field>

        <label className="mb-3 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--brand)]"
            checked={tradeable}
            onChange={(event) => setTradeable(event.target.checked)}
          />
          Residents may trade this shift
        </label>

        <label className="mb-3 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--brand)]"
            checked={approvalRequired}
            onChange={(event) => setApprovalRequired(event.target.checked)}
          />
          A switch involving this shift needs chief approval
        </label>

        <label className="mb-4 flex items-center gap-2 text-sm text-critical">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--critical)]"
            checked={cancelShift}
            onChange={(event) => setCancelShift(event.target.checked)}
          />
          Cancel this shift
        </label>

        {disruptive ? (
          <>
            <Alert tone="warning" className="mb-3">
              This change invalidates any pending trade offers for this shift. The
              residents involved will be notified with the reason.
            </Alert>
            <Field
              label="Reason (required, recorded in the audit log)"
              htmlFor={`reason-${shift.id}`}
            >
              <Textarea
                id={`reason-${shift.id}`}
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </>
        ) : null}
      </Sheet>
    </>
  );
}
