import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import {
  createHandoffCode,
  pkceChallengeFromVerifier,
  redeemHandoffCode,
} from "@/server/auth/native";
import { resolveSessionByToken } from "@/server/auth/session";
import {
  deleteOwnAccount,
  ensureCalendarFeed,
  findUserForIdentity,
  linkIdentity,
  previewAccountDeletion,
  resolveCalendarFeed,
  revokeCalendarFeed,
  rotateCalendarFeed,
} from "@/server/domain/account";
import { buildCalendar } from "@/server/domain/calendar";
import {
  registerDevice,
  sendPush,
  setPushTransport,
  sendSelfTestPush,
  NoopPushTransport,
  unregisterDevice,
  type PushMessage,
  type PushResult,
  type PushTarget,
  type PushTransport,
} from "@/server/domain/push";
import { countUnread, notify, routeFor } from "@/server/domain/notifications";
import {
  setPreference,
  setQuietHours,
} from "@/server/domain/notification-preferences";
import { acceptOffer, createOffer, postShiftForTrade } from "@/server/domain/trades";
import { listResidentSchedule } from "@/server/domain/schedule";
import { instantToZonedParts } from "@/server/domain/time";
import { withTransaction } from "@/server/db/pool";
import {
  closeDatabase,
  createProgram,
  createResident,
  createShift,
  ensureMigrated,
  resetDatabase,
  type TestProgram,
  type TestResident,
} from "./helpers";

/** Records everything it is asked to send, so dispatch can be asserted. */
class RecordingTransport implements PushTransport {
  readonly name = "recording";
  readonly configured = true;
  sent: Array<{ target: PushTarget; message: PushMessage }> = [];
  nextResult: Partial<PushResult> = {};

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    this.sent.push({ target, message });
    return { deviceId: target.deviceId, status: "sent", ...this.nextResult };
  }
}

/**
 * `notify` inside a transaction, so the push it queues is awaited.
 *
 * Outside a transaction `afterCommit` is fire-and-forget by design — a push
 * must never make a caller wait — which means a test asserting on the
 * transport straight afterwards is racing it. Committing is what flushes the
 * queue, and it is also what production does: every notification the product
 * sends is written inside the transaction that caused it.
 */
async function notifyAndFlush(input: Parameters<typeof notify>[0]) {
  await withTransaction((client) => notify(input, client));
}

let fixture: TestProgram;
let alice: TestResident;
let bob: TestResident;
let transport: RecordingTransport;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  setPushTransport(null);
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram();
  alice = await createResident(fixture.program, {
    email: "alice@hospital.org",
    name: "Alice Adeyemi",
    pgy: 2,
  });
  bob = await createResident(fixture.program, {
    email: "bob@hospital.org",
    name: "Bob Brennan",
    pgy: 2,
  });
  transport = new RecordingTransport();
  setPushTransport(transport);
});

afterEach(() => {
  setPushTransport(null);
});

