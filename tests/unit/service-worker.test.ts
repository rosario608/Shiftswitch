import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The service worker's own rules, exercised rather than read.
 *
 * `public/sw.js` is the one file in this repository that cannot be imported,
 * type-checked or reached by the end-to-end suite — it only registers in a
 * production build, and the browser runs it in a scope no test drives. So it is
 * loaded here as source and given a fake worker global, which is the only way
 * to actually run the two rules that matter:
 *
 * - a **mutation** is never touched, never cached, never queued;
 * - a **page** may be cached, but only stamped with the moment it was stored,
 *   because `StaleBanner` reads that stamp and a page without one would be
 *   presented to a resident as if it were current.
 */

/** What the worker actually reads off a request. Node refuses to construct a
    `Request` with `mode: "navigate"` — the spec reserves it for browsers — so
    the worker is driven with the shape it uses rather than the class. */
interface WorkerRequest {
  url: string;
  method: string;
  mode?: string;
}

interface FetchEvent {
  request: WorkerRequest;
  respondWith: (value: Promise<Response> | Response) => void;
  waitUntil: (value: Promise<unknown>) => void;
}

type Listener = (event: FetchEvent) => void;

/** A `CacheStorage` good enough to be wrong in the ways that matter. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return {
      put: async (request: WorkerRequest | string, response: Response) => {
        store.set(typeof request === "string" ? request : request.url, response);
      },
      addAll: async () => undefined,
      match: async (request: WorkerRequest | string) =>
        store.get(typeof request === "string" ? request : request.url),
    };
  };
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (
      request: WorkerRequest | string,
      options?: { cacheName?: string },
    ): Promise<Response | undefined> => {
      const url = typeof request === "string" ? request : request.url;
      const named = options?.cacheName ? [stores.get(options.cacheName)] : [...stores.values()];
      for (const store of named) {
        const hit = store?.get(url);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

const ORIGIN = "https://shiftswitch.test";

function load(networkFetch: (request: WorkerRequest) => Promise<Response>) {
  const listeners = new Map<string, Listener>();
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    location: { origin: ORIGIN },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
  };
  const caches = fakeCaches();
  const source = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
  new Function("self", "caches", "fetch", source)(self, caches, networkFetch);
  return { listeners, caches };
}

/** Drives one fetch event and returns what the worker did, if anything. */
async function dispatch(
  listeners: Map<string, Listener>,
  request: WorkerRequest,
): Promise<{ handled: boolean; response?: Response }> {
  const listener = listeners.get("fetch")!;
  let responded: Promise<Response> | Response | undefined;
  const waits: Promise<unknown>[] = [];
  listener({
    request,
    respondWith: (value) => {
      responded = value;
    },
    waitUntil: (value) => void waits.push(value),
  });
  if (responded === undefined) {
    await Promise.all(waits);
    return { handled: false };
  }
  const response = await responded;
  await Promise.all(waits);
  return { handled: true, response };
}

function navigation(path: string): WorkerRequest {
  return { url: `${ORIGIN}${path}`, method: "GET", mode: "navigate" };
}

const CAPTURED_AT = "x-shiftswitch-cached-at";

let online: boolean;

