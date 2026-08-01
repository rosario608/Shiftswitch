import { routeFromUrl } from "@/native/deeplinks";

/**
 * What this build can actually do on the phone it is running on.
 *
 * ## Why it exists
 *
 * Five things in this product have never been *observed* working: push
 * delivery, the Capacitor plugins on a device, an invitation accepted through a
 * real Google account, App Links, and an iOS build. Four of them cannot be
 * observed from a build server at all — they need a phone, a person and real
 * credentials. What can be built is the thing that shrinks that person's job to
 * one tap and one paste.
 *
 * ## The rules it follows
 *
 * **Three verdicts, never two.** `pass`, `fail`, and `skipped` — and *skipped
 * always carries a reason*. Collapsing skipped into fail makes a phone that has
 * simply not been asked for notification permission look broken; collapsing it
 * into pass is the lie this whole file exists to prevent.
 *
 * **Every check says what to do about it.** "Secure storage failed" is a
 * symptom. "The Keychain refused to store a value — this usually means the app
 * was built without the Keychain Sharing capability" is something a person can
 * act on.
 *
 * **Nothing here is a special build.** No debug flag, no hidden gesture, no
 * developer menu. It is a screen in Settings, because the person who needs it is
 * a resident on a ward whose notifications are not arriving, and asking them to
 * install a different build is asking them to give up.
 *
 * ## Dependencies are injected
 *
 * Every platform call arrives through `SelfTestDeps` rather than being imported
 * here. That is what makes "reports correctly when the dependency is absent"
 * testable: the suite runs the whole thing twice, once with working fakes and
 * once with ones that throw or are missing, and asserts the verdicts.
 */

export type CheckStatus = "pass" | "fail" | "skipped";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  /** One sentence. What happened, and what to do about it if anything. */
  detail: string;
}

export interface SelfTestDeps {
  platform: "ios" | "android" | "web";
  appVersion: string;
  /** OS name and version, when the device plugin can say. */
  osVersion: () => Promise<string | null>;

  secureSet: (key: string, value: string) => Promise<void>;
  secureGet: (key: string) => Promise<string | null>;
  secureRemove: (key: string) => Promise<void>;

  pushPermission: () => Promise<"granted" | "denied" | "prompt" | "unsupported">;
  /** The token this installation last registered, if any. */
  pushToken: () => string | null;
  /** Asks the server to push to this user's own devices. */
  sendSelfTestPush: () => Promise<{
    transport: string;
    configured: boolean;
    results: Array<{ platform: string; status: string; errorCode?: string }>;
  }>;
  /** Resolves true if a push arrives within the window, false on timeout. */
  awaitPushReceipt: (timeoutMs: number) => Promise<boolean>;

  /** Reaches the server's health endpoint. Rejects on network failure. */
  probeNetwork: () => Promise<{ ok: boolean; status: number }>;
  /**
   * Starts a request and aborts it mid-flight, returning how the API client
   * classified the result. "unknown" is the correct answer.
   */
  probeInterrupted: () => Promise<"no" | "unknown" | "yes">;

  online: () => boolean;
}

const PROBE_KEY = "shiftswitch.selftest.probe";

/** How long to wait for a push to come back. Long enough for a cold APNs hop. */
export const RECEIPT_TIMEOUT_MS = 15_000;

