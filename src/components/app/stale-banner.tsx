"use client";

import * as React from "react";
import { WifiOff } from "lucide-react";

/**
 * Says, out loud, that what is on screen is old.
 *
 * The service worker will serve a resident their last known schedule when there
 * is no signal, because the alternative — an offline page and nothing else — is
 * useless on a ward. That is only safe if the page is unmistakably labelled,
 * and this is the label.
 *
 * ## Why it reports a time and not just "offline"
 *
 * "You're offline" tells somebody about their phone. **"This is your schedule
 * as it was at 6:04pm"** tells them about their schedule, which is what they
 * came for and what they need in order to decide whether to trust it. Four
 * minutes old is fine for checking which ward you are on tonight; eleven hours
 * old is not, and only the resident can make that call — so give them the fact
 * rather than a judgement.
 *
 * The time comes from a header the service worker stamps when it stores the
 * page. If it cannot be read, the banner says the honest thing — that it does
 * not know how old this is — rather than picking a plausible-looking moment.
 *
 * ## Nothing here can be changed
 *
 * Stated in the banner rather than left to be discovered. `apiFetch` already
 * refuses every mutation while offline and says so, so the two agree; but
 * finding that out by tapping **Accept** and being refused is a worse way to
 * learn it than being told up front.
 */

const CAPTURED_AT = "x-shiftswitch-cached-at";

export function formatCaptured(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  const clock = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (minutes < 1) return `less than a minute ago, at ${clock}`;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago, at ${clock}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"} ago, at ${clock}`;
  return `on ${at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${clock}`;
}

export function StaleBanner() {
  const [offline, setOffline] = React.useState(false);
  const [capturedAt, setCapturedAt] = React.useState<string | null>(null);

  React.useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  React.useEffect(() => {
    if (!offline || typeof caches === "undefined") return;
    let cancelled = false;
    void (async () => {
      try {
        const match = await caches.match(window.location.href);
        const stamp = match?.headers.get(CAPTURED_AT) ?? null;
        if (!cancelled) setCapturedAt(stamp);
      } catch {
        /* Cache access can be refused. The banner still appears; it just does
           not claim to know when this was captured. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [offline]);

  if (!offline) return null;

  const when = capturedAt ? formatCaptured(capturedAt) : "";

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 border-b border-caution/30 bg-caution-soft px-4 py-2.5 text-sm text-caution"
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-semibold">You&rsquo;re offline.</span>{" "}
        {when
          ? `This is your schedule as it was ${when}.`
          : "This is the last version of your schedule that reached this phone, and ShiftSwitch can't tell how old it is."}{" "}
        Nothing can be changed until you have a signal.
      </p>
    </div>
  );
}
