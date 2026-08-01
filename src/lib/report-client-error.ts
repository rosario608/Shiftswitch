/**
 * Tells the server about a crash the browser survived.
 *
 * A resident's screen broke, the boundary caught it, and they saw something
 * sensible. Without this the operator learns nothing at all — the failure
 * happened on a device they will never see, and the first they hear of it is a
 * message saying "the app is broken", weeks later, with no detail.
 *
 * ## What it will not send
 *
 * The route, **with its identifiers removed**. `/trades/9f2c8a1e-…` names a
 * real switch between two real people; `/trades/:id` names a screen. The
 * substitution happens here, before the value exists in a payload, rather than
 * being trusted to the server — the value should never travel in the first
 * place.
 *
 * No props, no state, no component tree, and no `window.location.search`.
 * There is no parameter for them, which is the point: the absence of a field
 * is a stronger guarantee than a rule about not filling one in.
 */

/** Anything that looks like an identifier becomes its shape. */
export function scrubRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return ":id";
      }
      // Invitation tokens and anything else long and opaque.
      if (/^[A-Za-z0-9_-]{16,}$/.test(segment)) return ":token";
      if (/^\d+$/.test(segment)) return ":n";
      return segment;
    })
    .join("/");
}

export interface ClientErrorInput {
  error: unknown;
  kind?: "render" | "client";
  /** The id of the last failed request, when the crash followed one. */
  requestId?: string | null;
}

/**
 * Fire and forget. Never throws, never awaited by anything a resident is
 * waiting on, and silent when it fails — a report that cannot be delivered
 * must not become a second error on a screen that is already apologising.
 */
export function reportClientError({
  error,
  kind = "render",
  requestId,
}: ClientErrorInput): void {
  if (typeof window === "undefined") return;

  const isError = error instanceof Error;
  const body = JSON.stringify({
    name: isError ? error.name : "unknown",
    message: (isError ? error.message : String(error)).slice(0, 2_000),
    stack: isError && error.stack ? error.stack.slice(0, 20_000) : undefined,
    route: scrubRoute(window.location.pathname),
    kind,
    ...(requestId ? { requestId } : {}),
  });

  try {
    /* `sendBeacon` first: it survives the page being closed, which is exactly
       what a resident does after a screen breaks. `keepalive` on the fetch
       fallback is the same idea for browsers where the beacon is refused. */
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/api/client-errors", blob)) return;
    }
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* Deliberately silent. */
  }
}
