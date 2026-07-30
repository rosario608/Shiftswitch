"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The technical detail stays in the server logs; residents see plain language.
    console.error("Unhandled UI error", error.digest ?? error.message);
  }, [error]);

  return (
    <main id="main" className="mx-auto w-full max-w-md flex-1 px-5 py-16 text-center">
      <h1 className="text-xl font-semibold text-ink">Something went wrong</h1>
      <p className="mt-3 text-ink-muted">
        Nothing was changed. Please try again — if it keeps happening, contact your
        program administrator.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex min-h-[2.75rem] items-center justify-center rounded-xl bg-brand px-5 font-semibold text-white"
      >
        Try again
      </button>
    </main>
  );
}
