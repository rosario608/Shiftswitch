import { useState } from "react";
import { useParams } from "react-router";
import { api, ApiError } from "@/api/client";
import type { CompletedTrade, SwitchEmail } from "@/api/types";
import { Screen } from "@/components/Screen";
import { ShiftCard } from "@/components/ShiftCard";
import {
  Button,
  Card,
  ErrorState,
  InlineNotice,
  Pill,
  SectionHeading,
  Sheet,
  Skeleton,
  useToast,
} from "@/components/ui";
import { formatLongDate } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { successFeedback } from "@/native/shell";

interface SwitchResponse {
  trade: CompletedTrade;
  timezone: string;
}

/**
 * A completed switch, and the program notification that goes with it.
 *
 * The email is composed by the server and handed to the phone's mail app
 * through a `mailto:` link — it is sent from the resident's own mailbox, from
 * their real address, exactly as a coordinator expects. The app never sends
 * mail on someone's behalf, and never claims it did: the status here says
 * "Opened in your mail app", and only the resident can mark it as sent.
 */
export function SwitchDetailScreen() {
  const { tradeId } = useParams<{ tradeId: string }>();
  const toast = useToast();
  const [email, setEmail] = useState<SwitchEmail | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const resource = useResource<SwitchResponse>(
    (signal) => api.get<SwitchResponse>(`/api/switches/${tradeId}`, { signal }),
    [tradeId],
  );

  const trade = resource.data?.trade;
  const timezone = resource.data?.timezone ?? "UTC";

  async function prepareEmail() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.post<{ email: SwitchEmail }>(
        `/api/switches/${tradeId}/email`,
      );
      setEmail(result.email);
      setEmailOpen(true);
    } catch (caught) {
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "Could not prepare the email.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openInMailApp() {
    if (!email) return;
    // Handing off to the mail app leaves this webview; record that it was
    // opened first so the record is accurate even if the user never comes back.
    await api
      .post(`/api/emails/${email.emailRecordId}/status`, { status: "opened" })
      .catch(() => undefined);
    globalThis.location.href = email.mailtoUrl;
  }

  return (
    <Screen
      title="Completed switch"
      back
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
    >
      {resource.loading && <Skeleton className="h-64" />}

      {resource.error && !trade && (
        <ErrorState
          message={resource.error.message}
          onRetry={() => void resource.reload()}
          retryable={resource.error.retryable}
        />
      )}

      {trade && (
        <div className="space-y-5">
          <InlineNotice tone="positive" title="This switch is in effect">
            Completed {formatLongDate(trade.completed_at, timezone)}. The
            schedule has already been updated for both of you.
          </InlineNotice>

          <section>
            <SectionHeading>{trade.resident_a_name} now works</SectionHeading>
            <ShiftCard shift={trade.destination_shift} timezone={timezone} />
          </section>

          <section>
            <SectionHeading>{trade.resident_b_name} now works</SectionHeading>
            <ShiftCard shift={trade.source_shift} timezone={timezone} />
          </section>

          {trade.approved_at && (
            <Card>
              <p className="text-sm text-ink-muted">
                Approved {formatLongDate(trade.approved_at, timezone)}.
              </p>
            </Card>
          )}

          <section>
            <SectionHeading>Tell your program</SectionHeading>
            <Card>
              <p className="text-sm text-ink-muted">
                Your coordinator needs this in writing. We&rsquo;ll write the
                email; it opens in your own mail app so it comes from you.
              </p>
              {trade.email_status && (
                <div className="mt-2">
                  <Pill
                    tone={
                      trade.email_status === "marked_sent" ? "positive" : "caution"
                    }
                  >
                    {trade.email_status === "marked_sent"
                      ? "You marked this as sent"
                      : "Prepared, not yet marked as sent"}
                  </Pill>
                </div>
              )}
              {failure && (
                <div className="mt-3">
                  <InlineNotice tone="critical">{failure}</InlineNotice>
                </div>
              )}
              <Button
                block
                className="mt-3"
                busy={busy}
                onClick={() => void prepareEmail()}
              >
                {trade.email_status ? "Open the email again" : "Prepare the email"}
              </Button>
            </Card>
          </section>
        </div>
      )}

      <Sheet
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        title="Program notification"
      >
        {email && (
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs font-semibold text-ink-subtle uppercase">To</p>
              <p className="selectable text-ink">{email.to.join(", ")}</p>
            </div>
            {email.cc.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-ink-subtle uppercase">
                  Cc
                </p>
                <p className="selectable text-ink">{email.cc.join(", ")}</p>
              </div>
            )}
            <div>
              <p className="text-xs font-semibold text-ink-subtle uppercase">
                Subject
              </p>
              <p className="selectable font-medium text-ink">{email.subject}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-ink-subtle uppercase">
                Message
              </p>
              <pre className="selectable mt-1 rounded-lg bg-surface-muted p-3 text-xs whitespace-pre-wrap text-ink">
                {email.body}
              </pre>
            </div>

            <Button block onClick={() => void openInMailApp()}>
              Open in my mail app
            </Button>
            <Button
              block
              variant="secondary"
              onClick={async () => {
                await api
                  .post(`/api/emails/${email.emailRecordId}/status`, {
                    status: "marked_sent",
                  })
                  .catch(() => undefined);
                await successFeedback();
                setEmailOpen(false);
                toast.show("Marked as sent.");
                await resource.reload();
              }}
            >
              I&rsquo;ve sent it
            </Button>
            <p className="text-xs text-ink-subtle">
              ShiftSwitch cannot see your mailbox, so it can&rsquo;t tell whether
              you sent it. Marking it here is just for your program&rsquo;s
              record.
            </p>
          </div>
        )}
      </Sheet>

      {toast.node}
    </Screen>
  );
}
