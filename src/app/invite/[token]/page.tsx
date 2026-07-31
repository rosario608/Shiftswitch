import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { findUsableInvitation } from "@/server/domain/invitations";
import { getSessionContext } from "@/server/auth/session";
import { ROLE_LABEL } from "@/server/auth/roles";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your invitation",
  robots: { index: false, follow: false },
};

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ShiftSwitch";

/**
 * The public invitation page.
 *
 * Deliberately outside the authenticated area: the person opening it has, by
 * definition, no account yet. It shows who invited them and to what, so the
 * link does not look like phishing, and then hands off to the same Google
 * sign-in the rest of the application uses — carrying the token so the callback
 * can redeem it.
 *
 * A token that is expired, revoked, already used or simply wrong renders the
 * same neutral message. Distinguishing them would only help somebody guessing.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await findUsableInvitation(token);

  // Somebody already signed in who opens an invitation for themselves should
  // just go to the app rather than be told to sign in again.
  const session = await getSessionContext();
  if (session && invitation && session.user.email.toLowerCase() === invitation.email.toLowerCase()) {
    redirect("/");
  }

  if (!invitation) {
    return (
      <main id="main" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
        <div className="rounded-card border border-border-base bg-surface p-6 text-center">
          <h1 className="text-xl font-semibold text-ink">This invitation isn&rsquo;t valid</h1>
          <p className="mt-2 text-sm text-ink-muted">
            It may have expired, been cancelled, or already been used. Ask your
            program administrator to send you a new one.
          </p>
        </div>
      </main>
    );
  }

  const roleLabel = ROLE_LABEL[invitation.role];

  const startUrl = `/api/auth/google/start?invite=${encodeURIComponent(token)}`;

  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-1 flex-col justify-center px-5 py-10"
    >
      <div className="mb-8 text-center">
        <span
          aria-hidden="true"
          className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-lg font-bold text-white"
        >
          SS
        </span>
        <p className="text-sm font-medium text-brand-ink">You&rsquo;ve been invited</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink">
          {invitation.programName}
        </h1>
        <p className="text-sm text-ink-muted">{invitation.institution}</p>
      </div>

      <div className="rounded-card border border-border-base bg-surface p-5 text-sm">
        <dl className="space-y-3">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-subtle">Invited as</dt>
            <dd className="font-medium text-ink capitalize">{roleLabel}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-subtle">Your email</dt>
            <dd className="font-medium text-ink">{invitation.email}</dd>
          </div>
          {invitation.invitedByName ? (
            <div className="flex justify-between gap-4">
              <dt className="text-ink-subtle">Invited by</dt>
              <dd className="font-medium text-ink">{invitation.invitedByName}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <a
        href={startUrl}
        className="mt-6 flex min-h-[3.25rem] w-full items-center justify-center gap-3 rounded-xl border border-border-strong bg-surface px-5 text-base font-semibold text-ink shadow-sm hover:bg-surface-muted"
      >
        <GoogleMark />
        Continue with Google
      </a>

      <p className="mt-3 text-center text-sm text-ink-subtle">
        Sign in with <span className="font-medium text-ink">{invitation.email}</span>.
        That address has to match, so this link only works for you.
      </p>

      <p className="mt-6 text-center text-xs text-ink-subtle">
        {APP_NAME} shows you your shifts and lets you swap them with your
        co-residents. It never handles patient information.
      </p>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.5 14.5 0 019.5 24c0-1.6.28-3.15.77-4.59l-7.98-6.19A23.94 23.94 0 000 24c0 3.88.93 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.9-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.17 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
