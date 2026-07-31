import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor configuration.
 *
 * Note what is NOT here: a `server.url`. The app loads the compiled client from
 * `webDir` inside the app package. Pointing it at a website would make this a
 * wrapper around a web page — rejected under App Store guideline 4.2, and worse
 * for the user, since none of it would work without a connection.
 *
 * The bundle identifier below is a placeholder. Before the first store upload,
 * replace it with an identifier under a domain you control and register the
 * same value in App Store Connect and the Play Console — see
 * docs/MOBILE_RELEASE.md. Changing it after publication is not possible.
 */
const config: CapacitorConfig = {
  appId: "org.shiftswitch.app",
  appName: "ShiftSwitch",
  webDir: "dist",

  android: {
    // The bundled app is served over https://localhost (Capacitor's default
    // androidScheme), which gives the webview a secure origin — crypto.subtle,
    // used for PKCE, is unavailable without one.
    allowMixedContent: false,
    captureInput: true,
  },

  ios: {
    contentInset: "always",
    limitsNavigationsToAppBoundDomains: true,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: true,
      backgroundColor: "#0f172a",
      androidSplashResourceName: "splash",
      showSpinner: false,
    },
    PushNotifications: {
      // The badge is cleared by the app when it comes to the foreground.
      presentationOptions: ["badge", "sound", "alert"],
    },
    Keyboard: {
      resizeOnFullScreen: true,
    },
  },
};

export default config;
