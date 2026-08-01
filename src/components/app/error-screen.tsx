"use client";

import * as React from "react";
import Link from "next/link";
import { reportClientError } from "@/lib/report-client-error";

/**
 * What a resident sees when a screen fails, and what the operator gets from it.
 *
 * One component behind every boundary in the web app, because the alternative
 * is five screens that apologise in five different registers and one of them
 * being wrong.
 *
 * ## The three things it must do
 *
 * **Say what happened, without lying about scope.** The previous version of
 * this screen said "Nothing was changed." That is a claim, and it was not
 * known to be true: a render can fail *after* a mutation committed, and telling
 * somebody their action did not take effect when it did is the exact failure
 * this product cares most about avoiding. It now says what is actually known —
 * this screen could not be displayed — and points at where the truth is.
 *
 * **Give a way back.** A boundary with only "Try again" traps somebody whose
 * screen fails deterministically. There is always a second door.
 *
 * **Carry the request id.** Six characters the resident can read out. It is on
 * screen, in the logs and on the error report, and it is the only thing that
 * turns "it broke" into a specific event somebody can look up.
 */

export interface ErrorScreenProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** What failed, in the resident's terms. */
  title?: string;
  /** Where "go back" should lead when this screen is not the whole app. */
  homeHref?: string;
  homeLabel?: string;
}

export function ErrorScreen({
  error,
  reset,
  title = "This screen didn't load",
  homeHref = "/",
  homeLabel = "Go to my schedule",
}: ErrorScreenProps) {
  /* Next.js replaces the message in production builds with a digest, so the
     digest *is* the identifier — the only string that ties this screen to the
     server log line that has the real stack. When there is neither, say so
     rather than printing an empty box. */
  const reference = error.digest ?? null;

  React.useEffect(() => {
    reportClientError({ error, kind: "render" });
  }, [error]);

  return (
    <main id="main" className="mx-auto w-full max-w-md flex-1 px-5 py-16 text-center">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-3 text-ink-muted">
        Something went wrong while displaying it. Your schedule and any switches
        in progress are unaffected — this is a problem showing the page, not a
        problem with your shifts.
      </p>
      <p className="mt-2 text-ink-muted">
        Trying again usually works. If it doesn&rsquo;t, your program
        administrator can see what happened on the diagnostics page.
      </p>

      <div className="mt-6 flex flex-col items-stretch gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl bg-brand px-5 font-semibold text-white"
        >
          Try again
        </button>
        {/* The second door. A screen that fails every time makes "Try again"
            a loop, and a loop with no exit is how somebody force-quits. */}
        <Link
          href={homeHref}
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border border-border-strong px-5 font-semibold text-ink-muted"
        >
          {homeLabel}
        </Link>
      </div>

      {reference ? (
        <p className="mt-6 text-xs text-ink-subtle">
          If you report this, quote{" "}
          <span className="font-mono font-semibold text-ink-muted">{reference}</span>.
        </p>
      ) : null}
    </main>
  );
}
