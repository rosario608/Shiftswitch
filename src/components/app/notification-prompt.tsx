"use client";

import * as React from "react";
import { BellRing, Share, SquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { pushSupport, subscribeToPush, type PushSupport } from "@/lib/web-push";

/**
 * Asking for notifications at the moment a resident can see why.
 *
 * ## When it appears
 *
 * After their first real action — posting a shift, or making an offer — and
 * never on load. A permission prompt before somebody has done anything is the
 * one they deny, and a denial is close to permanent: undoing it means finding a
 * per-site setting buried in browser preferences that nobody can link to
 * directly. One badly-timed prompt costs that resident notifications for good.
 *
 * ## Why it is assertive on iPhones, and only there
 *
 * Because on an iPhone the honest message is not "allow notifications" — the
 * browser will not even offer that in a tab. It is "this cannot reach you until
 * ShiftSwitch is on your Home Screen", which is a genuine instruction with
 * genuine steps, and a resident who does not follow it will never be told about
 * their own switches while believing they will be.
 *
 * So the iOS card does not shrink to a polite hint. It says what will not work,
 * shows the two taps that fix it, and can be dismissed — but it comes back,
 * because the cost of it being ignored is a resident who silently hears
 * nothing. Everywhere else this is a single unobtrusive button, because
 * everywhere else the browser's own prompt does the work.
 *
 * ## What it never does
 *
 * Claim a notification will arrive when it will not. Every branch below either
 * subscribes for real or says plainly why it cannot.
 */

const DISMISSED_KEY = "shiftswitch.notifyPromptDismissedAt";
/* Long enough not to nag within one shift, short enough that somebody who
   dismissed it while walking into a room sees it again the next day. */
const QUIET_HOURS = 20;

function dismissedRecently(): boolean {
  if (typeof localStorage === "undefined") return false;
  const at = Number(localStorage.getItem(DISMISSED_KEY) ?? "0");
  return Number.isFinite(at) && Date.now() - at < QUIET_HOURS * 60 * 60 * 1000;
}

/**
 * Read through `useSyncExternalStore` rather than an effect.
 *
 * Both of these are *external* facts — what this browser can do, and what this
 * person already said — so they are read where React expects external state to
 * be read. Setting them from an effect would also render the wrong thing first
 * and correct it, which on this particular component means an iPhone user
 * seeing "Tell me when somebody offers" for a frame before being told that
 * their browser will do no such thing.
 *
 * The snapshots are cached because `useSyncExternalStore` compares them by
 * identity: a fresh object each call is an infinite render. Neither value
 * changes without a reload or an action of ours, and both are re-read after an
 * action through the local overrides below.
 */
let supportSnapshot: PushSupport | null = null;
let dismissedSnapshot: boolean | null = null;

const noSubscription = () => () => {};

function readSupport(): PushSupport {
  supportSnapshot ??= pushSupport();
  return supportSnapshot;
}

function readDismissed(): boolean {
  dismissedSnapshot ??= dismissedRecently();
  return dismissedSnapshot;
}

export function NotificationPrompt({
  vapidPublicKey,
}: {
  /** Absent when the deployment has no VAPID keys — then this renders nothing. */
  vapidPublicKey: string | null;
}) {
  /* `null` on the server and on the first client render, so nothing is drawn
     until the browser has been asked what it can do. */
  const detected = React.useSyncExternalStore(
    noSubscription,
    readSupport,
    () => null,
  );
  const alreadyDismissed = React.useSyncExternalStore(
    noSubscription,
    readDismissed,
    () => true,
  );

  /* Overrides for what this session has changed, set from event handlers. */
  const [granted, setGranted] = React.useState(false);
  const [dismissedNow, setDismissedNow] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<string | null>(null);

  const support: PushSupport | null = granted ? { kind: "granted" } : detected;
  const dismissed = alreadyDismissed || dismissedNow;

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setDismissedNow(true);
  }

  async function enable() {
    if (!vapidPublicKey) return;
    setBusy(true);
    /* `finally`, because the one thing this must never do is leave the button
       spinning. Every branch below ends in either a subscription or a sentence;
       a throw that skipped `setBusy(false)` would end in neither. */
    try {
      const result = await subscribeToPush(vapidPublicKey);
      setOutcome(result.ok ? null : (result.reason ?? "That did not work."));
      if (result.ok) {
        setGranted(true);
        localStorage.setItem(DISMISSED_KEY, String(Date.now()));
      }
    } catch {
      setOutcome("That did not work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  /* Nothing to say: no keys on this deployment, already subscribed, blocked at
     the browser level, or a browser that simply cannot. In every one of those
     cases a prompt would be noise the resident can do nothing about. */
  if (!vapidPublicKey || !support) return null;
  if (support.kind === "granted" || support.kind === "unsupported") return null;
  if (support.kind === "denied") return null;

  if (support.kind === "needs-install") {
    /* The assertive branch. Dismissible, but it returns — see QUIET_HOURS. */
    if (dismissed) return null;
    return (
      <div className="relative rounded-[var(--radius-card)] border border-brand/40 bg-brand-soft/30 p-4">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now"
          className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <p className="flex items-center gap-2 pr-8 font-semibold text-ink">
          <BellRing className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" />
          You won&rsquo;t be told about your shifts yet
        </p>
        <p className="mt-1.5 text-sm text-ink-muted">
          On an iPhone, notifications only work once ShiftSwitch is on your Home
          Screen. It takes two taps and it stays signed in.
        </p>

        <ol className="mt-3 space-y-2 text-sm text-ink">
          <li className="flex items-center gap-2">
            <Share className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" />
            Tap <strong>Share</strong> at the bottom of Safari
          </li>
          <li className="flex items-center gap-2">
            <SquarePlus className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" />
            Tap <strong>Add to Home Screen</strong>
          </li>
        </ol>

        <p className="mt-3 text-sm text-ink-muted">
          Then open ShiftSwitch from your Home Screen and we&rsquo;ll ask about
          notifications there.
        </p>
      </div>
    );
  }

  /* Everywhere else: one button. The browser's own prompt does the explaining,
     and pre-empting it with a card of our own would be two prompts for one
     decision. */
  return (
    <div className="space-y-2">
      <Button variant="secondary" block loading={busy} onClick={() => void enable()}>
        <BellRing className="h-4 w-4" aria-hidden="true" />
        Tell me when somebody offers
      </Button>
      {outcome ? <Alert tone="info">{outcome}</Alert> : null}
    </div>
  );
}