describe("native sign-in handoff", () => {
  const verifier = "verifier-".padEnd(60, "x");

  it("exchanges a one-time code for a working session", async () => {
    const code = await createHandoffCode(
      alice.user.id,
      pkceChallengeFromVerifier(verifier),
    );
    const session = await redeemHandoffCode(code, verifier);
    expect(session.userId).toBe(alice.user.id);

    const context = await resolveSessionByToken(session.token);
    expect(context?.user.email).toBe("alice@hospital.org");
    expect(context?.resident?.id).toBe(alice.resident.id);
  });

  it("refuses a code that has already been redeemed", async () => {
    const code = await createHandoffCode(
      alice.user.id,
      pkceChallengeFromVerifier(verifier),
    );
    await redeemHandoffCode(code, verifier);
    await expect(redeemHandoffCode(code, verifier)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("refuses a code redeemed with the wrong verifier", async () => {
    const code = await createHandoffCode(
      alice.user.id,
      pkceChallengeFromVerifier(verifier),
    );
    await expect(
      redeemHandoffCode(code, "a-different-verifier-entirely-0000000000"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    // The failed attempt must not have consumed the code.
    await expect(redeemHandoffCode(code, verifier)).resolves.toBeTruthy();
  });

  it("refuses an expired code", async () => {
    const code = await createHandoffCode(
      alice.user.id,
      pkceChallengeFromVerifier(verifier),
    );
    await query("UPDATE native_auth_codes SET expires_at = now() - interval '1 minute'");
    await expect(redeemHandoffCode(code, verifier)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("refuses an unknown code", async () => {
    await expect(redeemHandoffCode("not-a-real-code", verifier)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("only one of two simultaneous redemptions succeeds", async () => {
    const code = await createHandoffCode(
      alice.user.id,
      pkceChallengeFromVerifier(verifier),
    );
    const results = await Promise.allSettled([
      redeemHandoffCode(code, verifier),
      redeemHandoffCode(code, verifier),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
});

describe("identity linking", () => {
  it("resolves a second provider with the same verified email to one account", async () => {
    await linkIdentity(alice.user.id, {
      provider: "google",
      subject: "google-123",
      email: "alice@hospital.org",
    });

    // The same person signs in later with Apple, same verified address.
    const found = await findUserForIdentity({
      provider: "apple",
      subject: "apple-456",
      email: "alice@hospital.org",
    });
    expect(found).toBe(alice.user.id);
  });

  it("resolves a returning provider identity even when the email changed", async () => {
    await linkIdentity(alice.user.id, {
      provider: "google",
      subject: "google-123",
      email: "old.address@hospital.org",
    });
    const found = await findUserForIdentity({
      provider: "google",
      subject: "google-123",
      email: "new.address@hospital.org",
    });
    expect(found).toBe(alice.user.id);
  });

  it("returns nothing for a genuinely new person", async () => {
    expect(
      await findUserForIdentity({
        provider: "google",
        subject: "google-new",
        email: "stranger@hospital.org",
      }),
    ).toBeNull();
  });

  it("is idempotent", async () => {
    for (let index = 0; index < 3; index += 1) {
      await linkIdentity(alice.user.id, {
        provider: "google",
        subject: "google-123",
        email: "alice@hospital.org",
      });
    }
    const rows = await query<{ id: string }>("SELECT id FROM user_identities WHERE user_id = $1", [
      alice.user.id,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe("device registry and push", () => {
  it("registers a device and pushes to it", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
      appVersion: "1.0.0",
    });
    const results = await sendPush({
      userId: alice.user.id,
      type: "offer.created",
      title: "New offer",
      body: "Bob offered a shift",
      route: "/switches/abc",
    });
    expect(results).toHaveLength(1);
    expect(transport.sent[0].message.route).toBe("/switches/abc");
    expect(transport.sent[0].message.category).toBe("offers");
    expect(transport.sent[0].target.token).toBe("token-abc-1234567890");
  });

  /* The encryption keys are the half of a browser subscription that unit tests
     cannot reach: they go into a `jsonb` column and come back out through a
     different query, and a transport handed `keys: null` refuses to send. So
     everything about web push can be right and a resident still hear nothing,
     on nothing worse than a column name. */
  it("carries a browser subscription's encryption keys through the database", async () => {
    await registerDevice(alice.user.id, {
      installId: "browser-1",
      platform: "web",
      pushToken: "https://push.example.invalid/endpoint-1",
      pushKeys: { p256dh: "p256dh-value", auth: "auth-value" },
    });

    await sendPush({
      userId: alice.user.id,
      type: "offer.created",
      title: "New offer",
      body: "Bob offered a shift",
    });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].target.platform).toBe("web");
    expect(transport.sent[0].target.keys).toEqual({
      p256dh: "p256dh-value",
      auth: "auth-value",
    });
  });

  /* A phone has no keys and must not acquire an empty object on the way
     through: `RoutingPushTransport` sends a native device by Firebase, but
     `WebPushTransport` reads `keys` to decide whether it can encrypt, and a
     falsy-but-present value is the kind of thing a JSON round-trip invents. */
  it("leaves a native device's keys null rather than inventing an empty object", async () => {
    await registerDevice(alice.user.id, {
      installId: "phone-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });

    await sendPush({ userId: alice.user.id, type: "offer.created", title: "x", body: "y" });

    expect(transport.sent[0].target.keys).toBeNull();
  });

  /* Re-subscribing issues a *new* endpoint with *new* keys. Keeping the old
     keys against the new endpoint produces a payload the browser cannot
     decrypt — a notification that is accepted, delivered, and silently
     discarded on the device. */
  it("replaces the keys when a browser re-subscribes to a new endpoint", async () => {
    await registerDevice(alice.user.id, {
      installId: "browser-1",
      platform: "web",
      pushToken: "https://push.example.invalid/endpoint-1",
      pushKeys: { p256dh: "old-p256dh", auth: "old-auth" },
    });
    await registerDevice(alice.user.id, {
      installId: "browser-1",
      platform: "web",
      pushToken: "https://push.example.invalid/endpoint-2",
      pushKeys: { p256dh: "new-p256dh", auth: "new-auth" },
    });

    await sendPush({ userId: alice.user.id, type: "offer.created", title: "x", body: "y" });

    /* One device, not two: the same installation re-subscribing must move
       rather than leave a dead endpoint behind that is still pushed to. */
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].target.token).toBe("https://push.example.invalid/endpoint-2");
    expect(transport.sent[0].target.keys).toEqual({
      p256dh: "new-p256dh",
      auth: "new-auth",
    });
  });

  /* A heartbeat registration sends no token — it should not wipe the keys of
     the subscription the device already has. */
  it("keeps the keys when a later registration carries no token", async () => {
    await registerDevice(alice.user.id, {
      installId: "browser-1",
      platform: "web",
      pushToken: "https://push.example.invalid/endpoint-1",
      pushKeys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    await registerDevice(alice.user.id, {
      installId: "browser-1",
      platform: "web",
      appVersion: "1.1.0",
    });

    await sendPush({ userId: alice.user.id, type: "offer.created", title: "x", body: "y" });

    expect(transport.sent[0].target.keys).toEqual({
      p256dh: "p256dh-value",
      auth: "auth-value",
    });
  });

  it("re-registering the same installation updates rather than duplicates", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-1",
    });
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-2",
      appVersion: "1.1.0",
    });
    const rows = await query<{ push_token: string; app_version: string }>(
      "SELECT push_token, app_version FROM devices WHERE user_id = $1",
      [alice.user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].push_token).toBe("token-2");
    expect(rows[0].app_version).toBe("1.1.0");
  });

  it("moves a push token when the same phone signs in as somebody else", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "android",
      pushToken: "shared-token",
    });
    await registerDevice(bob.user.id, {
      installId: "install-1",
      platform: "android",
      pushToken: "shared-token",
    });

    const aliceDevices = await query<{ push_token: string | null }>(
      "SELECT push_token FROM devices WHERE user_id = $1",
      [alice.user.id],
    );
    expect(aliceDevices[0].push_token).toBeNull();

    // Alice must not receive Bob's notifications.
    await sendPush({
      userId: alice.user.id,
      type: "offer.created",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("disables a token the platform rejects permanently", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "android",
      pushToken: "dead-token-123456",
    });
    transport.nextResult = {
      status: "failed",
      errorCode: "UNREGISTERED",
      permanentFailure: true,
    };
    await sendPush({ userId: alice.user.id, type: "offer.created", title: "x", body: "y" });

    const rows = await query<{ push_token: string | null; disabled_at: Date | null }>(
      "SELECT push_token, disabled_at FROM devices WHERE user_id = $1",
      [alice.user.id],
    );
    expect(rows[0].push_token).toBeNull();
    expect(rows[0].disabled_at).toBeTruthy();
  });

  it("records every delivery attempt", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    await sendPush({ userId: alice.user.id, type: "offer.created", title: "x", body: "y" });
    const deliveries = await query<{ status: string; provider: string }>(
      "SELECT status, provider FROM push_deliveries",
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("sent");
  });

  it("unregisters a device", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    await unregisterDevice(alice.user.id, "install-1");
    await sendPush({ userId: alice.user.id, type: "offer.created", title: "x", body: "y" });
    expect(transport.sent).toHaveLength(0);
  });

  /* Preferences are per event now, not per bucket. This case used to switch off
     `offers`, which meant "an offer on your shift" and "somebody posted a shift
     you could take" went off together — a resident could not keep the one that
     needs them and drop the one that does not. */
  it("sends nothing at all for an event the resident switched off", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    await setPreference(alice.user.id, "offer.created", { push: false, inApp: false });

    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "offer.created",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(0);
    /* Not written, not merely hidden. A row here would still show on the
       notifications screen and still count as unread, which is the difference
       between a preference and a filter. */
    expect(await countUnread(alice.user.id)).toBe(0);

    // A neighbouring event in the same old bucket is untouched.
    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "offer.accepted",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(1);
    expect(await countUnread(alice.user.id)).toBe(1);
  });

  /* The in-app half was the one that never worked: the column was settable,
     was shown back to the resident as if it had taken effect, and was read by
     no code path at all. */
  it("keeps the in-app row when only push is off, and drops push", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    await setPreference(alice.user.id, "offer.created", { push: false, inApp: true });

    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "offer.created",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(0);
    expect(await countUnread(alice.user.id)).toBe(1);
  });

  it("defaults an ambient event to no push and an actionable one to push", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    /* Nobody has set anything. A new resident is neither spammed nor silent:
       a schedule being published is worth a line in the list, a shift of
       theirs being taken is worth their phone buzzing.
     *
     * This used to use `giveaway.posted` as the ambient example, and that
     * event has since stopped being ambient — see the invitation case below.
     * A published schedule is the honest example of the category: it is a fact
     * about the reader's own working life that nothing waits on. */
    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "schedule.published",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(0);
    expect(await countUnread(alice.user.id)).toBe(1);

    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "giveaway.taken",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(1);
  });

  /* An invitation is the third default, and the only event that has it.
     "Somebody is giving a shift away" is not a fact about the reader — it is
     an opportunity, and there are as many of them as the programme posts.
     Writing an in-app row for each would turn the notification list, which
     exists to say what happened to *you*, into a feed of other people's
     Saturdays. Off everywhere until asked for. */
  it("writes nothing at all for an invitation nobody asked for", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "giveaway.posted",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(0);
    /* Not merely unpushed — not written. A disabled notification is never
       sent rather than sent and hidden. */
    expect(await countUnread(alice.user.id)).toBe(0);
  });

  it("delivers the same invitation to somebody who did ask", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    await setPreference(alice.user.id, "giveaway.posted", { push: true, inApp: true });
    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "giveaway.posted",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(1);
    expect(await countUnread(alice.user.id)).toBe(1);
  });

  it("holds a quiet-hours push but still delivers what cannot wait", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    /**
     * A window built around *now*, so the test does not depend on when it runs.
     *
     * It used to say `00:00` to `23:59` and call that the whole day. It is the
     * whole day minus one minute: `withinQuietHours` uses a half-open interval,
     * so 23:59:00 to 23:59:59 falls outside — which is the correct reading of
     * "quiet until 23:59", and exactly the minute a verify run landed in. The
     * suite then reported that quiet hours do not work.
     *
     * Bracketing the current minute is what actually makes it time-independent.
     * The wrap across midnight is deliberate and is the case real quiet hours
     * take (22:00 to 07:00), so this exercises the interesting branch rather
     * than the trivial one.
     */
    const { hour, minute } = instantToZonedParts(new Date(), fixture.program.timezone);
    const clockAt = (offsetMinutes: number) => {
      const total = (hour * 60 + minute + offsetMinutes + 24 * 60) % (24 * 60);
      return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    };
    /* `schedule.published` is ambient; `giveaway.taken` is urgent. */
    await setQuietHours(alice.user.id, { start: clockAt(-120), end: clockAt(120) });
    await setPreference(alice.user.id, "schedule.published", { push: true });

    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "schedule.published",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(0);
    /* Held, not lost: it is on the notifications screen in the morning. */
    expect(await countUnread(alice.user.id)).toBe(1);

    await notifyAndFlush({
      recipientUserId: alice.user.id,
      type: "giveaway.taken",
      title: "x",
      body: "y",
    });
    expect(transport.sent).toHaveLength(1);
  });

  it("never lets a push failure break the caller", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });
    setPushTransport({
      name: "exploding",
      configured: true,
      async send() {
        throw new Error("provider is down");
      },
    });
    await expect(
      sendPush({ userId: alice.user.id, type: "offer.created", title: "x", body: "y" }),
    ).resolves.toEqual([]);
  });
});

describe("push is tied to the transaction that caused it", () => {
  it("sends only after the transaction commits", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });

    await withTransaction(async (client) => {
      await notify(
        {
          recipientUserId: alice.user.id,
          type: "offer.created",
          title: "Inside the transaction",
          body: "…",
        },
        client,
      );
      // Nothing has been sent yet — the trade could still roll back.
      expect(transport.sent).toHaveLength(0);
    });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].message.title).toBe("Inside the transaction");
  });

  it("sends nothing when the transaction rolls back", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });

    await expect(
      withTransaction(async (client) => {
        await notify(
          {
            recipientUserId: alice.user.id,
            type: "switch.completed",
            title: "Switch completed",
            body: "…",
          },
          client,
        );
        throw new Error("validation failed after all");
      }),
    ).rejects.toThrow();

    expect(transport.sent).toHaveLength(0);
    const stored = await query<{ id: string }>("SELECT id FROM notifications");
    expect(stored).toHaveLength(0);
  });

  it("pushes a real completed switch to both residents with a deep link", async () => {
    for (const [user, install] of [
      [alice.user.id, "install-a"],
      [bob.user.id, "install-b"],
    ] as const) {
      await registerDevice(user, {
        installId: install,
        platform: "ios",
        pushToken: `token-${install}-0000`,
      });
    }

    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    const { offer } = await createOffer(bob.context, {
      tradeRequestId: request.id,
      offeredShiftId: bobShift.id,
    });

    // Posting the offer notified Alice and deep-links to the trade.
    const offerPush = transport.sent.find((entry) =>
      entry.message.title.includes("New offer"),
    );
    expect(offerPush?.message.route).toBe(`/switches/${request.id}`);

    transport.sent = [];
    const outcome = await acceptOffer(alice.context, offer.id);
    if (outcome.status !== "completed") throw new Error("expected completion");

    const completionPushes = transport.sent.filter((entry) =>
      entry.message.title.includes("Shift switch completed"),
    );
    expect(completionPushes).toHaveLength(2);
    expect(completionPushes[0].message.route).toBe(
      `/switches/done/${outcome.completedTradeId}`,
    );
  });
});

