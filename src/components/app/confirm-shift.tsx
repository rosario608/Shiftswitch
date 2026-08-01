"use client";

import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Vouching for a shift's hours.
 *
 * Only ever shown to somebody who holds `shifts.confirm`, and the server checks
 * it again — a resident cannot confirm their own schedule, which is the whole
 * reason this is a separate act from correcting one.
 */
export function ConfirmShiftButton({ shiftId }: { shiftId: string }) {
  const router = useRouter();
  const confirm = useAction(
    async () => apiFetch(`/api/shifts/${shiftId}/confirm`, { method: "POST" }),
    { onSuccess: () => router.refresh() },
  );

  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        block
        loading={confirm.pending}
        loadingLabel="Confirming…"
        onClick={() => confirm.run()}
      >
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        Confirm these hours
      </Button>
      <p className="text-sm text-ink-subtle">
        This tells everybody the program has checked them.
      </p>
      <ActionAlert action={confirm} />
    </div>
  );
}
