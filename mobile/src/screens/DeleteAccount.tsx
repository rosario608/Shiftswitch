import { useState } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "@/api/client";
import type { DeletionPreview } from "@/api/types";
import { Screen } from "@/components/Screen";
import {
  Button,
  Card,
  ErrorState,
  InlineNotice,
  SectionHeading,
  Skeleton,
} from "@/components/ui";
import { PRIVACY_URL } from "@/config";
import { useResource } from "@/lib/useResource";
import { useAuth } from "@/auth/AuthProvider";

/**
 * Account deletion, in the app, without contacting anyone — as both stores
 * require of an app that lets you create an account.
 *
 * It is honest about the limits. A completed switch is the program's record of
 * who was responsible for a shift, and that record survives; what goes is the
 * account, the personal details, the devices and the access. The user sees
 * exactly which is which before the button is live, and anything that blocks
 * deletion (an upcoming shift still assigned, a live post) is named with the
 * action needed to clear it.
 */
export function DeleteAccountScreen() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const resource = useResource<{ preview: DeletionPreview }>(
    (signal) => api.get<{ preview: DeletionPreview }>("/api/account/delete", { signal }),
    [],
  );

  const preview = resource.data?.preview;
  const blocked = (preview?.blockers.length ?? 0) > 0;
  const canDelete = !blocked && confirmText.trim().toUpperCase() === "DELETE";

  async function remove() {
    setBusy(true);
    setFailure(null);
    try {
      await api.post("/api/account/delete", {
        confirm: confirmText.trim(),
        reason: reason.trim() || undefined,
      });
      // The server has already destroyed the session; clear the local one and
      // return to sign-in.
      await signOut();
      navigate("/", { replace: true });
    } catch (caught) {
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "Could not delete your account. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="Delete my account"
      back="/profile"
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
    >
      {resource.loading && <Skeleton className="h-72" />}

      {resource.error && !preview && (
        <ErrorState
          message={resource.error.message}
          onRetry={() => void resource.reload()}
          retryable={resource.error.retryable}
        />
      )}

      {preview && (
        <div className="space-y-5">
          {blocked && (
            <InlineNotice tone="critical" title="Not right now">
              <ul className="mt-1 space-y-1">
                {preview.blockers.map((blocker) => (
                  <li key={blocker}>· {blocker}</li>
                ))}
              </ul>
            </InlineNotice>
          )}

          <section>
            <SectionHeading>What gets deleted</SectionHeading>
            <Card>
              <ul className="space-y-2 text-sm text-ink">
                {preview.removed.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden="true" className="text-critical">
                      ✕
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>

          <section>
            <SectionHeading>What your program keeps</SectionHeading>
            <Card>
              <ul className="space-y-3 text-sm">
                {preview.retained.map((item) => (
                  <li key={item.item}>
                    <p className="font-medium text-ink">{item.item}</p>
                    <p className="text-ink-muted">{item.reason}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-ink-subtle">
                These records are kept against an anonymised resident — your
                name and email are removed from them.{" "}
                <a
                  className="underline"
                  href={PRIVACY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the retention policy
                </a>
                .
              </p>
            </Card>
          </section>

          <section>
            <SectionHeading>Confirm</SectionHeading>
            <Card>
              <label
                htmlFor="delete-reason"
                className="block text-sm font-medium text-ink"
              >
                Why are you leaving? (optional)
              </label>
              <textarea
                id="delete-reason"
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={blocked}
                className="mt-1 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-ink"
              />

              <label
                htmlFor="delete-confirm"
                className="mt-4 block text-sm font-medium text-ink"
              >
                Type <span className="font-mono font-bold">DELETE</span> to
                confirm
              </label>
              <input
                id="delete-confirm"
                type="text"
                autoCapitalize="characters"
                autoCorrect="off"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                disabled={blocked}
                className="mt-1 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base tracking-widest text-ink"
              />

              {failure && (
                <div className="mt-3">
                  <InlineNotice tone="critical">{failure}</InlineNotice>
                </div>
              )}

              <Button
                block
                variant="danger"
                className="mt-4"
                busy={busy}
                disabled={!canDelete}
                onClick={() => void remove()}
              >
                Delete my account permanently
              </Button>
              <p className="mt-2 text-center text-xs text-ink-subtle">
                This cannot be undone. You will be signed out immediately.
              </p>
            </Card>
          </section>
        </div>
      )}
    </Screen>
  );
}
