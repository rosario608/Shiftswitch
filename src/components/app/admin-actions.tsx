"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { apiFetch } from "@/lib/api-client";
import { useAction, useOnline } from "@/lib/use-action";

export function MaintenanceButton() {
  const router = useRouter();
  const [summary, setSummary] = React.useState<string | null>(null);
  const run = useAction(
    async () =>
      apiFetch<{
        result: { expiredRequests: number; expiredOffers: number; completedShifts: number };
      }>("/api/admin/maintenance", { method: "POST" }),
    {
      onSuccess: (result) => {
        setSummary(
          `${result.result.expiredRequests} post(s) expired, ${result.result.expiredOffers} offer(s) expired, ${result.result.completedShifts} shift(s) closed out.`,
        );
        router.refresh();
      },
    },
  );
  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        block
        loading={run.pending}
        loadingLabel="Running…"
        onClick={() => run.run()}
      >
        Run housekeeping
      </Button>
      {run.error ? <Alert tone="error">{run.error}</Alert> : null}
      {summary ? (
        <Alert tone="success" live>
          {summary}
        </Alert>
      ) : null}
    </div>
  );
}

/** Approve or reject a trade that is waiting for a chief decision. */
export function ApprovalActions({
  tradeRequestId,
  hasFailures,
}: {
  tradeRequestId: string;
  hasFailures: boolean;
}) {
  const router = useRouter();
  const online = useOnline();
  const [rejecting, setRejecting] = React.useState(false);
  const [overriding, setOverriding] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const approve = useAction(
    async (override: unknown) =>
      apiFetch<{ completedTradeId: string }>(
        `/api/approvals/${tradeRequestId}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            notes: notes.trim() || undefined,
            override: override ? { reason: reason.trim() } : undefined,
          }),
        },
      ),
    {
      onSuccess: () => {
        setOverriding(false);
        router.refresh();
      },
    },
  );

  const reject = useAction(
    async () =>
      apiFetch(`/api/approvals/${tradeRequestId}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      }),
    {
      onSuccess: () => {
        setRejecting(false);
        setReason("");
        router.refresh();
      },
    },
  );

  return (
    <div className="space-y-2">
      {approve.error ? <Alert tone="error">{approve.error}</Alert> : null}
      <Field label="Notes for both residents (optional)" htmlFor={`notes-${tradeRequestId}`}>
        <Input
          id={`notes-${tradeRequestId}`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Recorded with the approval"
        />
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" block onClick={() => setRejecting(true)}>
          Reject
        </Button>
        {hasFailures ? (
          <Button variant="danger" block onClick={() => setOverriding(true)}>
            Override &amp; approve
          </Button>
        ) : (
          <Button
            block
            disabled={!online}
            loading={approve.pending}
            loadingLabel="Approving…"
            onClick={() => approve.run(false)}
          >
            Approve switch
          </Button>
        )}
      </div>

      <Sheet
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject this switch?"
        description="Both residents keep their original shifts and are told why."
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" block onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              block
              disabled={reason.trim().length < 3 || !online}
              loading={reject.pending}
              loadingLabel="Rejecting…"
              onClick={() => reject.run()}
            >
              Reject switch
            </Button>
          </div>
        }
      >
        {reject.error ? (
          <Alert tone="error" className="mb-3">
            {reject.error}
          </Alert>
        ) : null}
        <Field
          label="Reason (required — shared with both residents)"
          htmlFor="reject-reason"
        >
          <Textarea
            id="reject-reason"
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </Sheet>

      <Sheet
        open={overriding}
        onClose={() => setOverriding(false)}
        title="Override failed rules?"
        description="This switch currently fails one or more program rules. Overriding is recorded in the audit log with your name, the reason, and the rules overridden."
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" block onClick={() => setOverriding(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              block
              disabled={reason.trim().length < 3 || !online}
              loading={approve.pending}
              loadingLabel="Approving…"
              onClick={() => approve.run(true)}
            >
              Override &amp; approve
            </Button>
          </div>
        }
      >
        {approve.error ? (
          <Alert tone="error" className="mb-3">
            {approve.error}
          </Alert>
        ) : null}
        <Field label="Why is this override justified?" htmlFor="override-reason">
          <Textarea
            id="override-reason"
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </Sheet>
    </div>
  );
}

/** Inline user role/PGY editor on the admin users screen. */
export function UserRoleForm({
  userId,
  initialRole,
  initialPgy,
  initialActive,
  programId,
}: {
  userId: string;
  initialRole: string | null;
  initialPgy: number | null;
  initialActive: boolean;
  programId: string;
}) {
  const router = useRouter();
  const [role, setRole] = React.useState(initialRole ?? "");
  const [pgy, setPgy] = React.useState(String(initialPgy ?? 1));
  const [active, setActive] = React.useState(initialActive);

  const save = useAction(
    async () =>
      apiFetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: role === "" ? null : role,
          programId: role === "" ? null : programId,
          pgyLevel: Number(pgy),
          active,
        }),
      }),
    { onSuccess: () => router.refresh() },
  );

  return (
    <div className="mt-3 space-y-3 border-t border-border-base pt-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label
            htmlFor={`role-${userId}`}
            className="mb-1 block text-xs font-semibold text-ink-subtle uppercase"
          >
            Role
          </label>
          <Select
            id={`role-${userId}`}
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="">Not configured</option>
            <option value="resident">Resident</option>
            <option value="chief">Chief resident</option>
            <option value="admin">Program administrator</option>
          </Select>
        </div>
        <div>
          <label
            htmlFor={`pgy-${userId}`}
            className="mb-1 block text-xs font-semibold text-ink-subtle uppercase"
          >
            PGY level
          </label>
          <Input
            id={`pgy-${userId}`}
            type="number"
            min={1}
            max={10}
            value={pgy}
            onChange={(event) => setPgy(event.target.value)}
            disabled={role !== "resident" && role !== "chief"}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--brand)]"
          checked={active}
          onChange={(event) => setActive(event.target.checked)}
        />
        Account active
      </label>
      {save.error ? <Alert tone="error">{save.error}</Alert> : null}
      <Button
        size="sm"
        loading={save.pending}
        loadingLabel="Saving…"
        onClick={() => save.run()}
      >
        Save changes
      </Button>
    </div>
  );
}
