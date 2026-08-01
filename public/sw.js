/**
 * ShiftSwitch service worker.
 *
 * ## What changed, and why
 *
 * This used to cache the static shell and nothing else, on the grounds that
 * "stale schedule data must never be shown as if it were authoritative". That
 * is right about the danger and wrong about the remedy. A resident standing on
 * a ward with no signal got the offline page and **nothing at all** — not even
 * the shift they had been looking at four minutes earlier, which is the one
 * they opened the app to check.
 *
 * The words that matter in the original are *as if it were authoritative*. The
 * answer is to show it and **say what it is**: the last known schedule, stamped
 * with when it was captured, with every control that would change something
 * disabled. `StaleBanner` in the app does the labelling; this makes the page
 * available to label.
 *
 * ## The rules that did not change
 *
 * **A mutation is never served from a cache, and never queued.** Only `GET` is
 * touched at all. A write that appears to succeed while offline is the single
 * worst thing this worker could do — a resident would walk away believing they
 * had given away a shift.
 *
 * **API responses are still never cached.** The client fetches through
 * `apiFetch`, which must fail honestly when there is no network; a cached
 * `200` there would make an offline read indistinguishable from a live one.
 * What is cached is the *rendered page*, which the app can date and label.
 */
const SHELL_CACHE = "shiftswitch-static-v2";
const PAGE_CACHE = "shiftswitch-pages-v2";
const SHELL = ["/offline", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];

/** Pages worth having when there is no signal. A resident's own, not the admin area. */
const CACHEABLE = ["/", "/schedule", "/trades", "/notifications", "/profile"];

/** Header the app reads to know it is looking at something old. */
const CAPTURED_AT = "x-shiftswitch-cached-at";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== PAGE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Stamps a response with the moment it was stored, so the app can say when. */
async function storePage(request, response) {
  const body = await response.clone().blob();
  const headers = new Headers(response.headers);
  headers.set(CAPTURED_AT, new Date().toISOString());
  const cache = await caches.open(PAGE_CACHE);
  await cache.put(
    request,
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  /* Everything below is read-only, deliberately. A POST is never cached, never
     replayed and never queued: offline, `apiFetch` refuses it before it is
     sent, and the resident is told it did not happen. */
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API traffic or authentication. See the note at the top.
  if (url.pathname.startsWith("/api/")) return;

  // Static build assets: cache-first (they are content-hashed).
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          /* Network first, always: the live schedule is the authoritative one
             and a resident with signal must never see anything else. The copy
             is only a fallback for when there is no signal at all. */
          if (response.ok && CACHEABLE.includes(url.pathname)) {
            event.waitUntil(storePage(request, response));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request, { cacheName: PAGE_CACHE });
          if (cached) return cached;
          const offline = await caches.match("/offline", { cacheName: SHELL_CACHE });
          return offline || Response.error();
        }),
    );
  }
});
