"use client";

import * as React from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Handing somebody a link.
 *
 * ## What is in the link, and what is not
 *
 * A path and nothing else. No name, no phone number, no service, no date —
 * the recipient sees a shift only after signing in, and only if the programme
 * they belong to is the one that owns it. Putting the shift's details in the
 * message would leak them into whatever the sender pastes it into, which for
 * a text message is somebody else's phone and for a group chat is everybody's.
 *
 * That is also why the caller passes a `title` rather than a body: the share
 * sheet shows the title next to the link, so it is the one string that
 * genuinely does travel. "A shift on ShiftSwitch" travels fine. "Priya's MICU
 * Saturday" does not.
 *
 * ## Why the platform sheet, and why a fallback
 *
 * On a phone, `navigator.share` is the one that reaches the apps people
 * actually use to ask this — Messages, WhatsApp, whatever their programme
 * runs on. On a desktop browser it usually does not exist, and a button that
 * silently does nothing is worse than no button, so it copies instead and
 * says so.
 */
export function ShareButton({
  path,
  title,
  label = "Share",
  variant = "secondary",
}: {
  /** App-relative, e.g. `/switches/abc`. Made absolute against the current origin. */
  path: string;
  /** Shown beside the link by the platform sheet. Must name nobody. */
  title: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  async function share() {
    const url = new URL(path, window.location.origin).toString();
    setFailed(false);

    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        /* Dismissing the sheet rejects, and is not a failure — it is a person
           changing their mind. Anything else falls through to copying, so the
           button still does something useful. */
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      /* Clipboard access can be refused outright — an insecure context, or a
         browser policy. Saying so is the honest end of the line; pretending it
         copied would leave somebody pasting nothing. */
      setFailed(true);
    }
  }

  return (
    <div className="space-y-1.5">
      <Button variant={variant} onClick={() => void share()}>
        {copied ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Share2 className="h-4 w-4" aria-hidden="true" />
        )}
        {copied ? "Link copied" : label}
      </Button>
      {failed ? (
        <p className="flex items-center gap-1.5 text-sm text-ink-muted">
          <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Your browser would not let us copy it. Use the address bar instead.
        </p>
      ) : null}
    </div>
  );
}
