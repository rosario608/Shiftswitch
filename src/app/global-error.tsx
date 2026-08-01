"use client";

import * as React from "react";
import { reportClientError } from "@/lib/report-client-error";

/**
 * The last resort: an error thrown in the **root layout itself**.
 *
 * This is the one path that produced a genuine white screen. `error.tsx`
 * boundaries live *inside* the root layout, so they cannot catch a failure in
 * the layout that renders them — and the root layout here does real work
 * (`requirePageUser`, `countUnread`), so "the database is down" reached it.
 * With no `global-error.tsx`, Next.js renders its own blank page: no wording,
 * no way back, nothing reported.
 *
 * ## Why this file looks different from every other component
 *
 * It **replaces `<html>` and `<body>`**, because the layout that would have
 * provided them is the thing that failed. That also means none of the app's
 * providers, fonts or stylesheets are guaranteed — so the styling is inline
 * and the markup is the plainest thing that can be written. A boundary that
 * depends on the CSS bundle having loaded is a boundary that shows a blank
 * page precisely when it is needed.
 *
 * No `next/link` either: routing is part of what may be broken. A plain
 * anchor performs a full navigation, which is the reliable thing here and
 * incidentally the thing most likely to fix it.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    reportClientError({ error, kind: "render" });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#ffffff",
          color: "#111827",
        }}
      >
        <main
          style={{
            maxWidth: "28rem",
            margin: "0 auto",
            padding: "4rem 1.25rem",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
            ShiftSwitch isn&rsquo;t loading
          </h1>
          <p style={{ marginTop: "0.75rem", color: "#4b5563", lineHeight: 1.5 }}>
            Something went wrong before the app could start. This is a problem
            with the app, not with your schedule — your shifts and any switches
            in progress are safe.
          </p>
          <p style={{ marginTop: "0.5rem", color: "#4b5563", lineHeight: 1.5 }}>
            Try again in a moment. If it keeps happening, tell your program
            administrator: they have a diagnostics page that says what is wrong.
          </p>

          <div
            style={{
              marginTop: "1.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: "2.75rem",
                borderRadius: "0.75rem",
                border: "none",
                background: "#1d4ed8",
                color: "#ffffff",
                fontWeight: 600,
                fontSize: "1rem",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                A plain anchor on purpose. `next/link` does a client-side
                navigation through the router, and the router is part of what
                may be broken when this screen is showing. A full page load is
                both the reliable option and the one most likely to fix it. */}
            <a
              href="/"
              style={{
                minHeight: "2.75rem",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "0.75rem",
                border: "1px solid #d1d5db",
                color: "#4b5563",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Reload ShiftSwitch
            </a>
          </div>

          {error.digest ? (
            <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#6b7280" }}>
              If you report this, quote{" "}
              <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                {error.digest}
              </span>
              .
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
