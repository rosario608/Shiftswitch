import { describe, expect, it, vi } from "vitest";
import {
  runAutomaticChecks,
  selfTestReport,
  verdict,
  type CheckResult,
  type SelfTestDeps,
} from "@/native/selftest";

/**
 * The self-test, run twice: once on a phone where everything works, and once on
 * a phone where nothing does.
 *
 * The second half is the part that matters. A self-test that only passes when
 * the world is perfect tells nobody anything — the whole reason it exists is
 * the resident whose notifications are not arriving, and every verdict it gives
 * them has to be both true and actionable.
 */

const workingDeps = (): SelfTestDeps => {
  const store = new Map<string, string>();
  return {
    platform: "ios",
    appVersion: "1.0.0",
    osVersion: async () => "iOS 18.2",
    secureSet: async (key, value) => void store.set(key, value),
    secureGet: async (key) => store.get(key) ?? null,
    secureRemove: async (key) => void store.delete(key),
    pushPermission: async () => "granted",
    pushToken: () => "abcd1234efgh5678",
    sendSelfTestPush: async () => ({
      transport: "fcm",
      configured: true,
      results: [{ platform: "ios", status: "sent" }],
    }),
    awaitPushReceipt: async () => true,
    probeNetwork: async () => ({ ok: true, status: 200 }),
    probeInterrupted: async () => "unknown",
    online: () => true,
  };
};

const find = (results: CheckResult[], id: string) => results.find((r) => r.id === id)!;

describe("a phone where everything works", () => {
  it("passes every check and says so in one sentence", async () => {
    const results = await runAutomaticChecks(workingDeps());
    const failures = results.filter((r) => r.status !== "pass");
    expect(failures.map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
    expect(verdict(results)).toBe("Everything is working on this phone.");
  });

  it("never puts a whole push token in the report", async () => {
    /* A push token is a capability: anybody holding it can send this phone a
       notification. The report is written to be pasted into a message. */
    const results = await runAutomaticChecks(workingDeps());
    const report = selfTestReport(results, {
      appVersion: "1.0.0",
      platform: "ios",
      installId: "install-1",
      at: new Date("2026-08-01T12:00:00Z"),
    });
    expect(report).not.toContain("abcd1234efgh5678");
    expect(report).toContain("abcd1234");
  });
});

describe("a phone that has never been asked about notifications", () => {
  it("skips rather than fails, and says what to do", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      pushPermission: async () => "prompt",
      pushToken: () => null,
    });

    expect(find(results, "push-permission").status).toBe("skipped");
    expect(find(results, "push-permission").detail).toMatch(/turn notifications on/i);
    /* And everything downstream skips too, rather than each reporting its own
       failure — one cause, one thing to fix. */
    expect(find(results, "push-token").status).toBe("skipped");
    expect(find(results, "push-receipt").status).toBe("skipped");
    expect(verdict(results)).toMatch(/could not be checked/i);
  });
});

describe("a phone where notifications were refused", () => {
  it("fails, and explains that the app cannot ask again", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      pushPermission: async () => "denied",
      pushToken: () => null,
    });
    const permission = find(results, "push-permission");
    expect(permission.status).toBe("fail");
    expect(permission.detail).toMatch(/Settings/);
    expect(permission.detail).toMatch(/cannot ask again/i);
  });
});

describe("a server with no notification credentials", () => {
  it("skips the send and blames the configuration, not the phone", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      sendSelfTestPush: async () => ({
        transport: "noop",
        configured: false,
        results: [],
      }),
    });
    const send = find(results, "push-send");
    expect(send.status).toBe("skipped");
    expect(send.detail).toMatch(/administrator/i);
    expect(send.detail).toMatch(/nothing pretended to be/i);
    // Never a pass. Nothing was sent.
    expect(send.status).not.toBe("pass");
  });
});

describe("a token the notification service refuses", () => {
  it("fails with the code the service gave", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      sendSelfTestPush: async () => ({
        transport: "fcm",
        configured: true,
        results: [{ platform: "android", status: "failed", errorCode: "SENDER_ID_MISMATCH" }],
      }),
    });
    const send = find(results, "push-send");
    expect(send.status).toBe("fail");
    expect(send.detail).toContain("SENDER_ID_MISMATCH");
    // Nothing was sent, so waiting for it to arrive would be theatre.
    expect(find(results, "push-receipt").status).toBe("skipped");
  });
});

