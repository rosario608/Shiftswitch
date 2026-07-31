import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { Device } from "@capacitor/device";
import { App } from "@capacitor/app";
import { api } from "@/api/client";
import { APP_VERSION } from "@/config";
import { STORAGE_KEYS, installId, localGet, localSet } from "@/lib/storage";

/**
 * Push notifications.
 *
 * The permission prompt is never shown on launch. The app first explains, in
 * its own screen, what it will send and why — a resident who declines the
 * system prompt cannot be asked again, so asking cold wastes the one chance
 * and is exactly the pattern App Review flags. `primePush()` is called only
 * from a control the user tapped.
 *
 * The device row is registered whether or not push is granted: the server
 * needs to know this installation exists so signing out can revoke it, and so
 * a token can be attached later if the resident changes their mind in
 * Settings.
 */

export type PushPermission = "granted" | "denied" | "prompt" | "unsupported";

const native = Capacitor.isNativePlatform();

let currentToken: string | null = localGet(STORAGE_KEYS.pushToken);
let listenersAttached = false;

/** Where a tapped notification should take the user. */
export type RouteHandler = (route: string) => void;

let routeHandler: RouteHandler = () => {};

export function setPushRouteHandler(handler: RouteHandler): void {
  routeHandler = handler;
}

async function describeDevice() {
  const platform = Capacitor.getPlatform();
  const info = native ? await Device.getInfo().catch(() => null) : null;
  return {
    installId: installId(),
    platform: (platform === "ios" || platform === "android"
      ? platform
      : "web") as "ios" | "android" | "web",
    appVersion: APP_VERSION,
    osVersion: info ? `${info.operatingSystem} ${info.osVersion}` : undefined,
    model: info?.model,
  };
}

/**
 * Tells the server about this installation, including the push token if we
 * have one. Safe to call repeatedly; the server upserts on (user, install id).
 */
export async function registerDevice(): Promise<void> {
  try {
    const device = await describeDevice();
    await api.post("/api/devices", { ...device, pushToken: currentToken });
  } catch {
    // Never block a screen on device registration — the next launch retries.
  }
}

export async function unregisterDevice(): Promise<void> {
  const id = installId();
  await api.delete(`/api/devices?installId=${encodeURIComponent(id)}`);
  if (native) await PushNotifications.unregister().catch(() => undefined);
  currentToken = null;
  localSet(STORAGE_KEYS.pushToken, "");
}

export async function permissionState(): Promise<PushPermission> {
  if (!native) return "unsupported";
  try {
    const status = await PushNotifications.checkPermissions();
    if (status.receive === "granted") return "granted";
    if (status.receive === "denied") return "denied";
    return "prompt";
  } catch {
    return "unsupported";
  }
}

/** True once the in-app explanation has been shown and accepted. */
export function hasBeenPrimed(): boolean {
  return localGet(STORAGE_KEYS.pushPrimed) === "true";
}

export function markPrimed(): void {
  localSet(STORAGE_KEYS.pushPrimed, "true");
}

/**
 * Asks the operating system for permission and, if granted, registers with
 * APNs/FCM. Call this only in response to a deliberate user action.
 */
export async function primePush(): Promise<PushPermission> {
  markPrimed();
  if (!native) return "unsupported";

  const existing = await PushNotifications.checkPermissions();
  const status =
    existing.receive === "prompt" || existing.receive === "prompt-with-rationale"
      ? await PushNotifications.requestPermissions()
      : existing;

  if (status.receive !== "granted") {
    return status.receive === "denied" ? "denied" : "prompt";
  }
  await PushNotifications.register();
  return "granted";
}

/**
 * Attaches the push listeners. Called once at start-up, before any screen
 * mounts, so a notification that launched the app is not missed.
 */
export async function initPush(): Promise<void> {
  if (!native || listenersAttached) return;
  listenersAttached = true;

  // Android needs an explicit channel or notifications arrive silently.
  await PushNotifications.createChannel({
    id: "shiftswitch-trades",
    name: "Switch activity",
    description: "Offers, approvals and completed switches.",
    importance: 4,
    visibility: 1,
  }).catch(() => undefined);

  await PushNotifications.addListener("registration", (token) => {
    currentToken = token.value;
    localSet(STORAGE_KEYS.pushToken, token.value);
    void registerDevice();
  });

  await PushNotifications.addListener("registrationError", () => {
    // The device simply will not receive push. In-app notifications still
    // work, and Settings shows the real state rather than claiming success.
    currentToken = null;
  });

  await PushNotifications.addListener(
    "pushNotificationActionPerformed",
    (action) => {
      const route = action.notification.data?.route;
      if (typeof route === "string" && route.startsWith("/")) {
        routeHandler(route);
      }
    },
  );

  // Clear the badge whenever the app comes to the foreground.
  await App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      void PushNotifications.removeAllDeliveredNotifications().catch(
        () => undefined,
      );
    }
  });

  // If permission was granted in a previous session, re-register silently so a
  // rotated token reaches the server.
  const state = await permissionState();
  if (state === "granted") {
    await PushNotifications.register().catch(() => undefined);
  }
}

/**
 * How to re-enable notifications once the system prompt has been declined.
 *
 * There is no supported way to open another app's notification settings from
 * a web view on Android, and adding a plugin to do it on iOS alone would give
 * one platform a button the other cannot have. The app tells the user exactly
 * where to go instead of offering a control that does nothing.
 */
export function settingsInstructions(): string {
  switch (Capacitor.getPlatform()) {
    case "ios":
      return "Open the Settings app, choose Notifications, find ShiftSwitch and turn Allow Notifications on.";
    case "android":
      return "Open Settings, choose Notifications (or Apps → ShiftSwitch → Notifications) and turn notifications on for ShiftSwitch.";
    default:
      return "Enable notifications for ShiftSwitch in your device settings.";
  }
}
