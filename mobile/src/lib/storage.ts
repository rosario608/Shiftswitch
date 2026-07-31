import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { Capacitor } from "@capacitor/core";

/**
 * Where the session token lives.
 *
 * On a device this is the iOS Keychain / Android EncryptedSharedPreferences, so
 * the token is protected at rest by the platform and is not readable from a
 * backup of app data. In the browser (used only for local development of this
 * client) it falls back to sessionStorage, which is deliberately weaker and
 * deliberately not persisted across tabs.
 */

const native = Capacitor.isNativePlatform();

export async function secureGet(key: string): Promise<string | null> {
  if (!native) return globalThis.sessionStorage?.getItem(key) ?? null;
  try {
    return await SecureStorage.getItem(key);
  } catch {
    // A corrupted or unreadable keychain entry means "not signed in", not a
    // crash on launch.
    return null;
  }
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (!native) {
    globalThis.sessionStorage?.setItem(key, value);
    return;
  }
  await SecureStorage.setItem(key, value);
}

export async function secureRemove(key: string): Promise<void> {
  if (!native) {
    globalThis.sessionStorage?.removeItem(key);
    return;
  }
  try {
    await SecureStorage.removeItem(key);
  } catch {
    // Removing something that is not there is not an error worth surfacing.
  }
}

/**
 * Non-sensitive values that should survive reinstall-free restarts: the
 * install id, whether we have already explained why we want to send
 * notifications. localStorage is backed by the webview's own store inside the
 * app sandbox.
 */
export function localGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function localSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // A full or disabled store is not worth failing a screen over.
  }
}

export const STORAGE_KEYS = {
  sessionToken: "shiftswitch.session.token",
  sessionExpiry: "shiftswitch.session.expires",
  installId: "shiftswitch.install.id",
  pushPrimed: "shiftswitch.push.primed",
  pushToken: "shiftswitch.push.token",
} as const;

/** A stable per-installation identifier. Not a device or advertising id. */
export function installId(): string {
  const existing = localGet(STORAGE_KEYS.installId);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  localSet(STORAGE_KEYS.installId, generated);
  return generated;
}
