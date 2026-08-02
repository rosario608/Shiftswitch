import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RoutingPushTransport,
  vapidKeysFromEnv,
  WebPushTransport,
} from "@/server/domain/web-push";
import { NoopPushTransport, type PushTarget } from "@/server/domain/push";
import { isApplePortable, decodeVapidKey } from "@/lib/web-push";

/**
 * Web push, the half that can be tested without a browser.
 *
 * Nothing here reaches a push service. What is asserted is the behaviour that
 * decides whether a resident is told something: which transport a device is
 * sent by, which failures permanently disable a subscription, and — the one
 * that costs a real person real notifications if it is wrong — whether an
 * iPhone is recognised as needing the site installed first.
 */

vi.mock("web-push", () => ({
  default: { sendNotification: vi.fn(), generateVAPIDKeys: vi.fn() },
}));

const keys = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.invalid" };

const webTarget: PushTarget = {
  deviceId: "d1",
  platform: "web",
  token: "https://push.example.invalid/abc",
  keys: { p256dh: "p", auth: "a" },
};

afterEach(() => {
  vi.clearAllMocks();
});

async function sendNotificationMock() {
  const webpush = (await import("web-push")).default as unknown as {
    sendNotification: ReturnType<typeof vi.fn>;
  };
  return webpush.sendNotification;
}

describe("reading the VAPID keypair", () => {
  it("is null unless both halves are present", () => {
    expect(vapidKeysFromEnv({})).toBeNull();
    expect(vapidKeysFromEnv({ VAPID_PUBLIC_KEY: "p" })).toBeNull();
    expect(vapidKeysFromEnv({ VAPID_PRIVATE_KEY: "s" })).toBeNull();
  });

  it("defaults the contact rather than refusing to send without one", () => {
    const parsed = vapidKeysFromEnv({ VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "s" });
    expect(parsed).toMatchObject({ publicKey: "p", privateKey: "s" });
    expect(parsed!.subject).toMatch(/^mailto:/);
  });
});

describe("sending to a browser", () => {
  it("reports sent when the push service accepts it", async () => {
    (await sendNotificationMock()).mockResolvedValue(undefined);
    const result = await new WebPushTransport(keys).send(webTarget, {
      title: "Somebody offered",
      body: "Tue, Aug 11 · MICU",
      category: "offers",
    });
    expect(result).toMatchObject({ deviceId: "d1", status: "sent" });
  });

  /* 404 and 410 are the push service saying the subscription is gone for good.
     Anything else might be one bad night, and disabling a resident's
     notifications for it would be silently permanent. */
  it.each([404, 410])("treats %i as permanently dead", async (statusCode) => {
    (await sendNotificationMock()).mockRejectedValue({ statusCode });
    const result = await new WebPushTransport(keys).send(webTarget, {
      title: "x",
      body: "y",
      category: "offers",
    });
    expect(result.status).toBe("failed");
    expect(result.permanentFailure).toBe(true);
    expect(result.errorCode).toBe(`http_${statusCode}`);
  });

  it.each([429, 500, 503])("treats %i as worth trying again", async (statusCode) => {
    (await sendNotificationMock()).mockRejectedValue({ statusCode });
    const result = await new WebPushTransport(keys).send(webTarget, {
      title: "x",
      body: "y",
      category: "offers",
    });
    expect(result.status).toBe("failed");
    expect(result.permanentFailure).toBe(false);
  });

  /* A web row with no keys cannot be encrypted to. Reporting it as sent would
     put a delivery in the log for a notification nobody could ever receive. */
  it("refuses a subscription with no keys rather than claiming delivery", async () => {
    const result = await new WebPushTransport(keys).send(
      { ...webTarget, keys: null },
      { title: "x", body: "y", category: "offers" },
    );
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("missing_subscription_keys");
    expect((await sendNotificationMock()).mock.calls).toHaveLength(0);
  });

  it("never puts the endpoint in the payload it sends", async () => {
    const send = await sendNotificationMock();
    send.mockResolvedValue(undefined);
    await new WebPushTransport(keys).send(webTarget, {
      title: "Somebody offered",
      body: "b",
      route: "/switches/1",
      category: "offers",
    });
    const payload = send.mock.calls[0][1] as string;
    expect(payload).not.toContain(webTarget.token);
    expect(JSON.parse(payload)).toMatchObject({ route: "/switches/1" });
  });
});