describe("a notification that is accepted but never arrives", () => {
  it("fails the receipt check and names the usual cause", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      awaitPushReceipt: async () => false,
    });
    const receipt = find(results, "push-receipt");
    expect(receipt.status).toBe("fail");
    expect(receipt.detail).toMatch(/Do Not Disturb|Focus/);
    expect(verdict(results)).toMatch(/One thing is not working/);
  });
});

describe("a phone whose secure store is broken", () => {
  it("fails with the capability that is usually missing", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      secureGet: async () => "something else entirely",
    });
    const storage = find(results, "secure-storage");
    expect(storage.status).toBe("fail");
    expect(storage.detail).toMatch(/Keychain Sharing/);
  });

  it("does not take the whole screen down when the plugin throws", async () => {
    /* A missing plugin rejects rather than returning. The report still has to
       come out — it is the only thing the person on the ward can send. */
    const results = await runAutomaticChecks({
      ...workingDeps(),
      secureSet: async () => {
        throw new Error("SecureStorage plugin is not implemented on ios");
      },
    });
    const storage = find(results, "secure-storage");
    expect(storage.status).toBe("fail");
    expect(storage.detail).toMatch(/not implemented/);
    // And the rest of the run still happened.
    expect(results.length).toBeGreaterThan(5);
    expect(find(results, "deep-links").status).toBe("pass");
  });
});

describe("a phone with no signal", () => {
  it("skips the network checks instead of blaming the server", async () => {
    const results = await runAutomaticChecks({ ...workingDeps(), online: () => false });
    expect(find(results, "network").status).toBe("skipped");
    expect(find(results, "interrupted").status).toBe("skipped");
  });
});

describe("an app client that misreports an interrupted request", () => {
  it("fails, and says why it matters", async () => {
    /* This is the one check that is about the app rather than the phone, and
       it guards the distinction the whole offline design rests on. */
    const results = await runAutomaticChecks({
      ...workingDeps(),
      probeInterrupted: async () => "no",
    });
    const interrupted = find(results, "interrupted");
    expect(interrupted.status).toBe("fail");
    expect(interrupted.detail).toMatch(/twice/);
  });
});

describe("running in a browser", () => {
  it("skips what only a phone has, and says so plainly", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      platform: "web",
      pushPermission: async () => "unsupported",
      pushToken: () => null,
    });
    expect(find(results, "platform").status).toBe("skipped");
    expect(find(results, "secure-storage").status).toBe("skipped");
    expect(find(results, "secure-storage").detail).toMatch(/Only a phone has a Keychain/);
    expect(find(results, "push-permission").status).toBe("skipped");
    // The checks that do not need a phone still run properly.
    expect(find(results, "deep-links").status).toBe("pass");
    expect(find(results, "network").status).toBe("pass");
  });
});

describe("the report", () => {
  it("leads with the count of failures and carries every line", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      awaitPushReceipt: async () => false,
    });
    const report = selfTestReport(results, {
      appVersion: "1.0.0",
      platform: "ios",
      installId: "install-1",
      at: new Date("2026-08-01T12:00:00Z"),
    });
    expect(report).toContain("1 check failed.");
    expect(report).toContain("[FAILED] It arriving on this phone");
    expect(report).toContain("[OK] Opening a link to a shift");
    expect(report).toContain("installation install-1");
    for (const result of results) expect(report).toContain(result.label);
  });

  it("says everything passed only when everything did", async () => {
    const report = selfTestReport(await runAutomaticChecks(workingDeps()), {
      appVersion: "1.0.0",
      platform: "ios",
      installId: "install-1",
      at: new Date(),
    });
    expect(report).toContain("Everything passed.");
  });
});

describe("a check that throws where nobody expected it", () => {
  it("becomes a failed check rather than an exception", async () => {
    const results = await runAutomaticChecks({
      ...workingDeps(),
      sendSelfTestPush: vi.fn().mockRejectedValue(new Error("Network request failed")),
    });
    const send = find(results, "push-send");
    expect(send.status).toBe("fail");
    expect(send.detail).toContain("Network request failed");
    expect(results.at(-1)!.id).toBe("interrupted");
  });
});