async function check(
  id: string,
  label: string,
  run: () => Promise<Omit<CheckResult, "id" | "label">>,
): Promise<CheckResult> {
  try {
    return { id, label, ...(await run()) };
  } catch (error) {
    /* A check that throws is a failed check, never a crashed screen. The whole
       point is to produce a report from a phone that is misbehaving. */
    return {
      id,
      label,
      status: "fail",
      detail: `The check itself could not run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** The checks that need nobody to do anything. */
export async function runAutomaticChecks(deps: SelfTestDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(
    await check("platform", "This build", async () => {
      const os = await deps.osVersion();
      return {
        status: deps.platform === "web" ? "skipped" : "pass",
        detail:
          deps.platform === "web"
            ? `Running in a browser, version ${deps.appVersion}. The checks below that need a phone will say so.`
            : `${deps.platform === "ios" ? "iPhone" : "Android"}${
                os ? `, ${os}` : ""
              }, app version ${deps.appVersion}.`,
      };
    }),
  );

  results.push(
    await check("secure-storage", "Keeping you signed in", async () => {
      if (deps.platform === "web") {
        return {
          status: "skipped",
          detail:
            "Only a phone has a Keychain. In a browser the sign-in token is kept in the tab and cleared when it closes.",
        };
      }
      const value = `probe-${Date.now()}`;
      await deps.secureSet(PROBE_KEY, value);
      const read = await deps.secureGet(PROBE_KEY);
      await deps.secureRemove(PROBE_KEY);
      if (read !== value) {
        return {
          status: "fail",
          detail:
            "The secure store accepted a value and gave back something else. Your sign-in will not survive closing the app. This usually means the app was built without the Keychain Sharing capability.",
        };
      }
      return {
        status: "pass",
        detail:
          "Wrote a value to the phone's secure store, read it back, and removed it. Your sign-in is kept where the operating system protects it.",
      };
    }),
  );

  const permission = await deps.pushPermission();
  results.push(
    await check("push-permission", "Permission to notify you", async () => {
      switch (permission) {
        case "granted":
          return { status: "pass", detail: "You have allowed notifications on this phone." };
        case "denied":
          return {
            status: "fail",
            detail:
              "Notifications are switched off for ShiftSwitch. Open your phone's Settings, find ShiftSwitch, and turn Notifications on — the app cannot ask again once you have said no.",
          };
        case "prompt":
          return {
            status: "skipped",
            detail:
              "You have not been asked yet. Turn notifications on from your profile, then run this again.",
          };
        default:
          return {
            status: "skipped",
            detail: "This is not a phone, so there is nothing to ask.",
          };
      }
    }),
  );

  const token = deps.pushToken();
  results.push(
    await check("push-token", "Registered with Apple or Google", async () => {
      if (permission !== "granted") {
        return {
          status: "skipped",
          detail: "Nothing to register until notifications are allowed.",
        };
      }
      if (!token) {
        return {
          status: "fail",
          detail:
            "Permission was given but this phone never received a notification token. On Android this usually means google-services.json is missing from the build; on iPhone, that the app is not signed with a push-enabled profile.",
        };
      }
      return {
        status: "pass",
        /* The first characters only. A push token is a capability: anybody
           holding it can send this phone a notification. */
        detail: `This phone is registered. Token begins ${token.slice(0, 8)}…`,
      };
    }),
  );

  let sendSucceeded = false;
  results.push(
    await check("push-send", "The server sending it", async () => {
      /* One cause, one thing to fix. Without permission on *this* phone there
         is nothing here that can arrive, so the send is skipped rather than
         attempted — a resident who has simply not turned notifications on
         should read one instruction, not four failures. */
      if (permission !== "granted") {
        return {
          status: "skipped",
          detail: "Nothing to send until notifications are allowed on this phone.",
        };
      }
      const outcome = await deps.sendSelfTestPush();
      if (!outcome.configured) {
        return {
          status: "skipped",
          detail:
            "No notification credentials are configured on the server, so nothing was sent — and nothing pretended to be. Your program's administrator needs to add them.",
        };
      }
      if (outcome.results.length === 0) {
        return {
          status: "skipped",
          detail:
            "The server has no registered phone for your account yet. Allow notifications, then run this again.",
        };
      }
      const failed = outcome.results.filter((row) => row.status === "failed");
      if (failed.length > 0) {
        return {
          status: "fail",
          detail: `The notification service refused it (${
            failed[0].errorCode ?? "no reason given"
          }). The report below is what your administrator needs.`,
        };
      }
      const sent = outcome.results.filter((row) => row.status === "sent");
      sendSucceeded = sent.length > 0;
      return {
        status: sent.length > 0 ? "pass" : "skipped",
        detail:
          sent.length > 0
            ? `Accepted for delivery to ${sent.length} phone${sent.length === 1 ? "" : "s"}.`
            : "Nothing was sent; the server recorded the attempt rather than claiming it worked.",
      };
    }),
  );

  results.push(
    await check("push-receipt", "It arriving on this phone", async () => {
      if (!sendSucceeded) {
        return {
          status: "skipped",
          detail: "Nothing was sent, so there is nothing to wait for.",
        };
      }
      const arrived = await deps.awaitPushReceipt(RECEIPT_TIMEOUT_MS);
      return arrived
        ? {
            status: "pass",
            detail:
              "A notification was sent and this phone received it. This is the whole chain working, end to end.",
          }
        : {
            status: "fail",
            detail:
              "The service accepted it but nothing arrived within 15 seconds. Check that Do Not Disturb and Focus are off, then run this again — if it still fails, the report below is what your administrator needs.",
          };
    }),
  );

  results.push(
    await check("deep-links", "Opening a link to a shift", async () => {
      /* Exercises the same function the operating system's link handler calls,
         with the shapes that actually arrive: a universal link, the app's own
         scheme, a link sent before the screens were renamed, and something
         from another site that must be refused. */
      const id = "9f2c8a1e-4b3d-4c5e-8f7a-1b2c3d4e5f6a";
      const cases: Array<[string, string | null]> = [
        [`shiftswitch://switches/${id}`, `/switches/${id}`],
        [`shiftswitch://trades/${id}`, `/switches/${id}`],
        ["https://example.invalid/switches/whatever", null],
        ["not a url at all", null],
      ];
      const wrong = cases.filter(([input, expected]) => routeFromUrl(input) !== expected);
      if (wrong.length > 0) {
        return {
          status: "fail",
          detail: `${wrong.length} link${
            wrong.length === 1 ? "" : "s"
          } did not open the right screen. Tapping a link in a notification may take you to the wrong place.`,
        };
      }
      return {
        status: "pass",
        detail:
          "Links to a shift open the right screen, older links still work, and a link from anywhere else is ignored.",
      };
    }),
  );

  results.push(
    await check("network", "Reaching ShiftSwitch", async () => {
      if (!deps.online()) {
        return {
          status: "skipped",
          detail: "This phone says it has no connection, so there was nothing to try.",
        };
      }
      const probe = await deps.probeNetwork();
      if (!probe.ok) {
        return {
          status: "fail",
          detail: `The server answered ${probe.status}. Something is wrong at ShiftSwitch's end rather than with this phone — your administrator can see what on the diagnostics page.`,
        };
      }
      return { status: "pass", detail: "The server answered." };
    }),
  );

  results.push(
    await check("interrupted", "Losing signal mid-action", async () => {
      if (!deps.online()) {
        return { status: "skipped", detail: "Already offline; nothing to interrupt." };
      }
      const delivery = await deps.probeInterrupted();
      if (delivery !== "unknown") {
        return {
          status: "fail",
          detail: `A request cut off halfway was reported as "${delivery}" rather than as unknown. That matters: if the app tells you an action failed when it may have worked, you could accept the same switch twice.`,
        };
      }
      return {
        status: "pass",
        detail:
          "A request cut off halfway is reported as “we don’t know” rather than as a failure, so you are never told to try something again that may already have happened.",
      };
    }),
  );

  return results;
}

