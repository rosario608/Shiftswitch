import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/lib/api-client";
import { scrubRoute } from "@/lib/report-client-error";
import { formatCaptured } from "@/components/app/stale-banner";

/**
 * What the product says when the network is against it.
 *
 * The distinction under test is the one hospital wifi produces constantly and
 * the one this product used to get wrong: **not sent** and **we don't know**
 * are different facts, and telling a resident the second is the first is how
 * somebody accepts the same switch twice.
 */

const originalNavigator = globalThis.navigator;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
  });
});

function setOnline(online: boolean) {
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: online },
    configurable: true,
  });
}

describe("a mutation attempted while the phone knows it is offline", () => {
  it("is refused before anything is sent, and says so with certainty", async () => {
    setOnline(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const error = (await apiFetch("/api/switches", { method: "POST", body: "{}" }).catch(
      (caught) => caught,
    )) as ApiError;

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("offline");
    /* Certain, and the wording says so. Nothing left the phone. */
    expect(error.delivery).toBe("no");
    expect(error.uncertain).toBe(false);
    expect(error.message).toMatch(/didn't happen/i);
    expect(error.message).toMatch(/nothing has changed/i);
  });
});

describe("a mutation whose connection drops mid-flight", () => {
  it("refuses to claim it failed, because it may not have", async () => {
    setOnline(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    const error = (await apiFetch("/api/offers/x/accept", { method: "POST" }).catch(
      (caught) => caught,
    )) as ApiError;

    expect(error.code).toBe("network");
    /* The whole point. The request left; nothing came back. The switch may
       have completed, and asserting either way would be a coin flip presented
       as a fact. */
    expect(error.delivery).toBe("unknown");
    expect(error.uncertain).toBe(true);
    expect(error.message).toMatch(/may or may not have gone through/i);
    /* And it points at the way to find out, rather than at "try again" — which
       is what a resident would otherwise do to a switch that already
       completed. */
    expect(error.message).toMatch(/refresh/i);
  });

  it("keeps the simple wording for a read, which has no ambiguity", async () => {
    setOnline(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    const error = (await apiFetch("/api/dashboard").catch((caught) => caught)) as ApiError;
    expect(error.uncertain).toBe(false);
    expect(error.message).toMatch(/couldn't reach/i);
  });
});

describe("a server that answers", () => {
  it("is certain: the answer is the truth, and nothing happened", async () => {
    setOnline(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "conflict", message: "That shift was already taken.", requestId: "k9mq2p" },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    const error = (await apiFetch("/api/offers/x/accept", { method: "POST" }).catch(
      (caught) => caught,
    )) as ApiError;

    expect(error.code).toBe("conflict");
    expect(error.delivery).toBe("no");
    expect(error.uncertain).toBe(false);
    /* The six characters that find this in the logs, carried from the server's
       envelope to somewhere a resident can read them. */
    expect(error.requestId).toBe("k9mq2p");
  });

  it("takes the request id from the header when the body has none", async () => {
    setOnline(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("{}", { status: 500, headers: { "x-request-id": "abc123" } }),
        ),
      ),
    );
    const error = (await apiFetch("/api/dashboard").catch((caught) => caught)) as ApiError;
    expect(error.requestId).toBe("abc123");
  });
});

describe("what a crash report may say about where it happened", () => {
  it("replaces a trade id with its shape", () => {
    expect(scrubRoute("/switches/9f2c8a1e-4b3d-4c5e-8f7a-1b2c3d4e5f6a")).toBe(
      "/switches/:id",
    );
  });

  it("replaces an invitation token", () => {
    expect(scrubRoute("/invite/kR3m9QpZ2xLvB8nT4wYs")).toBe("/invite/:token");
  });

  it("keeps the shape, which is the part worth grouping crashes by", () => {
    expect(scrubRoute("/admin/scheduler/9f2c8a1e-4b3d-4c5e-8f7a-1b2c3d4e5f6a/build")).toBe(
      "/admin/scheduler/:id/build",
    );
  });

  it("leaves an ordinary route alone", () => {
    expect(scrubRoute("/admin/coverage")).toBe("/admin/coverage");
  });
});

describe("how a page served from the cache is labelled", () => {
  /* The label is the whole safety argument for caching a schedule at all. A
     resident deciding whether to trust what is on screen needs the *fact* —
     four minutes old is fine for checking which ward you are on tonight,
     eleven hours old is not — and only they can make that call. */
  const at = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it("says less than a minute rather than 0 minutes", () => {
    expect(formatCaptured(at(0))).toMatch(/^less than a minute ago, at /);
  });

  it("counts minutes, singular and plural", () => {
    expect(formatCaptured(at(1))).toMatch(/^1 minute ago, at /);
    expect(formatCaptured(at(37))).toMatch(/^37 minutes ago, at /);
  });

  it("rounds to hours once minutes stop being useful", () => {
    expect(formatCaptured(at(3 * 60))).toMatch(/^about 3 hours ago, at /);
  });

  it("names the day once it is yesterday's schedule", () => {
    /* The case that matters most: an overnight resident opening the app at
       07:00 on a phone that has had no signal since the previous evening. "14
       hours ago" is easy to misread as this morning; a weekday name is not. */
    const label = formatCaptured(at(30 * 60));
    expect(label).toMatch(/^on \w{3}, /);
  });

  it("says nothing rather than guessing when the stamp is unreadable", () => {
    /* An empty string is what makes the banner fall back to "ShiftSwitch can't
       tell how old this is", which is honest. Inventing a plausible time here
       would be the single worst bug this component could have. */
    expect(formatCaptured("not a date")).toBe("");
    expect(formatCaptured("")).toBe("");
  });
});
