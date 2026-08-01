"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Mail, Send } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction, useOnline } from "@/lib/use-action";

interface GeneratedEmail {
  emailRecordId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  status: "generated" | "opened" | "marked_sent";
  mailtoUrl: string;
}

const STATUS_LABEL: Record<string, string> = {
  not_generated: "Not generated",
  generated: "Generated",
  opened: "Opened in email",
  marked_sent: "Marked as sent",
};

/**
 * Program notification.
 *
 * The email is generated on the server from the completed-trade record, so the
 * schedule details are always accurate. Delivery happens in the resident's own
 * mail client via a `mailto:` link — the app therefore never claims an email was
 * delivered; it tracks Generated → Opened → Marked sent.
 */
export function NotifyProgramPanel({
  completedTradeId,
  initialEmail,
}: {
  completedTradeId: string;
  initialEmail: GeneratedEmail | null;
}) {
  const router = useRouter();
  const online = useOnline();
  const [email, setEmail] = React.useState<GeneratedEmail | null>(initialEmail);
  const [to, setTo] = React.useState(initialEmail?.to.join(", ") ?? "");
  const [cc, setCc] = React.useState(initialEmail?.cc.join(", ") ?? "");
  const [subject, setSubject] = React.useState(initialEmail?.subject ?? "");
  const [body, setBody] = React.useState(initialEmail?.body ?? "");
  const [copied, setCopied] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  const applyEmail = React.useCallback((next: GeneratedEmail) => {
    setEmail(next);
    setTo(next.to.join(", "));
    setCc(next.cc.join(", "));
    setSubject(next.subject);
    setBody(next.body);
    setDirty(false);
  }, []);

  const generate = useAction(
    async () =>
      apiFetch<{ email: GeneratedEmail }>(`/api/switches/${completedTradeId}/email`, {
        method: "POST",
      }),
    {
      onSuccess: (result) => {
        applyEmail(result.email);
        router.refresh();
      },
    },
  );

  const save = useAction(
    async () =>
      apiFetch<{ email: GeneratedEmail }>(`/api/emails/${email?.emailRecordId}`, {
        method: "PATCH",
        body: JSON.stringify({
          to: splitAddresses(to),
          cc: splitAddresses(cc),
          subject,
          body,
        }),
      }),
    { onSuccess: (result) => applyEmail(result.email) },
  );

  const setStatus = useAction(
    async (status: unknown) =>
      apiFetch<{ record: { status: GeneratedEmail["status"] } }>(
        `/api/emails/${email?.emailRecordId}/status`,
        { method: "POST", body: JSON.stringify({ status }) },
      ),
    {
      onSuccess: (result) => {
        setEmail((current) =>
          current ? { ...current, status: result.record.status } : current,
        );
        router.refresh();
      },
    },
  );

  const mailtoUrl = React.useMemo(() => {
    if (!email) return "";
    const params = new URLSearchParams();
    const ccList = splitAddresses(cc);
    if (ccList.length > 0) params.set("cc", ccList.join(","));
    params.set("subject", subject);
    params.set("body", body);
    return `mailto:${splitAddresses(to)
      .map((address) => encodeURIComponent(address))
      .join(",")}?${params.toString().replace(/\+/g, "%20")}`;
  }, [email, to, cc, subject, body]);

  async function copyEmail() {
    const text = `To: ${to}\nCc: ${cc}\nSubject: ${subject}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard permission denied — the textarea below is still selectable.
      setCopied(false);
    }
  }

  if (!email) {
    return (
      <Card>
        <CardBody>
          <p className="mb-3 text-sm text-ink-muted">
            Generate an email for your program coordinator with the exact details of
            this switch. You can edit it before sending.
          </p>
          {generate.error ? (
            <Alert tone="error" className="mb-3">
              {generate.error}
            </Alert>
          ) : null}
          <Button
            block
            disabled={!online}
            loading={generate.pending}
            loadingLabel="Preparing email…"
            onClick={() => generate.run()}
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            Notify program
          </Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="font-semibold text-ink">Program notification</p>
          <Badge tone={email.status === "marked_sent" ? "positive" : "caution"}>
            {STATUS_LABEL[email.status]}
          </Badge>
        </div>

        <ActionAlert action={save} />
        <ActionAlert action={setStatus} />

        <Field label="To" htmlFor="email-to" hint="Comma-separated addresses.">
          <Input
            id="email-to"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setDirty(true);
            }}
            inputMode="email"
          />
        </Field>
        <Field label="Cc" htmlFor="email-cc">
          <Input
            id="email-cc"
            value={cc}
            onChange={(event) => {
              setCc(event.target.value);
              setDirty(true);
            }}
            inputMode="email"
          />
        </Field>
        <Field label="Subject" htmlFor="email-subject">
          <Input
            id="email-subject"
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Field label="Message" htmlFor="email-body">
          <Textarea
            id="email-body"
            rows={14}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setDirty(true);
            }}
            className="font-mono text-sm"
          />
        </Field>

        {dirty ? (
          <Button
            variant="secondary"
            block
            disabled={!online}
            loading={save.pending}
            loadingLabel="Saving…"
            onClick={() => save.run()}
          >
            Save changes
          </Button>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <a
            href={mailtoUrl}
            onClick={() => setStatus.run("opened")}
            className="flex min-h-[2.75rem] items-center justify-center gap-2 rounded-xl bg-brand px-4 font-semibold text-white"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Open in email
          </a>
          <Button variant="secondary" block onClick={copyEmail}>
            {copied ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden="true" />
                Copy email
              </>
            )}
          </Button>
        </div>

        <Alert tone="info">
          ShiftSwitch prepares this email — your own mail app sends it. Mark it as
          sent once you have.
        </Alert>

        {email.status !== "marked_sent" ? (
          <Button
            variant="soft"
            block
            disabled={!online}
            loading={setStatus.pending}
            loadingLabel="Updating…"
            onClick={() => setStatus.run("marked_sent")}
          >
            Mark as sent
          </Button>
        ) : null}

        <div aria-live="polite" className="sr-only">
          {copied ? "Email copied to clipboard" : ""}
        </div>
      </CardBody>
    </Card>
  );
}

function splitAddresses(value: string): string[] {
  return value
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}
