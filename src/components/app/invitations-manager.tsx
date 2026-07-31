"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, FlaskConical, Mail, RotateCw, UserPlus, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { EmailListInput, toEntries } from "@/components/ui/email-input";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

export interface InvitationRecord {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  send_count: number;
  invited_by_name: string | null;
  accepted_user_email: string | null;
  created_at: string;
}

export interface RoleOption {
  value: string;
  label: string;
  description: string;
}

const STATUS_TONE: Record<InvitationRecord["status"], BadgeTone> = {
  pending: "caution",
  accepted: "positive",
  revoked: "neutral",
  expired: "critical",
};

/**
 * Inviting people into a program.
 *
 * The entry field is a conventional multi-address input rather than a textarea
 * whose rules you have to read: chips you can see and remove, per-address
 * validity, and every separator anybody actually uses. The old version required
 * the administrator to understand how the field would be parsed before typing,
 * which is not a thing a program coordinator should have to know.
 *
 * Delivery is by copy-and-send by default, because ShiftSwitch has no mail
 * server and a message from a real person at the hospital's own domain is more
 * likely to be trusted than one from a domain nobody recognises. Where the
 * environment cannot send at all, it says so instead of implying it did.
 */
export function InvitationsManager({
  invitations,
  roleOptions,
  delivery,
  sandbox,
}: {
  invitations: InvitationRecord[];
  /** The roles this person is allowed to hand out — nothing above their own. */
  roleOptions: RoleOption[];
  delivery: { enabled: boolean; reason: string };
  /** Development only: walk the acceptance flow without a second Google account. */
  sandbox: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [emails, setEmails] = React.useState<string[]>([]);
  const [role, setRole] = React.useState(roleOptions[0]?.value ?? "resident");
  const [pgy, setPgy] = React.useState("");
  const [links, setLinks] = React.useState<Array<{ email: string; url: string }>>([]);
  const [rejected, setRejected] = React.useState<Array<{ email: string; reason: string }>>(
    [],
  );

  const entries = toEntries(emails);
  const usable = entries.filter((entry) => entry.valid && !entry.duplicate);
  const blocked = entries.some((entry) => !entry.valid);
  const selectedRole = roleOptions.find((option) => option.value === role);

  const invite = useAction(async () => {
    if (usable.length === 0) {
      throw new Error("Add at least one email address.");
    }
    if (blocked) {
      throw new Error("Fix or remove the addresses marked in red first.");
    }
    const result = await apiFetch<{
      created: Array<{ email: string; url: string; id: string }>;
      failed: Array<{ email: string; reason: string }>;
    }>("/api/admin/invitations", {
      method: "POST",
      body: JSON.stringify({
        emails: usable.map((entry) => entry.value),
        role,
        pgyLevel: role === "resident" && pgy ? Number(pgy) : null,
      }),
    });
    setLinks(result.created.map(({ email, url }) => ({ email, url })));
    setRejected(result.failed);
    if (result.created.length > 0) {
      setEmails([]);
      router.refresh();
    }
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose">
          <h2 className="text-lg font-semibold text-ink">Invitations</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Invite people by email address. They sign in with Google using that
            same address and land directly in this program with the role you
            chose.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          Invite people
        </Button>
      </div>

      {!delivery.enabled && (
        <Alert tone="warning">
          <p className="font-medium">No email is sent from here.</p>
          <p className="mt-0.5">{delivery.reason}</p>
        </Alert>
      )}

      {invitations.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-ink-muted">
            Nobody has been invited yet. Invite your residents first — the
            schedule import matches shifts to people by email address, so the
            accounts need to exist before you import.
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-2">
          {invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              roleOptions={roleOptions}
              sandbox={sandbox}
            />
          ))}
        </ul>
      )}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Invite people"
        description="Everyone in this batch gets the same role. Invite again for a different one."
      >
        <div className="space-y-5">
          <Field label="Who are you inviting?" htmlFor="invite-emails">
            <EmailListInput id="invite-emails" values={emails} onChange={setEmails} />
          </Field>

          <Field label="What can they do?" htmlFor="invite-role">
            <Select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {roleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          {selectedRole && (
            <p className="-mt-3 text-xs text-ink-subtle">{selectedRole.description}</p>
          )}

          {role === "resident" && (
            <Field
              label="Training level (optional)"
              htmlFor="invite-pgy"
              hint="Applied to everyone in this batch. You can change it per person later."
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

          <div className="rounded-card border border-border-base bg-surface-muted p-3 text-sm text-ink-muted">
            <p className="font-medium text-ink">What happens when you invite</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              <li>An invitation is created for each address, valid for 14 days.</li>
              <li>
                {delivery.enabled
                  ? "ShiftSwitch emails each person their link."
                  : "You get a link per person to send yourself — nothing is emailed from here."}
              </li>
              <li>They sign in with Google using that address and join this program.</li>
            </ol>
          </div>

          {invite.error && <Alert tone="error">{invite.error}</Alert>}

          {rejected.length > 0 && (
            <Alert tone="warning">
              <p className="font-medium">Some addresses were not invited:</p>
              <ul className="mt-1 space-y-1">
                {rejected.map((entry) => (
                  <li key={entry.email}>
                    <span className="font-medium">{entry.email}</span> — {entry.reason}
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
                Send each person their own link. Each one only works for the
                address it was created for, and only once.
              </p>
              <ul className="mt-3 space-y-2">
                {links.map((link) => (
                  <InvitationLink
                    key={link.email}
                    email={link.email}
                    url={link.url}
                    sandbox={sandbox}
                  />
                ))}
              </ul>
            </div>
          )}

          <Button
            block
            loading={invite.pending}
            disabled={usable.length === 0 || blocked}
            onClick={invite.run}
          >
            {usable.length === 0
              ? "Invite"
              : `Invite ${usable.length} ${usable.length === 1 ? "person" : "people"}`}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function InvitationLink({
  email,
  url,
  sandbox,
}: {
  email: string;
  url: string;
  sandbox: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <li className="rounded-lg bg-surface p-2 text-xs">
      <p className="font-medium text-ink">{email}</p>
      <p className="mt-1 break-all text-ink-muted">{url}</p>
      <div className="mt-2 flex flex-wrap gap-2">
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
          Email it myself
        </a>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 font-medium text-ink"
        >
          Open it
        </a>
        {sandbox && <AcceptAsInvitee url={url} email={email} />}
      </div>
    </li>
  );
}

/**
 * The development sandbox control.
 *
 * It stands in for Google, not for the invitation: the invitation, its token,
 * its expiry and the acceptance transaction are all the production ones. What
 * this replaces is only the part a single person cannot do alone — being a
 * second Google account.
 */
function AcceptAsInvitee({ url, email }: { url: string; email: string }) {
  const router = useRouter();
  const token = url.split("/invite/")[1] ?? "";

  const accept = useAction(
    async () =>
      apiFetch("/api/dev/accept-invitation", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    {
      onSuccess: () => {
        // The session is now the invitee's, so go where they would land.
        router.push("/");
        router.refresh();
      },
    },
  );

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        loading={accept.pending}
        onClick={accept.run}
        title={`Sign in as ${email} using a synthetic account`}
      >
        <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
        Accept as {email.split("@")[0]}
      </Button>
      {accept.error && (
        <span className="w-full text-xs font-medium text-critical">{accept.error}</span>
      )}
    </>
  );
}

function InvitationRow({
  invitation,
  roleOptions,
  sandbox,
}: {
  invitation: InvitationRecord;
  roleOptions: RoleOption[];
  sandbox: boolean;
}) {
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
  const roleLabel =
    roleOptions.find((option) => option.value === invitation.role)?.label ??
    invitation.role;

  return (
    <li>
      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{invitation.email}</p>
              <p className="text-xs text-ink-subtle">
                {roleLabel}
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

          {link && (
            <InvitationLink email={invitation.email} url={link} sandbox={sandbox} />
          )}

          {invitation.status !== "accepted" && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={resend.pending}
                onClick={resend.run}
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                {pending ? "Get a fresh link" : "Send a new invitation"}
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

          {pending && (
            <p className="text-xs text-ink-subtle">
              Links are stored hashed and cannot be shown again — use “Get a fresh
              link” to produce a new one. The previous link stops working.
            </p>
          )}
        </CardBody>
      </Card>
    </li>
  );
}
