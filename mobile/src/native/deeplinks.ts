import { API_URL, APP_SCHEME } from "@/config";

/**
 * Turning an incoming URL into a route.
 *
 * Two kinds arrive:
 *  - `https://<app host>/switches/<id>` from a universal link / App Link,
 *    which is what an email or a message from a colleague contains;
 *  - `shiftswitch://…` from the sign-in callback and from older links.
 *
 * Anything that is not a route this app owns returns null, and the caller
 * leaves the user where they are rather than navigating somewhere arbitrary.
 *
 * ## `/trades` still resolves, and always will
 *
 * The screens were renamed when the product settled on one word for the
 * exchange, but links are not in this repository — they are in push
 * notifications already delivered, in emails already sent, and in messages
 * residents forwarded to each other. Those keep working: an old `/trades/<id>`
 * is rewritten to `/switches/<id>` rather than refused. A dead link is a dead
 * end, and this is a two-line map.
 */

const ROUTE_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/schedule$/,
  /^\/schedule\/[0-9a-f-]{36}$/i,
  /^\/switches$/,
  /^\/switches\/[0-9a-f-]{36}$/i,
  /^\/switches\/done\/[0-9a-f-]{36}$/i,
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
    // shiftswitch://switches/<id> parses with "switches" as the host.
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
  // presents the same queue at /approvals. And every link sent before the
  // rename still points at /trades.
  const normalised =
    path === "/admin/approvals"
      ? "/approvals"
      : path.replace(/^\/trades(?=$|\/)/, "/switches");
  return ROUTE_PATTERNS.some((pattern) => pattern.test(normalised))
    ? normalised
    : null;
}