describe("notification deep links", () => {
  it("routes each entity type to its screen", () => {
    expect(
      routeFor({
        recipientUserId: "u",
        type: "offer.created",
        title: "t",
        relatedEntityType: "trade_request",
        relatedEntityId: "abc",
      }),
    ).toBe("/switches/abc");
    expect(
      routeFor({
        recipientUserId: "u",
        type: "switch.completed",
        title: "t",
        relatedEntityType: "completed_trade",
        relatedEntityId: "def",
      }),
      /* A finished switch is a different record from the request that produced
         it, with its own id, so it has its own path. */
    ).toBe("/switches/done/def");
    expect(
      routeFor({ recipientUserId: "u", type: "shift.changed", title: "t" }),
    ).toBe("/notifications");
    expect(
      routeFor({
        recipientUserId: "u",
        type: "offer.created",
        title: "t",
        route: "/switches/explicit",
        relatedEntityType: "trade_offer",
        relatedEntityId: "zzz",
      }),
    ).toBe("/switches/explicit");
  });
});

describe("calendar feed", () => {
  it("serves only the resident's own shifts, and only while the token is live", async () => {
    await createShift(fixture.program, { inDays: 4, residentId: alice.resident.id });
    await createShift(fixture.program, { inDays: 5, residentId: bob.resident.id });

    const token = await ensureCalendarFeed(alice.resident.id);
    const feed = await resolveCalendarFeed(token);
    expect(feed?.residentId).toBe(alice.resident.id);

    await revokeCalendarFeed(alice.resident.id);
    expect(await resolveCalendarFeed(token)).toBeNull();
  });

  it("rotating the link invalidates the previous one", async () => {
    const first = await ensureCalendarFeed(alice.resident.id);
    const second = await rotateCalendarFeed(alice.resident.id);
    expect(second).not.toBe(first);
    expect(await resolveCalendarFeed(first)).toBeNull();
    expect(await resolveCalendarFeed(second)).toBeTruthy();
  });

  it("stores the token hashed, never in the clear", async () => {
    const token = await ensureCalendarFeed(alice.resident.id);
    const rows = await query<{ token_hash: string }>("SELECT token_hash FROM calendar_feeds");
    expect(rows.every((row) => row.token_hash !== token)).toBe(true);
  });

  it("produces a valid iCalendar document with one event per shift", async () => {
    await createShift(fixture.program, {
      inDays: 3,
      residentId: alice.resident.id,
      startTime: "19:00",
      endTime: "07:00",
      overnight: true,
    });
    const shifts = await listResidentSchedule(alice.resident.id, { limit: 10 });
    const ics = buildCalendar(shifts, {
      programName: "Test Residency",
      residentName: "Alice Adeyemi",
      timezone: fixture.program.timezone,
      appUrl: "https://shiftswitch.example",
      reminderMinutes: 60,
    });

    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain(`UID:shift-${shifts[0].id}@shiftswitch`);
    expect(ics).toContain("BEGIN:VALARM");
    // Times are published as UTC instants so the phone renders them correctly.
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    // Every line ends CRLF, as RFC 5545 requires.
    expect(ics.split("\r\n").length).toBeGreaterThan(10);
    expect(ics.includes("\n\n")).toBe(false);
  });

  it("escapes text that would otherwise break the format", async () => {
    const shifts = await listResidentSchedule(alice.resident.id, { limit: 1 });
    void shifts;
    const ics = buildCalendar(
      [
        {
          ...(await createShift(fixture.program, {
            inDays: 2,
            residentId: alice.resident.id,
            location: "Ward 6; East, Room 12",
          })),
        },
      ],
      {
        programName: "Test",
        residentName: "Alice",
        timezone: fixture.program.timezone,
        appUrl: "https://shiftswitch.example",
      },
    );
    expect(ics).toContain("Ward 6\\; East\\, Room 12");
  });
});

