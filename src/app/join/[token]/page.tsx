import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { findUsableEnrollmentLink } from "@/server/domain/enrollment";
import { getSessionContext } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Join your program",
  robots: { index: false, follow: false },
};

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ShiftSwitch";

/**
 * The public enrollment page.
 *
 * The same shape as the invitation page and for the same reason: the person
 * opening it has no account, and a link that jumps straight to Google without
 * saying whose program it is reads as phishing to anybody paying attention.
 *
 * The difference is that this link names no address, so this page cannot say
 * "sign in as you". What it says instead is which program, and that the address
 * they choose is the one their schedule will be found under — because that is
 * the decision they are actually making, and getting it wrong is the one
 * mistake here that costs somebody a phone call.
 *
 * A link that is expired, revoked, used up or simply wrong renders one neutral
 * message. Distinguishing them would only help somebody guessing.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const offer = await findUsableEnrollmentLink(token);

  /* Somebody already signed in to this product who opens a join link is
     already where the link was trying to send them. */
  const session = await getSessionContext();
  if (session?.user.programId) redirect("/");

  if (!offer) {
    return (
      <main
        id="main"
        className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10"
      >
        <div className="rounded-card border border-border-base bg-surface p-6 text-center">
          <h1 className="text-xl font-semibold text-ink">
            This link isn&rsquo;t working
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            It may have run out, been turned off, or been cut short when it was
            copied. Ask your chief or program coordinator for a new one — it takes
            them a few seconds.
          </p>
        </div>
      </main>
    );
  }

  const startUrl = `/api/auth/google/start?enroll=${encodeURIComponent(token)}`;

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
        <p className="text-sm font-medium text-brand-ink">Join your program</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink">{offer.programName}</h1>
        <p className="text-sm text-ink-muted">{offer.institution}</p>
        {offer.label ? (
          <p className="mt-1 text-sm text-ink-subtle">{offer.label}</p>
        ) : null}
      </div>

      <a
        href={startUrl}
        className="flex min-h-[3.25rem] w-full items-center justify-center gap-3 rounded-xl border border-border-strong bg-surface px-5 text-base font-semibold text-ink shadow-sm hover:bg-surface-muted"
      >
        <GoogleMark />
        Continue with Google
      </a>

      <p className="mt-3 text-center text-sm text-ink-subtle">
        Use the address your program knows you by. Your shifts are matched to your
        name, so if you already have a schedule here it will be waiting when you
        get in.
      </p>

      <p className="mt-6 text-center text-xs text-ink-subtle">
        {APP_NAME} shows you your shifts and lets you switch them with your
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
