import { useCallback, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { App as CapacitorApp } from "@capacitor/app";
import { Screen } from "@/components/Screen";
import { Button, Card } from "@/components/ui";
import { api, networkFailure } from "@/api/client";
import { API_URL, APP_VERSION } from "@/config";
import { installId, secureGet, secureRemove, secureSet } from "@/lib/storage";
import { onPushReceived, permissionState, pushTokenValue } from "@/native/push";
import { successFeedback } from "@/native/shell";
import {
  runAutomaticChecks,
  selfTestReport,
  verdict,
  type CheckResult,
  type SelfTestDeps,
} from "@/native/selftest";

/**
 * "Is this phone working?", answered by the phone.
 *
 * Reachable from Settings by anybody, in the shipping build. A resident whose
 * notifications are not arriving taps once, reads a sentence, and copies a
 * report that names what is wrong in words their program administrator can act
 * on — no debug build, no cable, no engineer.
 *
 * The automatic checks run on the tap. Two cannot be automated because there is
 * no way to observe them from JavaScript — whether a buzz was felt, and whether
 * the hardware back button does anything — so they are asked, once each, after
 * the rest have run. Asking is honest; asserting would not be.
 */
export function SelfTestScreen() {
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [waitingForPush, setWaitingForPush] = useState(false);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState<null | "haptics" | "back">(null);

  const buildDeps = useCallback((): SelfTestDeps => {
    const platform = Capacitor.getPlatform();
    return {
      platform: platform === "ios" || platform === "android" ? platform : "web",
      appVersion: APP_VERSION,
      osVersion: async () => {
        if (!Capacitor.isNativePlatform()) return null;
        const info = await Device.getInfo().catch(() => null);
        return info ? `${info.operatingSystem} ${info.osVersion}` : null;
      },
      secureSet,
      secureGet,
      secureRemove,
      pushPermission: permissionState,
      pushToken: pushTokenValue,
      sendSelfTestPush: () =>
        api.post<{
          transport: string;
          configured: boolean;
          results: Array<{ platform: string; status: string; errorCode?: string }>;
        }>("/api/devices/self-test"),
      awaitPushReceipt: (timeoutMs) =>
        new Promise<boolean>((resolve) => {
          setWaitingForPush(true);
          const stop = onPushReceived(() => {
            clearTimeout(timer);
            stop();
            setWaitingForPush(false);
            resolve(true);
          });
          const timer = setTimeout(() => {
            stop();
            setWaitingForPush(false);
            resolve(false);
          }, timeoutMs);
        }),
      probeNetwork: async () => {
        const response = await fetch(`${API_URL}/api/health`, { method: "GET" });
        return { ok: response.ok, status: response.status };
      },
      probeInterrupted: async () => {
        /* The network cannot be severed from inside the app, so this asks the
           shipped classifier the question directly: a request that dies while
           the phone still thinks it is online is *unknown*, not failed.
           Everything the app tells a resident about an interrupted action rests
           on this one answer. */
        return networkFailure(true).delivery;
      },
      online: () => navigator.onLine,
    };
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setCopied(false);
    setResults(null);
    const automatic = await runAutomaticChecks(buildDeps());
    setResults(automatic);
    setRunning(false);
    /* The two nobody can measure come last, so the report is already useful if
       the resident stops here. */
    if (Capacitor.isNativePlatform()) {
      await successFeedback();
      setAsking("haptics");
    }
  }, [buildDeps]);

  const answer = useCallback(
    (id: string, label: string, status: CheckResult["status"], detail: string) => {
      setResults((current) => [...(current ?? []), { id, label, status, detail }]);
    },
    [],
  );

  const report = results
    ? selfTestReport(results, {
        appVersion: APP_VERSION,
        platform: Capacitor.getPlatform(),
        installId: installId(),
        at: new Date(),
      })
    : "";

  return (
    <Screen title="Check this phone" back>
      <div className="space-y-4 px-4 pb-8">
        <p className="text-sm text-ink-muted">
          Runs through everything ShiftSwitch needs from this phone — staying
          signed in, notifications arriving, links opening the right screen — and
          gives you one thing to send if something is wrong.
        </p>

        {results === null ? (
          <Button block onClick={() => void run()} busy={running}>
            {running ? "Checking…" : "Run the checks"}
          </Button>
        ) : null}

        {waitingForPush ? (
          <Card>
            <p className="p-4 text-sm text-ink">
              Waiting for the notification to arrive. Keep this screen open — it
              gives up after fifteen seconds.
            </p>
          </Card>
        ) : null}

        {results ? (
          <>
            <Card>
              <p className="p-4 font-semibold text-ink">{verdict(results)}</p>
            </Card>

            <ul className="space-y-2">
              {results.map((result) => (
                <li key={result.id}>
                  <Card>
                    <div className="p-4">
                      <p className="flex items-center gap-2 font-semibold text-ink">
                        {/* Never colour alone: the word is the status. */}
                        <span
                          className={
                            result.status === "pass"
                              ? "text-positive"
                              : result.status === "fail"
                                ? "text-critical"
                                : "text-ink-muted"
                          }
                        >
                          {result.status === "pass"
                            ? "Working"
                            : result.status === "fail"
                              ? "Not working"
                              : "Not checked"}
                        </span>
                        <span className="text-ink-muted">·</span>
                        {result.label}
                      </p>
                      <p className="mt-1 text-sm text-ink-muted">{result.detail}</p>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>

            {asking === "haptics" ? (
              <Card>
                <div className="space-y-3 p-4">
                  <p className="font-semibold text-ink">Did the phone buzz?</p>
                  <p className="text-sm text-ink-muted">
                    ShiftSwitch buzzed just now when the checks finished. Nothing
                    in the app can tell whether you felt it, so this one is a
                    question rather than a check.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      block
                      onClick={() => {
                        answer(
                          "haptics",
                          "The phone buzzing",
                          "pass",
                          "Confirmed by the person holding the phone.",
                        );
                        setAsking("back");
                      }}
                    >
                      Yes
                    </Button>
                    <Button
                      block
                      variant="secondary"
                      onClick={() => {
                        answer(
                          "haptics",
                          "The phone buzzing",
                          "fail",
                          "Nothing was felt. Check that vibration and haptics are switched on in the phone's own settings — the app cannot turn them on for you.",
                        );
                        setAsking("back");
                      }}
                    >
                      No
                    </Button>
                  </div>
                </div>
              </Card>
            ) : null}

            {asking === "back" ? (
              <BackButtonCheck
                onDone={(status, detail) => {
                  answer("back-button", "The back button", status, detail);
                  setAsking(null);
                }}
              />
            ) : null}

            <Card>
              <div className="space-y-3 p-4">
                <p className="font-semibold text-ink">The report</p>
                <p className="text-sm text-ink-muted">
                  Everything above in one message. It has no names, no email
                  addresses and nothing about anybody&rsquo;s schedule in it.
                </p>
                <pre className="max-h-64 overflow-auto rounded-lg bg-surface-muted p-3 text-xs whitespace-pre-wrap text-ink">
                  {report}
                </pre>
                <Button
                  block
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(report)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                >
                  {copied ? "Copied" : "Copy the report"}
                </Button>
                <Button block variant="ghost" onClick={() => void run()}>
                  Run the checks again
                </Button>
              </div>
            </Card>
          </>
        ) : null}
      </div>
    </Screen>
  );
}

/**
 * The back button, which can only be checked by asking somebody to press it.
 *
 * Android only: an iPhone has no hardware back button, so there is nothing to
 * exercise and the check says so rather than inventing a verdict.
 */
function BackButtonCheck({
  onDone,
}: {
  onDone: (status: CheckResult["status"], detail: string) => void;
}) {
  const [listening, setListening] = useState(false);

  if (Capacitor.getPlatform() !== "android") {
    return (
      <Card>
        <div className="space-y-3 p-4">
          <p className="font-semibold text-ink">The back button</p>
          <p className="text-sm text-ink-muted">
            This phone has no hardware back button, so there is nothing to press.
          </p>
          <Button
            block
            variant="secondary"
            onClick={() =>
              onDone("skipped", "No hardware back button on this phone.")
            }
          >
            Skip this one
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="space-y-3 p-4">
        <p className="font-semibold text-ink">Press the back button</p>
        <p className="text-sm text-ink-muted">
          {listening
            ? "Press it now — swipe from the edge, or use the button at the bottom of the screen."
            : "The app has to hear the phone's own back button, or you would be trapped on whichever screen you opened last."}
        </p>
        {listening ? null : (
          <Button
            block
            onClick={() => {
              setListening(true);
              let heard = false;
              const handle = CapacitorApp.addListener("backButton", () => {
                heard = true;
                void handle.then((listener) => listener.remove());
                onDone(
                  "pass",
                  "The app heard the phone's back button and handled it itself.",
                );
              });
              setTimeout(() => {
                if (heard) return;
                void handle.then((listener) => listener.remove());
                onDone(
                  "skipped",
                  "Nothing was pressed within ten seconds, so this one was not checked.",
                );
              }, 10_000);
            }}
          >
            I&rsquo;m ready
          </Button>
        )}
      </div>
    </Card>
  );
}
