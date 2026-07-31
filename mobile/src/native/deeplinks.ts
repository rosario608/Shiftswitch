import { API_URL, APP_SCHEME } from "@/config";

/**
 * Turning an incoming URL into a route.
 *
 * Two kinds arrive:
 *  - `https://<app host>/trades/<id>` from a universal link / App Link, which
 *    is what an email or a message from a colleague contains;
 *  - `shiftswitch://…` from the sign-in callback and from older links.
 *
 * Anything that is not a route this app owns returns null, and the caller
 * leaves the user where they are rather than navigating somewhere arbitrary.
 */

const ROUTE_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/schedule$/,
  /^\/schedule\/[0-9a-f-]{36}$/i,
  /^\/trades$/,
  /^\/trades\/[0-9a-f-]{36}$/i,
  /^\/switches\/[0-9a-f-]{36}$/i,
  /^\/approvals$/,
  /^\/notifications$/,
  /^\/profile$/,
  /^\/settings$/,
];

export function routeFromUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol === `${APP_SCHEME}:`) {
    // shiftswitch://trades/<id> parses with "trades" as the host.
    const path = `/${[url.host, url.pathname.replace(/^\//, "")]
      .filter(Boolean)
      .join("/")}`.replace(/\/+$/, "");
    return matchRoute(path || "/");
  }

  const apiOrigin = safeOrigin(API_URL);
  if (apiOrigin && url.origin !== apiOrigin) return null;
  return matchRoute(url.pathname.replace(/\/+$/, "") || "/");
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function matchRoute(path: string): string | null {
  // The web app's chief approvals live under /admin/approvals; the native app
  // presents the same queue at /approvals.
  const normalised = path === "/admin/approvals" ? "/approvals" : path;
  return ROUTE_PATTERNS.some((pattern) => pattern.test(normalised))
    ? normalised
    : null;
}
