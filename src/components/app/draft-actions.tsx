"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Publish or discard a draft.
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
}: {
  versionId: string;
  hasBlockers: boolean;
}) {
  const router = useRouter();
  const [confirmingOverride, setConfirmingOverride] = React.useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false);

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
        <h2 className="font-semibold text-ink">Publish</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Replaces the live schedule for this period only. The rest of the year
          is untouched. Residents see the change immediately.
        </p>
      </div>

      {publish.error ? (
        <p role="alert" className="text-sm text-critical">
          {publish.error}
        </p>
      ) : null}

      {hasBlockers && !confirmingOverride ? (
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
