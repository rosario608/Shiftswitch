"use client";

import { ErrorScreen } from "@/components/app/error-screen";

/**
 * The outermost route boundary: anything that throws outside the signed-in
 * shell — the sign-in screen, an invitation page, the legal pages.
 *
 * The shell has its own (`(app)/error.tsx`) so a broken page there keeps the
 * navigation; this one is for routes that have no shell to keep.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen error={error} reset={reset} homeHref="/" homeLabel="Go to home" />;
}
