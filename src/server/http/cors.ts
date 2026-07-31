/**
 * Cross-origin access for the native app.
 *
 * The Capacitor webview serves the bundled app from `capacitor://localhost`
 * (iOS) or `https://localhost` (Android), so every API call it makes is
 * cross-origin. Those two origins are allowed explicitly; the list is never a
 * wildcard, and `Access-Control-Allow-Credentials` is never sent — the native
 * client authenticates with a bearer token, so a permissive cookie policy would
 * add risk for no benefit.
 *
 * The browser app is same-origin and is unaffected by any of this.
 */

const DEFAULT_NATIVE_ORIGINS = [
  "capacitor://localhost",
  "https://localhost",
  "ionic://localhost",
];

/** Extra origins (comma separated) for local development of the mobile app. */
function configuredOrigins(): string[] {
  return (process.env.MOBILE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function allowedOrigins(): string[] {
  return [...DEFAULT_NATIVE_ORIGINS, ...configuredOrigins()];
}

export function isAllowedOrigin(origin: string | null): origin is string {
  return Boolean(origin) && allowedOrigins().includes(origin as string);
}

export const CORS_ALLOWED_HEADERS = "content-type, authorization";
export const CORS_ALLOWED_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
