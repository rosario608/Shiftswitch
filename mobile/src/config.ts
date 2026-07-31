/**
 * Build-time configuration.
 *
 * Everything here is baked into the bundle by Vite. `vite.config.ts` refuses to
 * produce a production build unless the API URL is a non-local https origin, so
 * a store binary cannot be pointed at a development server by accident.
 */

const rawApiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const API_URL = rawApiUrl.replace(/\/$/, "");

export const APP_SCHEME = import.meta.env.VITE_APP_SCHEME ?? "shiftswitch";

export const ENVIRONMENT = (import.meta.env.VITE_ENVIRONMENT ?? "development") as
  | "development"
  | "staging"
  | "production";

export const IS_PRODUCTION = ENVIRONMENT === "production";

/**
 * The password-free local sign-in used by the end-to-end tests. It is compiled
 * out of production builds entirely, and the server rejects it unless
 * ALLOW_TEST_LOGIN is set there too — both sides must agree.
 */
export const ALLOW_TEST_LOGIN =
  !IS_PRODUCTION && import.meta.env.VITE_ALLOW_TEST_LOGIN === "true";

/** Shown in Settings so a bug report can name the exact build. */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? "1.0.0";

export const SUPPORT_EMAIL =
  import.meta.env.VITE_SUPPORT_EMAIL ?? "support@shiftswitch.app";

export const PRIVACY_URL = `${API_URL}/legal/privacy`;
export const TERMS_URL = `${API_URL}/legal/terms`;
