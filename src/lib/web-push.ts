"use client";

/**
 * Subscribing this browser to notifications, and being honest when it cannot.
 *
 * ## The iOS rule that shapes this whole file
 *
 * Safari delivers a web push notification **only to a site the user has added
 * to their Home Screen**. Not to a tab. Not to a bookmark. There is no flag, no
 * permission and no amount of code that changes it — on an iPhone, a site
 * running in a tab cannot be notified, full stop.
 *
 * Roughly half of any residency programme is on an iPhone, and an enrollment
 * link opens in a tab. So the single most important thing this module does is
 * **tell those people the truth**: not "allow notifications" (which their
 * browser will not even offer), but "add this to your Home Screen first, and
 * here is how". Anything else produces a resident who believes they will be
 * told about their own switches and will not be.
 *
 * ## Why permission is not asked for on load
 *
 * A permission prompt before somebody has done anything is the prompt they deny
 * — and a denial is close to permanent, because clearing it means finding a
 * buried setting neither of us can link to. So the caller asks after a resident
 * has posted a shift or made an offer, at the moment the answer to "why would I
 * want this" is on screen.
 */

export type PushSupport =
  | { kind: "ready" }
  | { kind: "granted" }
  | { kind: "denied" }
  /** iPhone or iPad, in a browser tab. Nothing can be delivered until installed. */
  | { kind: "needs-install" }
  /** A browser with no Push API at all. Rare, and not worth nagging about. */
  | { kind: "unsupported" };

/** iOS and iPadOS, including iPads that claim to be desktop Safari. */
export function isApplePortable(
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
): boolean {
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  /* An iPad on iPadOS 13+ reports itself as a Mac. The touch points are what
     give it away, and getting this wrong means telling an iPad user to install
     nothing and then never notifying them. */
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}

/** Whether the page is running as an installed app rather than in a tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    /* Safari's own, non-standard, and the only one that works on iOS. */
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { kind: "unsupported" };

  const hasApi =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  /* Checked before the API check, deliberately. An iPhone in a tab has no
     PushManager at all, so an API-first order would report `unsupported` and
     the resident would be told their browser cannot do this — when in fact
     their browser can, once the site is installed. The difference between
     "impossible" and "one step away" is the whole point. */
  if (isApplePortable() && !isStandalone()) return { kind: "needs-install" };

  if (!hasApi) return { kind: "unsupported" };
  if (Notification.permission === "granted") return { kind: "granted" };
  if (Notification.permission === "denied") return { kind: "denied" };
  return { kind: "ready" };
}

/**
 * base64url → the bytes `PushManager.subscribe` wants.
 *
 * Backed by an explicit `ArrayBuffer` rather than letting the runtime choose:
 * `applicationServerKey` will not accept a view over a `SharedArrayBuffer`, and
 * the default `Uint8Array` type is wide enough to include one.
 */
export function decodeVapidKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Whether an existing subscription was made against the key we send with. */
export function sameKey(
  existing: ArrayBuffer | null | undefined,
  expected: Uint8Array,
): boolean {
  if (!existing) return false;
  const bytes = new Uint8Array(existing);
  if (bytes.length !== expected.length) return false;
  return bytes.every((byte, index) => byte === expected[index]);
}

/** A stable id for this browser, so re-subscribing updates rather than duplicates. */
function installId(): string {
  const key = "shiftswitch.installId";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export interface SubscribeOutcome {
  ok: boolean;
  /** Why not, in words the resident can act on. */
  reason?: string;
}

/** Long enough for a slow phone to install a worker, short enough to not look broken. */
const WORKER_READY_TIMEOUT_MS = 10_000;

/**
 * The registration to subscribe against, or `null` if there will never be one.
 *
 * `navigator.serviceWorker.ready` is the documented way to wait for an active
 * worker, and it has a trap: **if nothing was ever registered it does not
 * reject, it simply never settles**. Awaiting it bare means a button that spins
 * for the rest of the session with nothing said — and that is not a rare edge.
 * `ServiceWorkerRegistrar` skips registration entirely outside production and
 * swallows a failed one, so "no registration" is the *guaranteed* state in
 * development and a plausible one anywhere.
 *
 * So: register if nothing has, and put a deadline on the wait. A resident who
 * is told "that did not work, try again" has somewhere to go. A spinner has
 * nowhere.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (!(await navigator.serviceWorker.getRegistration())) {
      await navigator.serviceWorker.register("/sw.js");
    }
  } catch {
    return null;
  }
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), WORKER_READY_TIMEOUT_MS)),
  ]);
}

/**
 * Asks for permission, subscribes, and registers the subscription.
 *
 * Returns rather than throws, because every failure here is something the
 * resident should be told plainly rather than an exception somebody sees in a
 * log. A denied prompt is not an error; it is an answer.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<SubscribeOutcome> {
  const support = pushSupport();
  if (support.kind === "needs-install") {
    return {
      ok: false,
      reason:
        "On an iPhone or iPad, notifications only work once ShiftSwitch is on your Home Screen.",
    };
  }
  if (support.kind === "unsupported") {
    return { ok: false, reason: "This browser cannot show notifications." };
  }
  if (support.kind === "denied") {
    return {
      ok: false,
      reason:
        "Notifications are blocked for this site in your browser settings. You will still see everything when you open ShiftSwitch.",
    };
  }

  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "No notifications, then — nothing else changes." };
  }

  const registration = await activeRegistration();
  if (!registration) {
    return {
      ok: false,
      reason: "Notifications could not start up on this device. Try again in a moment.",
    };
  }

  const serverKey = decodeVapidKey(vapidPublicKey);

  /* A subscription made against a *different* server key is worse than none:
     the browser hands it over happily and every send is refused, so the
     resident is subscribed and hears nothing. It happens for real whenever the
     keypair is regenerated. Drop it and make a new one. */
  let existing = await registration.pushManager.getSubscription();
  if (existing && !sameKey(existing.options.applicationServerKey, serverKey)) {
    try {
      await existing.unsubscribe();
    } catch {
      /* Keeping the stale one would be worse than a failed tidy-up. */
    }
    existing = null;
  }

  let subscription: PushSubscription;
  try {
    subscription =
      existing ??
      (await registration.pushManager.subscribe({
        /* Required by every browser: a push may only be sent if it results in a
           notification the user sees. We always show one, so this costs nothing
           and is what makes iOS deliver at all. */
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      }));
  } catch {
    /* Thrown rather than returned by every browser, and for causes a resident
       cannot distinguish. Left as one honest sentence rather than guessed at. */
    return {
      ok: false,
      reason: "Your browser would not set up notifications. Try again in a moment.",
    };
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, reason: "Your browser returned an incomplete subscription." };
  }

  const response = await fetch("/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installId: installId(),
      platform: "web",
      pushToken: json.endpoint,
      pushKeys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    }),
  });

  if (!response.ok) {
    return { ok: false, reason: "We could not save this device. Try again in a moment." };
  }
  return { ok: true };
}
