"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Mail, RotateCw, UserPlus, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

export interface InvitationRecord {
  id: string;
  email: string;
  role: "resident" | "chief" | "admin";
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  send_count: number;
  invited_by_name: string | null;
  accepted_user_email: string | null;
  created_at: string;
}

const ROLE_LABEL: Record<string, string> = {
  resident: "Resident",
  chief: "Chief resident",
  admin: "Administrator",
};

const STATUS_TONE: Record<InvitationRecord["status"], BadgeTone> = {
  pending: "caution",
  accepted: "positive",
  revoked: "neutral",
  expired: "critical",
};

/**
 * Inviting residents into a program.
 *
 * The copy-the-link path is not a fallback for when email is broken — it is the
 * default, because ShiftSwitch has no mail server and a program coordinator
 * sending the link from their own mailbox is more likely to be trusted (and
 * less likely to be filtered) than a message from a domain nobody recognises.
 * If `RESEND_API_KEY` is configured the message is also sent automatically.
 */
export function InvitationsManager({
  invitations,
}: {
  invitations: InvitationRecord[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [emails, setEmails] = React.useState("");
  const [role, setRole] = React.useState<"resident" | "chief" | "admin">("resident");
  const [pgy, setPgy] = React.useState("");
  const [links, setLinks] = React.useState<Array<{ email: string; url: string }>>([]);
  const [rejected, setRejected] = React.useState<Array<{ email: string; reason: string }>>([]);

  const invite = useAction(async () => {
    // One per line or comma separated — whichever way the administrator has
    // their list.
    const parsed = emails
      .split(/[\n,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (parsed.length === 0) throw new Error("Enter at least one email address.");

    const result = await apiFetch<{
      created: Array<{ email: string; url: string; id: string }>;
      failed: Array<{ email: string; reason: string }>;
    }>("/api/admin/invitations", {
      method: "POST",
      body: JSON.stringify({
        emails: parsed,
        role,
        pgyLevel: role === "resident" && pgy ? Number(pgy) : null,
      }),
    });
    setLinks(result.created.map(({ email, url }) => ({ email, url })));
    setRejected(result.failed);
    if (result.created.length > 0) {
      setEmails("");
      router.refresh();
    }
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Invitations</h2>
          <p className="text-sm text-ink-muted">
            Invite residents by email. They sign in with Google and land straight
            in your program.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          Invite
        </Button>
      </div>

      {invitations.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-ink-muted">
            Nobody has been invited yet. Invite your residents, then import the
            schedule — the import matches shifts to people by email address.
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-2">
          {invitations.map((invitation) => (
            <InvitationRow key={invitation.id} invitation={invitation} />
          ))}
        </ul>
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="Invite people">
        <div className="space-y-4">
          <Field
            label="Email addresses"
            htmlFor="invite-emails"
            hint="One per line, or separated by commas."
          >
            <textarea
              id="invite-emails"
              rows={5}
              value={emails}
              onChange={(event) => setEmails(event.target.value)}
              placeholder={"resident.one@example.org\nresident.two@example.org"}
              className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-ink"
            />
          </Field>

          <Field label="Role" htmlFor="invite-role">
            <Select
              id="invite-role"
              value={role}
              onChange={(event) =>
                setRole(event.target.value as "resident" | "chief" | "admin")
              }
            >
              <option value="resident">Resident</option>
              <option value="chief">Chief resident</option>
              <option value="admin">Administrator</option>
            </Select>
          </Field>

          {role === "resident" && (
            <Field
              label="Training level (optional)"
              htmlFor="invite-pgy"
              hint="Applied to everyone in this batch. You can change it later under Users."
            >
              <Input
                id="invite-pgy"
                type="number"
                min={1}
                max={10}
                value={pgy}
                onChange={(event) => setPgy(event.target.value)}
                placeholder="e.g. 2"
              />
            </Field>
          )}

          {invite.error && <Alert tone="error">{invite.error}</Alert>}

          {rejected.length > 0 && (
            <Alert tone="warning">
              <p className="font-medium">Some addresses were not invited:</p>
              <ul className="mt-1 space-y-1">
                {rejected.map((entry) => (
                  <li key={entry.email}>
                    {entry.email} — {entry.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          {links.length > 0 && (
            <div className="rounded-card border border-positive/40 bg-positive-soft p-3">
              <p className="text-sm font-medium text-ink">
                {links.length} invitation{links.length === 1 ? "" : "s"} created.
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                Send each person their link. Each one only works for the address
                it was created for.
              </p>
              <ul className="mt-3 space-y-2">
                {links.map((link) => (
                  <InvitationLink key={link.email} email={link.email} url={link.url} />
                ))}
              </ul>
            </div>
          )}

          <Button block loading={invite.pending} onClick={invite.run}>
            Create invitations
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function InvitationLink({ email, url }: { email: string; url: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <li className="rounded-lg bg-surface p-2 text-xs">
      <p className="font-medium text-ink">{email}</p>
      <p className="mt-1 break-all text-ink-muted">{url}</p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(url).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy link"}
        </Button>
        <a
          href={`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(
            "Your ShiftSwitch invitation",
          )}&body=${encodeURIComponent(
            `You've been invited to ShiftSwitch.\n\nAccept your invitation:\n${url}\n\nSign in with Google using ${email}.`,
          )}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 font-medium text-ink"
        >
          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
          Email it
        </a>
      </div>
    </li>
  );
}

function InvitationRow({ invitation }: { invitation: InvitationRecord }) {
  const router = useRouter();
  const [link, setLink] = React.useState<string | null>(null);

  const resend = useAction(async () => {
    const result = await apiFetch<{ url: string }>(
      `/api/admin/invitations/${invitation.id}`,
      { method: "POST" },
    );
    setLink(result.url);
    router.refresh();
  });

  const revoke = useAction(async () => {
    await apiFetch(`/api/admin/invitations/${invitation.id}`, { method: "DELETE" });
    router.refresh();
  });

  const pending = invitation.status === "pending";

  return (
    <li>
      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{invitation.email}</p>
              <p className="text-xs text-ink-subtle">
                {ROLE_LABEL[invitation.role]}
                {invitation.invited_by_name
                  ? ` · invited by ${invitation.invited_by_name}`
                  : ""}
                {invitation.send_count > 1 ? ` · sent ${invitation.send_count}×` : ""}
              </p>
            </div>
            <Badge tone={STATUS_TONE[invitation.status]}>
              {invitation.status === "pending"
                ? `Expires ${new Date(invitation.expires_at).toLocaleDateString()}`
                : invitation.status === "accepted"
                  ? "Accepted"
                  : invitation.status === "revoked"
                    ? "Cancelled"
                    : "Expired"}
            </Badge>
          </div>

          {(resend.error || revoke.error) && (
            <Alert tone="error">{resend.error ?? revoke.error}</Alert>
          )}

          {link && <InvitationLink email={invitation.email} url={link} />}

          {invitation.status !== "accepted" && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={resend.pending}
                onClick={resend.run}
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                {pending ? "Resend" : "Send again"}
              </Button>
              {pending && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={revoke.pending}
                  onClick={revoke.run}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Cancel
                </Button>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </li>
  );
}