describe("choosing the road that reaches a device", () => {
  const web = { name: "webpush", configured: true, send: vi.fn() };
  const native = { name: "fcm", configured: true, send: vi.fn() };

  it("sends a browser by web push and a phone by the native service", async () => {
    web.send.mockResolvedValue({ deviceId: "d1", status: "sent" });
    native.send.mockResolvedValue({ deviceId: "d2", status: "sent" });
    const router = new RoutingPushTransport(web, native);

    await router.send(webTarget, { title: "x", body: "y", category: "offers" });
    expect(web.send).toHaveBeenCalledTimes(1);
    expect(native.send).toHaveBeenCalledTimes(0);

    await router.send(
      { deviceId: "d2", platform: "ios", token: "tok" },
      { title: "x", body: "y", category: "offers" },
    );
    expect(native.send).toHaveBeenCalledTimes(1);
  });

  /* The delivery row has to name the service that actually answered, or "did
     Apple accept it" becomes unanswerable and every row says "routing". */
  it("records which service answered, not the router", async () => {
    web.send.mockResolvedValue({ deviceId: "d1", status: "sent" });
    const result = await new RoutingPushTransport(web, native).send(webTarget, {
      title: "x",
      body: "y",
      category: "offers",
    });
    expect(result.provider).toBe("webpush");
  });

  /* Configuring one half is the normal case, not an edge: a programme on the
     website has VAPID keys and no Firebase project. */
  it("is configured when either half is", () => {
    const noop = new NoopPushTransport();
    expect(new RoutingPushTransport(web, noop).configured).toBe(true);
    expect(new RoutingPushTransport(noop, native).configured).toBe(true);
    expect(new RoutingPushTransport(noop, noop).configured).toBe(false);
  });

  it("reports skipped, never sent, for a device whose road is not built", async () => {
    const result = await new RoutingPushTransport(
      new NoopPushTransport(),
      native,
    ).send(webTarget, { title: "x", body: "y", category: "offers" });
    expect(result.status).toBe("skipped");
    expect(result.errorCode).toBe("not_configured");
  });
});

describe("recognising a device that must install the site first", () => {
  /* Safari delivers push only to an installed site. Getting this wrong in
     either direction has a cost: a missed iPhone is a resident who is never
     notified and does not know it; a false positive tells an Android user to
     do something impossible. */
  it("recognises iPhone and iPad", () => {
    expect(isApplePortable("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", 5)).toBe(
      true,
    );
    expect(isApplePortable("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", 5)).toBe(true);
  });

  /* An iPadOS 13+ iPad reports itself as a Mac. Touch points are the only
     thing that gives it away. */
  it("recognises an iPad pretending to be a desktop Mac", () => {
    expect(isApplePortable("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
  });

  it("does not mistake a real Mac or an Android phone for one", () => {
    expect(isApplePortable("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isApplePortable("Mozilla/5.0 (Linux; Android 14; Pixel 7)", 5)).toBe(false);
  });
});

describe("decoding the server key a browser subscribes with", () => {
  it("turns base64url into the bytes the Push API wants", () => {
    const decoded = decodeVapidKey("BEl-_wcQ");
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBeGreaterThan(0);
    /* `-` and `_` are base64url's substitutions; decoding them as literal
       characters produces a key the browser rejects with an opaque error. */
    expect(decodeVapidKey("BEl-_wcQ")).toEqual(decodeVapidKey("BEl+/wcQ"));
  });
});