describe("account deletion", () => {
  it("explains what is removed and what is kept", async () => {
    const preview = await previewAccountDeletion(alice.context);
    expect(preview.removed.join(" ")).toMatch(/email/i);
    expect(preview.retained.some((item) => /completed shift switches/i.test(item.item))).toBe(
      true,
    );
    expect(preview.blockers).toHaveLength(0);
  });

  it("blocks deletion while the resident still holds upcoming shifts", async () => {
    await createShift(fixture.program, { inDays: 5, residentId: alice.resident.id });
    const preview = await previewAccountDeletion(alice.context);
    expect(preview.blockers[0]).toMatch(/upcoming shift/i);
    await expect(
      deleteOwnAccount(alice.context, { confirm: "DELETE" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("requires the typed confirmation", async () => {
    await expect(
      deleteOwnAccount(alice.context, { confirm: "yes" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("anonymises the account, ends access, and keeps the operational record", async () => {
    // A completed switch in the past that the program must keep.
    const past = await createShift(fixture.program, {
      inDays: 6,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 13,
      residentId: bob.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: past.id });
    const { offer } = await createOffer(bob.context, {
      tradeRequestId: request.id,
      offeredShiftId: bobShift.id,
    });
    await acceptOffer(alice.context, offer.id);

    // After the switch Alice holds Bob's old shift; move it into the past so
    // deletion is not blocked by an upcoming assignment.
    await query(
      `UPDATE shifts SET start_datetime = now() - interval '3 days',
                        end_datetime = now() - interval '2 days'
        WHERE id = $1`,
      [bobShift.id],
    );

    await registerDevice(alice.user.id, {
      installId: "install-1",
      platform: "ios",
      pushToken: "token-to-be-removed",
    });
    await ensureCalendarFeed(alice.resident.id);

    const result = await deleteOwnAccount(alice.context, {
      confirm: "DELETE",
      reason: "Finished residency",
    });
    expect(result.status).toBe("completed");

    const user = await queryOne<{
      email: string;
      full_name: string;
      active: boolean;
      anonymised_at: Date | null;
      auth_user_id: string | null;
    }>("SELECT email, full_name, active, anonymised_at, auth_user_id FROM users WHERE id = $1", [
      alice.user.id,
    ]);
    expect(user?.email).not.toContain("alice@hospital.org");
    expect(user?.full_name).toBe("Former resident");
    expect(user?.active).toBe(false);
    expect(user?.anonymised_at).toBeTruthy();
    expect(user?.auth_user_id).toBeNull();

    expect(await query("SELECT id FROM user_identities WHERE user_id = $1", [alice.user.id])).toHaveLength(0);
    expect(await query("SELECT id FROM devices WHERE user_id = $1", [alice.user.id])).toHaveLength(0);
    expect(await query("SELECT id FROM sessions WHERE user_id = $1", [alice.user.id])).toHaveLength(0);
    expect(
      await query("SELECT id FROM calendar_feeds WHERE resident_id = $1 AND revoked_at IS NULL", [
        alice.resident.id,
      ]),
    ).toHaveLength(0);

    // The record of who covered which shift survives.
    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    expect(completed).toHaveLength(1);
    const audit = await query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'user.deactivated'",
    );
    expect(audit).toHaveLength(1);
    const deletionRequest = await queryOne<{ status: string; email_at_request: string }>(
      "SELECT status, email_at_request FROM account_deletion_requests",
    );
    expect(deletionRequest?.status).toBe("completed");
    expect(deletionRequest?.email_at_request).toBe("alice@hospital.org");
  });
});

describe("the self-test push a resident can send themselves", () => {
  /**
   * The gap this closes: push delivery has never been observed. Everything
   * above proves the *code* records what the transport said; none of it proves
   * a notification reached a phone, and nothing run on a build server ever
   * can. So the product ships the round trip as a button, and these cases pin
   * what it must report in each of the three states somebody will actually hit.
   */
  it("says which transport is in use and reports nothing sent when it is the no-op", async () => {
    /* The state every development machine and every un-configured deployment
       is in. It must never look like success: a resident who taps "send me a
       test notification", sees a tick, and then never gets a notification has
       been lied to about the one thing they were checking. */
    setPushTransport(new NoopPushTransport());
    await registerDevice(alice.user.id, {
      installId: "install-selftest",
      platform: "ios",
      pushToken: "token-abc-1234567890",
    });

    const outcome = await sendSelfTestPush(alice.user.id);
    expect(outcome.transport).toBe("noop");
    expect(outcome.configured).toBe(false);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].status).toBe("skipped");
    expect(outcome.results[0].errorCode).toBe("not_configured");

    const deliveries = await query<{ status: string; provider: string }>(
      "SELECT status, provider FROM push_deliveries",
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("skipped");
    expect(deliveries[0].status).not.toBe("sent");
  });

  it("records an undeliverable notification as failed, never as sent", async () => {
    /* A configured transport that the platform refuses — the token has expired,
       the service account has lost its role, FCM is down. The distinction that
       matters is failed against skipped: skipped means nobody tried, failed
       means somebody tried and it did not work, and an operator does different
       things about each. */
    await registerDevice(alice.user.id, {
      installId: "install-dead",
      platform: "android",
      pushToken: "dead-token-1234567890",
    });
    transport.nextResult = { status: "failed", errorCode: "SENDER_ID_MISMATCH" };

    const outcome = await sendSelfTestPush(alice.user.id);
    expect(outcome.results[0].status).toBe("failed");
    expect(outcome.results[0].errorCode).toBe("SENDER_ID_MISMATCH");

    const deliveries = await query<{ status: string; error_code: string | null }>(
      "SELECT status, error_code FROM push_deliveries",
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("failed");
    expect(deliveries[0].error_code).toBe("SENDER_ID_MISMATCH");
  });

  it("retires a token the platform says is dead, so the next attempt is honest too", async () => {
    await registerDevice(alice.user.id, {
      installId: "install-gone",
      platform: "android",
      pushToken: "gone-token-1234567890",
    });
    transport.nextResult = {
      status: "failed",
      errorCode: "UNREGISTERED",
      permanentFailure: true,
    };
    await sendSelfTestPush(alice.user.id);

    const rows = await query<{ push_token: string | null; disabled_at: Date | null }>(
      "SELECT push_token, disabled_at FROM devices WHERE user_id = $1",
      [alice.user.id],
    );
    expect(rows[0].push_token).toBeNull();
    expect(rows[0].disabled_at).toBeTruthy();

    /* And the second run reports no devices rather than a second failure,
       which is the truth: there is nothing left to send to. */
    const again = await sendSelfTestPush(alice.user.id);
    expect(again.results).toHaveLength(0);
  });

  it("reports no devices at all rather than pretending there was nothing to do", async () => {
    const outcome = await sendSelfTestPush(alice.user.id);
    expect(outcome.results).toEqual([]);
    /* An empty list is not a pass. The screen turns this into "this phone has
       not registered for notifications yet", which is a different instruction
       from "notifications are not configured on the server". */
  });

  it("only ever targets the caller's own devices", async () => {
    await registerDevice(bob.user.id, {
      installId: "bob-install",
      platform: "ios",
      pushToken: "bob-token-1234567890",
    });
    const outcome = await sendSelfTestPush(alice.user.id);
    expect(outcome.results).toEqual([]);
    expect(transport.sent).toHaveLength(0);
  });
});
