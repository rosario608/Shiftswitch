"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Approve, publish or discard a draft.
 *
 * Two steps, not one. Publication governs a month of a hospital's staffing, and
 * for something like that a single button is a single accident — so a draft is
 * signed off first, and the sign-off records the score and every hard violation
 * knowingly accepted. There is no combined "approve and publish": the pause is
 * the feature.
 *
 * Publishing over live switches is possible and deliberately awkward: the
 * override is a second, separate confirmation rather than a checkbox sitting
 * next to the button, because the consequence is somebody's agreed switch
 * disappearing. Discarding asks too — a draft can represent hours of work, and
 * the shifts go with it.
 */
export function DraftActions({
  versionId,
  hasBlockers,
  approvedBy,
  approvedAt,
  approvalNotes,
  canPublish,
}: {
  versionId: string;
  hasBlockers: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalNotes: string;
  /** False for somebody who may build a schedule but not make it live. */
  canPublish: boolean;
}) {
  const router = useRouter();
  const [confirmingOverride, setConfirmingOverride] = React.useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false);
  const [notes, setNotes] = React.useState("");

  const approve = useAction(
    async () =>
      apiFetch(`/api/admin/schedule-versions/${versionId}`, {
        method: "POST",
        body: JSON.stringify({ action: "approve", notes }),
      }),
    { onSuccess: () => router.refresh() },
  );

  const withdraw = useAction(
    async () =>
      apiFetch(`/api/admin/schedule-versions/${versionId}`, {
        method: "POST",
        body: JSON.stringify({ action: "withdraw-approval" }),
      }),
    { onSuccess: () => router.refresh() },
  );

  const publish = useAction(
    async (force: boolean) =>
      apiFetch(`/api/admin/schedule-versions/${versionId}`, {
        method: "POST",
        body: JSON.stringify({ action: "publish", force }),
      }),
    {
      onSuccess: () => {
        setConfirmingOverride(false);
        router.refresh();
      },
    },
  );

  const discard = useAction(
    async () =>
      apiFetch(`/api/admin/schedule-versions/${versionId}`, { method: "DELETE" }),
    { onSuccess: () => router.push("/admin/scheduler") },
  );

  return (
    <Card className="space-y-3 px-4 py-4">
      <div>
        <h2 className="font-semibold text-ink">Approve</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Sign this schedule off before it goes live. What the check currently
          says — the score, and any hard problem still outstanding — is recorded
          against your name.
        </p>
      </div>

      {approve.error ? (
        <p role="alert" className="text-sm text-critical">
          {approve.error}
        </p>
      ) : null}
      {withdraw.error ? (
        <p role="alert" className="text-sm text-critical">
          {withdraw.error}
        </p>
      ) : null}

      {approvedAt ? (
        <div className="space-y-2">
          <p className="text-sm text-positive">
            Approved by {approvedBy ?? "somebody"} on {approvedAt}.
          </p>
          {approvalNotes ? (
            <p className="text-sm text-ink-muted italic">
              &ldquo;{approvalNotes}&rdquo;
            </p>
          ) : null}
          {canPublish ? (
            <Button
              variant="ghost"
              loading={withdraw.pending}
              loadingLabel="Withdrawing…"
              onClick={() => withdraw.run()}
            >
              Withdraw approval
            </Button>
          ) : null}
        </div>
      ) : canPublish ? (
        <div className="space-y-2">
          <label htmlFor="approval-notes" className="block text-sm text-ink">
            Anything worth recording (optional)
          </label>
          <textarea
            id="approval-notes"
            rows={2}
            value={notes}
            maxLength={1000}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="e.g. Two gaps accepted; night float will cover."
            className="w-full rounded-xl border border-border-strong bg-surface px-3 py-2.5 text-base text-ink placeholder:text-ink-subtle"
          />
          <Button
            loading={approve.pending}
            loadingLabel="Approving…"
            onClick={() => approve.run()}
          >
            Approve this schedule
          </Button>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          Somebody with authority to publish has to sign this off.
        </p>
      )}

      <div className="border-t border-border-base pt-3">
        <h2 className="font-semibold text-ink">Publish</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Replaces the live schedule for this period only. The rest of the year
          is untouched. Everybody with a shift in it is told.
        </p>
      </div>

      {publish.error ? (
        <p role="alert" className="text-sm text-critical">
          {publish.error}
        </p>
      ) : null}

      {!canPublish ? (
        <p className="text-sm text-ink-muted">
          You can build and edit this draft. Making it live is a separate
          authority your role does not hold.
        </p>
      ) : !approvedAt ? (
        <p className="text-sm text-ink-muted">
          Approve it first. Publishing replaces what residents are working from.
        </p>
      ) : hasBlockers && !confirmingOverride ? (
        <div className="space-y-2">
          <p className="text-sm text-critical">
            Publishing is blocked: shifts in this period are part of a live
            switch. Resolve those first, or override.
          </p>
          <Button variant="secondary" onClick={() => setConfirmingOverride(true)}>
            Override and publish anyway
          </Button>
        </div>
      ) : hasBlockers && confirmingOverride ? (
        <div className="space-y-2">
          <p className="text-sm text-critical">
            This will cancel those switches. The residents involved are not asked
            and will only see that their switch is gone. This is recorded in the
            audit log against your name.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              loading={publish.pending}
              loadingLabel="Publishing…"
              onClick={() => publish.run(true)}
            >
              Yes, publish and cancel those switches
            </Button>
            <Button variant="secondary" onClick={() => setConfirmingOverride(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          loading={publish.pending}
          loadingLabel="Publishing…"
          onClick={() => publish.run(false)}
        >
          Publish this schedule
        </Button>
      )}

      <div className="border-t border-border-base pt-3">
        <h2 className="font-semibold text-ink">Discard</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Throws the draft away, including every shift in it. The live schedule
          is unaffected.
        </p>
        {discard.error ? (
          <p role="alert" className="mt-2 text-sm text-critical">
            {discard.error}
          </p>
        ) : null}
        {confirmingDiscard ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="danger"
              loading={discard.pending}
              loadingLabel="Discarding…"
              onClick={() => discard.run()}
            >
              Yes, discard this draft
            </Button>
            <Button variant="secondary" onClick={() => setConfirmingDiscard(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="mt-2"
            onClick={() => setConfirmingDiscard(true)}
          >
            Discard draft
          </Button>
        )}
      </div>
    </Card>
  );
}
