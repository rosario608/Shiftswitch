import { redirect } from "next/navigation";
import { CalendarCheck, ShieldCheck, Zap } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { getSessionContext } from "@/server/auth/session";
import { TestLoginPanel } from "@/components/app/test-login";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ShiftSwitch";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured:
    "Google sign-in isn't configured on this server yet. Contact your program administrator.",
  config:
    "Google sign-in isn't configured on this server yet. Contact your program administrator.",
  state: "That sign-in attempt expired. Please try again.",
  cancelled: "Sign-in was cancelled.",
  token_exchange: "Google couldn't complete the sign-in. Please try again.",
  id_token: "We couldn't verify your Google account. Please try again.",
  email_unverified:
    "Your Google account's email address isn't verified, so we can't sign you in.",
  domain:
    "That Google account isn't on your program's approved email domain list. Contact your program administrator.",
  deactivated: "Your account has been deactivated. Contact your program administrator.",
  unknown: "Something went wrong signing you in. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const session = await getSessionContext();
  if (session) redirect("/");

  const params = await searchParams;
  const error = params.error ? (ERROR_MESSAGES[params.error] ?? ERROR_MESSAGES.unknown) : null;
  const returnTo = params.returnTo && params.returnTo.startsWith("/") ? params.returnTo : "/";
  const startUrl = `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;

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
        <h1 className="text-3xl font-semibold text-ink">{APP_NAME}</h1>
        <p className="mt-2 text-ink-muted">
          Swap residency shifts from your phone — validated against your program&rsquo;s
          rules, with the coordinator email written for you.
        </p>
      </div>

      {error ? (
        <Alert tone="error" className="mb-5">
          {error}
        </Alert>
      ) : null}

      <a
        href={startUrl}
        className="flex min-h-[3.25rem] w-full items-center justify-center gap-3 rounded-xl border border-border-strong bg-surface px-5 text-base font-semibold text-ink shadow-sm hover:bg-surface-muted"
      >
        <GoogleMark />
        Continue with Google
      </a>

      <p className="mt-3 text-center text-sm text-ink-subtle">
        Use your hospital or institutional Google account. No separate password.
      </p>

      <ul className="mt-10 space-y-4">
        <Feature
          Icon={Zap}
          title="Post a shift in seconds"
          description="Pick a shift, add a note, and colleagues can offer a swap."
        />
        <Feature
          Icon={ShieldCheck}
          title="Rules checked before you commit"
          description="Rest, consecutive shifts, PGY and service requirements are validated on the server."
        />
        <Feature
          Icon={CalendarCheck}
          title="Both schedules update together"
          description="A switch is a single atomic transaction — never half-applied."
        />
      </ul>

      <TestLoginPanel />
    </main>
  );
}

function Feature({
  Icon,
  title,
  description,
}: {
  Icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
        <Icon className="h-4.5 w-4.5" aria-hidden="true" />
      </span>
      <span>
        <span className="block font-semibold text-ink">{title}</span>
        <span className="block text-sm text-ink-muted">{description}</span>
      </span>
    </li>
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
