"use client";

import { ErrorScreen } from "@/components/app/error-screen";

/**
 * An administrative screen failed.
 *
 * Its own boundary because the admin area is where the densest queries live —
 * the grid, the generator, the analytics — and because the way back is
 * different: a chief whose scheduler screen breaks wants the rest of the admin
 * area, not their own schedule.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorScreen
      error={error}
      reset={reset}
      title="This admin screen didn't load"
      homeHref="/admin"
      homeLabel="Back to the admin overview"
    />
  );
}
