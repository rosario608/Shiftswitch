import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

/**
 * Native chrome: status bar, splash screen, keyboard behaviour and haptics.
 *
 * Every call is a no-op in the browser so the same code runs during local
 * development and in the component tests.
 */

const native = Capacitor.isNativePlatform();

export async function configureShell(): Promise<void> {
  if (!native) return;

  // Draw behind the status bar so the header reaches the top of the screen,
  // and match its foreground to the current colour scheme.
  await StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
  await applyStatusBarStyle();

  if (Capacitor.getPlatform() === "ios") {
    // Resize the webview rather than covering it, so the field being typed
    // into is never hidden behind the keyboard.
    await Keyboard.setResizeMode({ mode: KeyboardResize.Native }).catch(
      () => undefined,
    );
    await Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(
      () => undefined,
    );
  }
}

export async function applyStatusBarStyle(): Promise<void> {
  if (!native) return;
  const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches;
  await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(
    () => undefined,
  );
}

export async function hideSplash(): Promise<void> {
  if (!native) return;
  await SplashScreen.hide().catch(() => undefined);
}

/** A short tap for a completed action; silent where haptics are unavailable. */
export async function tapFeedback(): Promise<void> {
  if (!native) return;
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}

export async function successFeedback(): Promise<void> {
  if (!native) return;
  await Haptics.notification({ type: NotificationType.Success }).catch(
    () => undefined,
  );
}

export async function warningFeedback(): Promise<void> {
  if (!native) return;
  await Haptics.notification({ type: NotificationType.Warning }).catch(
    () => undefined,
  );
}
