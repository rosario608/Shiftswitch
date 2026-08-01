"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Link2, UserCheck, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Getting a class into the product.
 *
 * One link, handed to everybody, is the difference between onboarding a
 * programme in an afternoon and typing forty addresses. The screen is built
 * around that: make a link, copy it, and then watch two queues drain — people
 * whose account needs confirming, and shifts waiting for somebody to sign in.
 *
 * The link itself is shown exactly once, when it is made. There is no screen
 * that can show it again, because only its hash was stored — so the copy button
 * is the primary action of the moment it appears, not an afterthought.
 */

export interface LinkView {
  id: string;
  label: string;
  status: "active" | "revoked" | "expired" | "used_up";
  statusLabel: string;
  expiresAt: string;
  maxUses: number | null;
  uses: number;
  joined: number;
}

export interface PendingView {
  userId: string;
  email: string;
  fullName: string;
  shifts: number;
}

export interface UnmatchedView {
  name: string;
  key: string;
  email: string;
  shifts: number;
  firstDate: string;
  lastDate: string;
}

const STATUS_TONE: Record<LinkView["status"], BadgeTone> = {
  active: "positive",
  revoked: "neutral",
  expired: "neutral",
  used_up: "neutral",
};

export function EnrollmentManager({
  links,
  pending,
  unmatched,
}: {
  links: LinkView[];
  pending: PendingView[];
  unmatched: UnmatchedView[];
}) {
  const router = useRouter();
  const [freshUrl, setFreshUrl] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState("");

  const create = useAction(
    async () =>
      apiFetch<{ url: string }>("/api/admin/enrollment/links", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() || undefined }),
      }),
    {
      onSuccess: (response) => {
        setFreshUrl(response.url);
        setLabel("");
        router.refresh();
      },
    },
  );

  const revoke = useAction(
    async (id: string) =>
      apiFetch(`/api/admin/enrollment/links/${id}/revoke`, { method: "POST" }),
    { onSuccess: () => router.refresh() },
  );

  const admit = useAction(
    async (userId: string) =>
      apiFetch(`/api/admin/enrollment/members/${userId}/admit`, { method: "POST" }),
    { onSuccess: () => router.refresh() },
  );

  const discard = useAction(
    async (key: string) =>
      apiFetch(`/api/admin/import/unmatched/${encodeURIComponent(key)}`, {
        method: "DELETE",
      }),
    { onSuccess: () => router.refresh() },
  );

  const active = links.filter((link) => link.status === "active");

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-4">
          <div>
            <p className="font-semibold text-ink">One link for everybody</p>
            <p className="mt-1 text-sm text-ink-muted">
              Post it wherever your residents already talk. Whoever opens it signs
              in with Google and lands on whatever your uploaded schedule says
              about them. It lasts 30 days and you can turn it off at any time.
            </p>
          </div>

          <Field
            label="What is this link for?"
            htmlFor="enrollment-link-label"
            hint="Only you see this. For example: PGY-2s, July block."
          >
            <Input
              id="enrollment-link-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="PGY-2s, July block"
              maxLength={120}
            />
          </Field>

          <Button
            block
            loading={create.pending}
            loadingLabel="Making the link…"
            onClick={() => create.run()}
          >
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Make a link
          </Button>
          <ActionAlert action={create} />

          {freshUrl ? <FreshLink url={freshUrl} /> : null}
        </CardBody>
      </Card>

      {pending.length > 0 ? (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="font-semibold text-ink">
                {pending.length} {pending.length === 1 ? "person is" : "people are"}{" "}
                waiting for you
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                They joined with an address that is not on your program&rsquo;s
                domain list, so for now they can only see their own schedule.
                Confirm the ones you recognise.
              </p>
            </div>
            <ul className="space-y-2">
              {pending.map((person) => (
                <li
                  key={person.userId}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border-base pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{person.fullName}</p>
                    <p className="truncate text-sm text-ink-muted">{person.email}</p>
                    <p className="text-xs text-ink-subtle">
                      {person.shifts} shift{person.shifts === 1 ? "" : "s"} already on
                      their schedule
                    </p>
                  </div>
                  <Button
                    size="sm"
                    loading={admit.pending}
                    onClick={() => admit.run(person.userId)}
                  >
                    <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    Confirm
                  </Button>
                </li>
              ))}
            </ul>
            <ActionAlert action={admit} />
          </CardBody>
        </Card>
      ) : null}

      {unmatched.length > 0 ? (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="font-semibold text-ink">
                Shifts waiting for {unmatched.length}{" "}
                {unmatched.length === 1 ? "person" : "people"}
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                Your uploaded schedule names them, but they have not signed in yet.
                Their shifts appear the moment they do — there is nothing to do
                here unless one of these is somebody who is not coming.
              </p>
            </div>
            <ul className="space-y-2">
              {unmatched.map((person) => (
                <li
                  key={person.key}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border-base pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{person.name}</p>
                    <p className="text-sm text-ink-muted">
                      {person.shifts} shift{person.shifts === 1 ? "" : "s"} ·{" "}
                      {person.firstDate} to {person.lastDate}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={discard.pending}
                    onClick={() => discard.run(person.key)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Not coming
                  </Button>
                </li>
              ))}
            </ul>
            <ActionAlert action={discard} />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardBody className="space-y-3">
          <p className="font-semibold text-ink">
            Links you have made
            {active.length > 0 ? ` · ${active.length} working now` : ""}
          </p>
          {links.length === 0 ? (
            <EmptyState
              title="No links yet"
              description="Make one above and post it where your residents will see it."
            />
          ) : (
            <ul className="space-y-2">
              {links.map((link) => (
                <li
                  key={link.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border-base pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">
                      {link.label || "Untitled link"}
                    </p>
                    <p className="text-sm text-ink-muted">
                      {link.joined} joined
                      {link.maxUses ? ` of ${link.maxUses}` : ""} · until{" "}
                      {link.expiresAt}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONE[link.status]}>{link.statusLabel}</Badge>
                    {link.status === "active" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={revoke.pending}
                        onClick={() => revoke.run(link.id)}
                      >
                        Turn off
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <ActionAlert action={revoke} />
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The one moment the link exists in readable form.
 *
 * Deliberately loud, and deliberately says so: an administrator who navigates
 * away without copying it has to make another one, and being told that after
 * the fact is the difference between a shrug and a support message.
 */
function FreshLink({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Alert tone="success" title="Your link is ready. Copy it now.">
      <p className="mt-1 break-all font-mono text-xs text-ink">{url}</p>
      <div className="mt-2">
        <Button
          size="sm"
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
      </div>
      <p className="mt-2 text-xs">
        This is the only time it is shown. We keep only a scrambled copy, so if
        you lose it you make a new one rather than looking it up.
      </p>
    </Alert>
  );
}