const network = async (request: WorkerRequest): Promise<Response> => {
  if (!online) throw new TypeError("Failed to fetch");
  return new Response(`<html>${new URL(request.url).pathname}</html>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
};

beforeEach(() => {
  online = true;
});

describe("a mutation", () => {
  it("is not touched at all, online or off", async () => {
    /* The worst thing this worker could do is make a write look like it
       succeeded. It cannot, because it never sees one: the handler returns
       before anything else for a method that is not GET, so the request goes
       to the network and `apiFetch` decides what to say about it. */
    const { listeners } = load(network);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const result = await dispatch(
        listeners,
        { url: `${ORIGIN}/api/trades/abc/accept`, method },
      );
      expect(result.handled, `${method} was intercepted`).toBe(false);
    }

    online = false;
    const offlinePost = await dispatch(
      listeners,
      { url: `${ORIGIN}/api/trades/abc/accept`, method: "POST" },
    );
    expect(offlinePost.handled).toBe(false);
  });
});

describe("API traffic", () => {
  it("is never cached, so an offline read cannot look like a live one", async () => {
    const { listeners, caches } = load(network);
    const result = await dispatch(listeners, {
      url: `${ORIGIN}/api/schedule`,
      method: "GET",
    });
    expect(result.handled).toBe(false);

    for (const store of caches.stores.values()) {
      expect([...store.keys()].filter((key) => key.includes("/api/"))).toEqual([]);
    }
  });
});

describe("a page a resident might need without a signal", () => {
  it("is served from the network and stored with the moment it was captured", async () => {
    const before = Date.now();
    const { listeners, caches } = load(network);

    const result = await dispatch(listeners, navigation("/schedule"));
    expect(result.handled).toBe(true);
    expect(await result.response!.text()).toContain("/schedule");

    const stored = await caches.match(`${ORIGIN}/schedule`, {
      cacheName: "shiftswitch-pages-v2",
    });
    expect(stored, "the page was not stored").toBeDefined();

    /* The stamp is the whole point. A cached page without one would be shown
       to a resident with no way to say how old it is. */
    const stamp = stored!.headers.get(CAPTURED_AT);
    expect(stamp).toBeTruthy();
    expect(new Date(stamp!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("comes back, labelled, when the network is gone", async () => {
    const { listeners } = load(network);
    await dispatch(listeners, navigation("/schedule"));

    online = false;
    const offline = await dispatch(listeners, navigation("/schedule"));
    expect(offline.handled).toBe(true);
    expect(await offline.response!.text()).toContain("/schedule");
    expect(offline.response!.headers.get(CAPTURED_AT)).toBeTruthy();
  });

  it("is refreshed from the network whenever there is one", async () => {
    /* Network first, not cache first. A resident with signal must never be
       shown yesterday's schedule because it was quicker to reach. */
    const seen: string[] = [];
    const { listeners } = load(async (request) => {
      seen.push(request.url);
      return network(request);
    });
    await dispatch(listeners, navigation("/schedule"));
    await dispatch(listeners, navigation("/schedule"));
    expect(seen).toHaveLength(2);
  });
});

describe("a page nobody should be reading offline", () => {
  it("is not stored — the admin area is not a resident's last known schedule", async () => {
    const { listeners, caches } = load(network);
    await dispatch(listeners, navigation("/admin/scheduler"));

    const stored = await caches.match(`${ORIGIN}/admin/scheduler`, {
      cacheName: "shiftswitch-pages-v2",
    });
    expect(stored).toBeUndefined();

    online = false;
    const offline = await dispatch(listeners, navigation("/admin/scheduler"));
    expect(offline.handled).toBe(true);
    // Falls through to the offline page rather than inventing an admin screen.
    expect(offline.response!.type === "error" || offline.response!.status >= 400).toBe(true);
  });
});

describe("a foreign origin", () => {
  it("is left alone entirely", async () => {
    const { listeners } = load(network);
    const result = await dispatch(
      listeners,
      {
        url: "https://accounts.google.com/o/oauth2/v2/auth",
        method: "GET",
        mode: "navigate",
      },
    );
    expect(result.handled).toBe(false);
  });
});

describe("install and activate", () => {
  it("drops caches from an older version rather than leaving them to be matched", async () => {
    /* The version suffix is how a shipped fix actually reaches a phone. A stale
       `v1` page cache left behind would keep serving pre-fix HTML forever. */
    const { listeners, caches } = load(network);
    await caches.open("shiftswitch-static-v1");
    await caches.open("shiftswitch-pages-v1");

    const activate = listeners.get("activate") as unknown as (event: {
      waitUntil: (value: Promise<unknown>) => void;
    }) => void;
    const waits: Promise<unknown>[] = [];
    activate({ waitUntil: (value) => void waits.push(value) });
    await Promise.all(waits);

    expect([...caches.stores.keys()].filter((key) => key.endsWith("-v1"))).toEqual([]);
  });
});

describe("the file itself", () => {
  it("still refuses API traffic by pathname, which the e2e suite also checks", () => {
    const source = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
    expect(source).toContain('url.pathname.startsWith("/api/")');
  });

  it("registers no handler that could replay a request later", () => {
    /* `sync` and `periodicsync` are how a well-meaning change would add an
       offline queue, which is the one thing this worker must never grow. */
    const source = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
    expect(source).not.toContain('addEventListener("sync"');
    expect(source).not.toContain('addEventListener("periodicsync"');
  });
});
