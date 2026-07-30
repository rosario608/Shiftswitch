"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

export function MarkAllReadButton() {
  const router = useRouter();
  const markRead = useAction(
    async () => apiFetch("/api/notifications/read", { method: "POST" }),
    { onSuccess: () => router.refresh() },
  );
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={markRead.pending}
      loadingLabel="Marking…"
      onClick={() => markRead.run()}
    >
      Mark all read
    </Button>
  );
}
