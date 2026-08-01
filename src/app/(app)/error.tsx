"use client";

import { ErrorScreen } from "@/components/app/error-screen";

/**
 * A page inside the signed-in shell failed.
 *
 * Scoped here rather than left to the root boundary so the **header and the
 * bottom navigation survive**. That is the whole difference between "the
 * trades screen is broken, tap Schedule instead" and "the app is broken,
 * force-quit it" — and it is the difference a resident on a ward at 2am
 * actually experiences.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen error={error} reset={reset} />;
}
