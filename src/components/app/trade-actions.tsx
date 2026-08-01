"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction, useOnline } from "@/lib/use-action";

/** Cancels a trade post the caller created. Invalidates any pending offers. */
export function CancelPostButton({ tradeRequestId }: { tradeRequestId: string }) {
  const router = useRouter();
  const online = useOnline();
  const [open, setOpen] = React.useState(false);
  const cancel = useAction(
    async () => apiFetch(`/api/switches/${tradeRequestId}/cancel`, { method: "POST" }),
    {
      onSuccess: () => {
        setOpen(false);
        router.push("/switches?tab=mine");
        router.refresh();
      },
    },
  );

  return (
    <>
      <Button variant="secondary" block onClick={() => setOpen(true)}>
        Cancel this post
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Take this shift down?"
        description="Your shift stays on your schedule. Any pending offers will be withdrawn and those residents will be told why."
        footer={
          <div className="flex gap-2 pb-2">
            <Button variant="secondary" block onClick={() => setOpen(false)}>
              Keep post
            </Button>
            <Button
              variant="danger"
              block
              disabled={!online}
              loading={cancel.pending}
              loadingLabel="Cancelling…"
              onClick={() => cancel.run()}
            >
              Cancel post
            </Button>
          </div>
        }
      >
        <ActionAlert action={cancel} />
      </Sheet>
    </>
  );
}

/** Withdraws an offer the caller made on someone else's post. */
export function WithdrawOfferButton({ offerId }: { offerId: string }) {
  const router = useRouter();
  const online = useOnline();
  const withdraw = useAction(
    async () => apiFetch(`/api/offers/${offerId}/withdraw`, { method: "POST" }),
    { onSuccess: () => router.refresh() },
  );

  return (
    <div>
      <Button
        variant="secondary"
        block
        disabled={!online}
        loading={withdraw.pending}
        loadingLabel="Withdrawing…"
        onClick={() => withdraw.run()}
      >
        Withdraw my offer
      </Button>
      {withdraw.error ? (
        <Alert tone="error" className="mt-2">
          {withdraw.error}
        </Alert>
      ) : null}
    </div>
  );
}
