"use client";

import * as React from "react";
import { CalendarPlus, Check, Copy } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Sheet } from "@/components/ui/sheet";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Subscribing a phone's calendar to your own shifts.
 *
 * ## Why this exists on the web and not only in the app
 *
 * The feed, the token, the API and this exact flow have all existed since the
 * native client was built, and the native Profile screen has offered it the
 * whole time. The web app never did — so every resident who arrives by link,
 * which is all of them, could not reach a finished feature. That is the defect
 * this component fixes; the backend needed nothing.
 *
 * ## Why the link is shown once
 *
 * The token is stored hashed, exactly like a password, so the server genuinely
 * cannot show it a second time — a resident who loses it makes a new one and
 * the old one dies. `active` therefore tells us whether a feed exists, never
 * what its URL is, and the copy below says that in those words rather than
 * leaving somebody hunting for a link the product is incapable of showing.
 *
 * ## What it never claims
 *
 * That the calendar is the schedule. A subscribed client polls on its own
 * schedule — an hour if it honours our `REFRESH-INTERVAL`, considerably longer
 * if it is Google — so there is a window after a switch completes where the
 * phone is behind. The app is the answer to "what am I working"; the calendar
 * is a convenience that is usually right. Saying so is the difference between a
 * resident who double-checks and one who turns up on the wrong day.
 */
export function CalendarSubscription() {
  const [url, setUrl] = React.useState<string | null>(null);
  const [active, setActive] = React.useState<boolean | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ active: boolean }>("/api/calendar/subscription", {
      signal: controller.signal,
    })
      .then((result) => setActive(result.active))
      /* A read that fails leaves `active` null, which renders the create
         button — the honest default, because pressing it is safe either way:
         the server rotates an existing feed rather than erroring. */
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const create = useAction(
    async () =>
      apiFetch<{ url: string; rotated: boolean }>("/api/calendar/subscription", {
        method: "POST",
      }),
    {
      onSuccess: (result) => {
        setUrl(result.url);
        setActive(true);
        setCopied(false);
      },
    },
  );

  const revoke = useAction(
    async () => apiFetch("/api/calendar/subscription", { method: "DELETE" }),
    {
      onSuccess: () => {
        setActive(false);
        setUrl(null);
        setConfirmingRevoke(false);
      },
    },
  );

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      /* Clipboard access is refused in plenty of ordinary situations — an
         insecure origin, a browser setting, an embedded webview. The link is
         on screen and selectable, so there is nothing to recover from and
         nothing worth interrupting somebody about. */
    }
  }

  return (
    <section>
      <Card>
        <CardBody className="space-y-3">
          <div>
            <p className="font-semibold text-ink">Your shifts in your calendar</p>
            <p className="mt-1 text-sm text-ink-muted">
              Subscribe in Apple Calendar, Google Calendar or Outlook and your
              shifts appear alongside everything else. It updates itself, so a
              completed switch reaches your calendar without you doing anything.
            </p>
          </div>

          {url ? (
            <div className="rounded-xl bg-surface-muted p-3">
              <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                Your link
              </p>
              <p className="mt-1 font-mono text-xs break-all text-ink select-all">
                {url}
              </p>
              <Button
                className="mt-2"
                variant="secondary"
                size="sm"
                onClick={() => void copy()}
              >
                {copied ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy link"}
              </Button>
              <p className="mt-2 text-xs text-ink-subtle">
                Copy it now — we store it scrambled, so we cannot show it to you
                again. Anyone who has the link can read when you are working, so
                keep it to yourself. If it gets out, make a new one below and the
                old one stops working.
              </p>
            </div>
          ) : null}

          <ActionAlert action={create} />

          <Button
            block
            variant="secondary"
            loading={create.pending}
            onClick={() => void create.run()}
          >
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            {active ? "Make a new link" : "Create my calendar link"}
          </Button>

          {active ? (
            <Button
              block
              variant="ghost"
              className="text-critical"
              onClick={() => setConfirmingRevoke(true)}
            >
              Turn the calendar feed off
            </Button>
          ) : null}

          <Alert tone="info">
            Your calendar checks for changes every so often, and some apps are
            slower than others. ShiftSwitch is always the answer to what you are
            working today.
          </Alert>
        </CardBody>
      </Card>

      <Sheet
        open={confirmingRevoke}
        onClose={() => setConfirmingRevoke(false)}
        title="Turn the calendar feed off?"
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              block
              onClick={() => setConfirmingRevoke(false)}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              block
              loading={revoke.pending}
              onClick={() => void revoke.run()}
            >
              Turn it off
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-muted">
          Your link stops working straight away, and any calendar subscribed to
          it stops updating. The shifts already copied into your calendar stay
          there until you remove the subscription in the calendar app itself.
        </p>
        <ActionAlert action={revoke} className="mt-3" />
      </Sheet>
    </section>
  );
}
