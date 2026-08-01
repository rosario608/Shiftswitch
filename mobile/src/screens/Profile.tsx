import { ROLE_LABEL } from "@/api/roles";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "@/api/client";
import type { LinkedIdentity } from "@/api/types";
import { Screen } from "@/components/Screen";
import {
  Button,
  Card,
  ConfirmSheet,
  InlineNotice,
  Pill,
  SectionHeading,
  useToast,
} from "@/components/ui";
import { APP_VERSION, ENVIRONMENT, PRIVACY_URL, SUPPORT_EMAIL, TERMS_URL } from "@/config";
import { useResource } from "@/lib/useResource";
import { useAuth } from "@/auth/AuthProvider";
import {
  permissionState,
  primePush,
  settingsInstructions,
  type PushPermission,
} from "@/native/push";

/**
 * Profile and settings.
 *
 * Everything that affects the resident's own data lives here and nowhere else:
 * what notifications they get, whether their schedule is published to a
 * calendar app, which accounts sign them in, and how to leave.
 */
export function ProfileScreen() {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const identities = useResource<{ identities: LinkedIdentity[] }>(
    (signal) =>
      api.get<{ identities: LinkedIdentity[] }>("/api/account/identities", {
        signal,
      }),
    [],
  );

  const user = session?.user;

  return (
    <Screen title="You" onRefresh={identities.reload} refreshing={identities.refreshing}>
      <div className="space-y-6">
        <Card>
          <p className="text-lg font-bold text-ink">{user?.fullName}</p>
          <p className="selectable text-sm text-ink-muted">{user?.email}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {user?.role && (
              <Pill tone="brand">
                {ROLE_LABEL[user.role]}
              </Pill>
            )}
            {session?.program && <Pill>{session.program.name}</Pill>}
          </div>
          {session?.program && (
            <p className="mt-3 text-xs text-ink-subtle">
              {session.program.institution} · times shown in{" "}
              {session.program.timezone}
            </p>
          )}
        </Card>

        <NotificationSettings />

        <CalendarSubscription onMessage={toast.show} />

        <section>
          <SectionHeading>Sign-in</SectionHeading>
          <Card>
            {identities.data?.identities.length ? (
              <ul className="space-y-2 text-sm">
                {identities.data.identities.map((identity) => (
                  <li
                    key={`${identity.provider}-${identity.email}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="capitalize text-ink">
                      {identity.provider}
                    </span>
                    <span className="selectable truncate text-ink-muted">
                      {identity.email ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">
                Your account signs in with Google.
              </p>
            )}
            <p className="mt-3 text-xs text-ink-subtle">
              Signing in with a different provider that uses the same verified
              work address links to this account rather than creating a second
              one.
            </p>
          </Card>
        </section>

        <section>
          <SectionHeading>About</SectionHeading>
          <Card>
            <ul className="space-y-3 text-sm">
              <li>
                <a
                  className="text-brand-ink underline"
                  href={PRIVACY_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Privacy policy
                </a>
              </li>
              <li>
                <a
                  className="text-brand-ink underline"
                  href={TERMS_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Terms of use
                </a>
              </li>
              <li>
                <a
                  className="text-brand-ink underline"
                  href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                    `ShiftSwitch support (${APP_VERSION})`,
                  )}`}
                >
                  Contact support
                </a>
              </li>
            </ul>
            <p className="mt-4 text-xs text-ink-subtle">
              Version {APP_VERSION}
              {ENVIRONMENT !== "production" ? ` · ${ENVIRONMENT} build` : ""}
            </p>
          </Card>
        </section>

        <div className="space-y-2">
          {/* Above sign-out on purpose. Somebody whose notifications are not
              arriving is looking for something to do about it, and the answer
              has to be in the shipping build — asking a resident on a ward to
              install a different one is asking them to give up. */}
          <Button
            block
            variant="secondary"
            onClick={() => navigate("/settings/self-test")}
          >
            Check this phone
          </Button>
          <Button block variant="secondary" onClick={() => setConfirmSignOut(true)}>
            Sign out
          </Button>
          <Button
            block
            variant="ghost"
            className="text-critical"
            onClick={() => navigate("/settings/delete-account")}
          >
            Delete my account
          </Button>
        </div>
      </div>

      <ConfirmSheet
        open={confirmSignOut}
        title="Sign out?"
        confirmLabel="Sign out"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => void signOut()}
        body={
          <p>
            This device will stop receiving notifications for your account. Your
            schedule and switches are unaffected.
          </p>
        }
      />

      {toast.node}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

/**
 * The server returns preferences keyed by category, with every category always
 * present, so the screen never has to invent a default.
 */
interface PreferencesResponse {
  preferences: Record<string, { push: boolean; inApp: boolean }>;
  labels: Record<string, string>;
}

function NotificationSettings() {
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const resource = useResource<PreferencesResponse>(
    (signal) =>
      api.get<PreferencesResponse>("/api/notifications/preferences", { signal }),
    [],
  );

  useEffect(() => {
    void permissionState().then(setPermission);
  }, []);

  async function toggle(category: string, push: boolean) {
    setSaving(category);
    setFailure(null);
    try {
      const updated = await api.patch<PreferencesResponse>(
        "/api/notifications/preferences",
        { category, push },
      );
      resource.setData({ ...resource.data!, preferences: updated.preferences });
    } catch (caught) {
      setFailure(
        caught instanceof ApiError ? caught.message : "Could not save that.",
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <section>
      <SectionHeading>Notifications</SectionHeading>
      <Card>
        {permission === "denied" && (
          <div className="mb-3">
            <InlineNotice tone="caution" title="Notifications are off">
              You turned notifications off for ShiftSwitch. {settingsInstructions()}{" "}
              Your choices below still control what we would send.
            </InlineNotice>
          </div>
        )}
        {permission === "prompt" && (
          <div className="mb-3">
            <InlineNotice tone="brand" title="Not set up yet">
              <Button
                className="mt-2"
                onClick={async () => setPermission(await primePush())}
              >
                Turn on notifications
              </Button>
            </InlineNotice>
          </div>
        )}
        {permission === "unsupported" && (
          <div className="mb-3">
            <InlineNotice tone="neutral">
              Push notifications are only available in the installed app.
            </InlineNotice>
          </div>
        )}

        {failure && (
          <div className="mb-3">
            <InlineNotice tone="critical">{failure}</InlineNotice>
          </div>
        )}

        <ul className="divide-y divide-border-base">
          {Object.entries(resource.data?.preferences ?? {}).map(
            ([category, preference]) => (
              <li
                key={category}
                className="flex items-center justify-between gap-4 py-3"
              >
                <label htmlFor={`push-${category}`} className="text-sm text-ink">
                  {resource.data?.labels[category] ?? category}
                </label>
                <input
                  id={`push-${category}`}
                  type="checkbox"
                  role="switch"
                  checked={preference.push}
                  disabled={saving === category}
                  onChange={(event) => void toggle(category, event.target.checked)}
                  className="h-6 w-6 accent-[var(--brand)]"
                />
              </li>
            ),
          )}
        </ul>
        {!resource.data && !resource.error && (
          <p className="text-sm text-ink-muted">Loading your preferences…</p>
        )}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Calendar subscription
// ---------------------------------------------------------------------------

function CalendarSubscription({
  onMessage,
}: {
  onMessage: (text: string, tone?: "positive" | "critical") => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const resource = useResource<{ active: boolean }>(
    (signal) => api.get<{ active: boolean }>("/api/calendar/subscription", { signal }),
    [],
  );

  async function createOrRotate() {
    setBusy(true);
    try {
      const result = await api.post<{ url: string; rotated: boolean }>(
        "/api/calendar/subscription",
      );
      setUrl(result.url);
      resource.setData({ active: true });
      onMessage(
        result.rotated
          ? "New link created. The old one no longer works."
          : "Calendar link created.",
      );
    } catch (caught) {
      onMessage(
        caught instanceof ApiError ? caught.message : "Could not create the link.",
        "critical",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <SectionHeading>Calendar</SectionHeading>
      <Card>
        <p className="text-sm text-ink-muted">
          Subscribe to your shifts in Apple Calendar, Google Calendar or Outlook.
          The feed is read-only and updates itself when your schedule changes.
        </p>

        {url && (
          <div className="mt-3 rounded-lg bg-surface-muted p-3">
            <p className="text-xs font-semibold text-ink-subtle uppercase">
              Your link
            </p>
            <p className="selectable mt-1 text-xs break-all text-ink">{url}</p>
            <p className="mt-2 text-xs text-ink-subtle">
              Copy this now — it is stored hashed, so we cannot show it again.
              Anyone with the link can read your shift times, so treat it like a
              password.
            </p>
          </div>
        )}

        <div className="mt-3 space-y-2">
          <Button block variant="secondary" busy={busy} onClick={() => void createOrRotate()}>
            {resource.data?.active ? "Create a new link" : "Create my calendar link"}
          </Button>
          {resource.data?.active && (
            <Button
              block
              variant="ghost"
              className="text-critical"
              onClick={() => setConfirmRevoke(true)}
            >
              Turn the calendar feed off
            </Button>
          )}
        </div>
      </Card>

      <ConfirmSheet
        open={confirmRevoke}
        title="Turn off the calendar feed?"
        destructive
        confirmLabel="Turn it off"
        onCancel={() => setConfirmRevoke(false)}
        onConfirm={async () => {
          try {
            await api.delete("/api/calendar/subscription");
            resource.setData({ active: false });
            setUrl(null);
            onMessage("Calendar feed turned off.");
          } catch {
            onMessage("Could not turn it off.", "critical");
          } finally {
            setConfirmRevoke(false);
          }
        }}
        body={
          <p>
            Any calendar app currently subscribed will stop updating and the
            existing link stops working immediately.
          </p>
        }
      />
    </section>
  );
}
