"use client";

import { WifiOff } from "lucide-react";
import { useOnline } from "@/lib/use-action";

/**
 * Offline is surfaced once, at the top of the app. Mutations are additionally
 * blocked in `apiFetch`, so nothing can appear to succeed while offline.
 */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-40 flex items-center justify-center gap-2 bg-caution-soft px-4 py-2 text-sm font-medium text-caution"
    >
      <WifiOff className="h-4 w-4" aria-hidden="true" />
      <span>You&rsquo;re offline. Schedule changes require an internet connection.</span>
    </div>
  );
}
