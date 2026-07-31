import { useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { ALLOW_TEST_LOGIN, ENVIRONMENT, PRIVACY_URL, TERMS_URL } from "@/config";
import { Button, ErrorState, InlineNotice } from "@/components/ui";

/**
 * Sign-in.
 *
 * Google is the only sign-in method, so this screen offers exactly one button
 * and says nothing about hospital log-ins, institutional accounts or single
 * sign-on — none of those exist, and mentioning them sends residents to a help
 * desk that cannot help. There is no password to create, and the app never sees
 * one. Adding a provider later is a change to `src/server/auth/` plus a second
 * button here; the architecture does not need advertising in advance.
 */
export function LoginScreen() {
  const { signInWithGoogle, signInWithEmail, signingIn, error, clearError } =
    useAuth();
  const [testEmail, setTestEmail] = useState("");

  return (
    <div className="safe-top safe-bottom safe-x flex h-full flex-col justify-between bg-canvas px-6">
      <div className="flex flex-1 flex-col justify-center">
        <div className="mx-auto w-full max-w-sm">
          <div
            aria-hidden="true"
            className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-2xl font-bold text-white"
          >
            SS
          </div>
          <h1 className="text-3xl font-bold text-ink">ShiftSwitch</h1>
          <p className="mt-2 text-ink-muted">
            Swap shifts with your co-residents, with your program&rsquo;s rules
            checked before anything is agreed.
          </p>

          {error && (
            <div className="mt-6">
              <ErrorState message={error} onRetry={clearError} retryable={false} />
            </div>
          )}

          <div className="mt-8 space-y-3">
            <Button block busy={signingIn} onClick={() => void signInWithGoogle()}>
              Continue with Google
            </Button>
            <p className="text-center text-xs text-ink-subtle">
              Use the Google account your program has on file.
            </p>
          </div>

          {ALLOW_TEST_LOGIN && (
            <div className="mt-8 space-y-2 rounded-card border border-dashed border-caution/60 bg-caution-soft p-4">
              <p className="text-xs font-semibold text-caution">
                {ENVIRONMENT} build only
              </p>
              <label
                htmlFor="test-email"
                className="block text-sm font-medium text-ink"
              >
                Sign in as
              </label>
              <input
                id="test-email"
                type="email"
                autoCapitalize="none"
                autoCorrect="off"
                inputMode="email"
                value={testEmail}
                onChange={(event) => setTestEmail(event.target.value)}
                className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-ink"
                placeholder="resident@example.edu"
              />
              <Button
                block
                variant="secondary"
                disabled={!testEmail.includes("@")}
                busy={signingIn}
                onClick={() => void signInWithEmail(testEmail.trim())}
              >
                Sign in without Google
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="pb-4">
        <InlineNotice tone="neutral">
          <p>
            ShiftSwitch stores your name, work email and schedule. It never
            handles patient information.{" "}
            <a href={PRIVACY_URL} className="underline" target="_blank" rel="noreferrer">
              Privacy policy
            </a>{" "}
            ·{" "}
            <a href={TERMS_URL} className="underline" target="_blank" rel="noreferrer">
              Terms
            </a>
          </p>
        </InlineNotice>
      </div>
    </div>
  );
}