/**
 * The report. Plain text, because it is going into a message or an email, and
 * because a non-engineer should be able to read every line of what they are
 * sending before they send it.
 *
 * No name, no email address, no shift, no schedule. An install id is included
 * because it is the only way to find this phone's rows in the delivery log, and
 * it identifies an installation rather than a person or a device.
 */
export function selfTestReport(
  results: CheckResult[],
  meta: { appVersion: string; platform: string; installId: string; at: Date },
): string {
  const symbol: Record<CheckStatus, string> = {
    pass: "[OK]",
    fail: "[FAILED]",
    skipped: "[SKIPPED]",
  };
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  const lines = [
    "ShiftSwitch self-test",
    `${meta.at.toISOString()} · ${meta.platform} · app ${meta.appVersion}`,
    `installation ${meta.installId}`,
    "",
    failed > 0
      ? `${failed} check${failed === 1 ? "" : "s"} failed.`
      : skipped > 0
        ? `Everything that could be checked passed. ${skipped} could not be checked.`
        : "Everything passed.",
    "",
  ];
  for (const result of results) {
    lines.push(`${symbol[result.status]} ${result.label}`);
    lines.push(`    ${result.detail}`);
  }
  return lines.join("\n");
}

/** One sentence for the top of the screen. */
export function verdict(results: CheckResult[]): string {
  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    return failed.length === 1
      ? `One thing is not working: ${failed[0].label.toLowerCase()}.`
      : `${failed.length} things are not working.`;
  }
  const skipped = results.filter((r) => r.status === "skipped");
  if (skipped.length > 0) {
    return `Everything that could be checked is working. ${skipped.length} could not be checked yet.`;
  }
  return "Everything is working on this phone.";
}
