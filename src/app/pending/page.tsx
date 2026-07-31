import { redirect } from "next/navigation";
import { Clock3 } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { getSessionContext } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account not configured" };

/**
 * First-login experience for an authenticated Google account that an
 * administrator has not yet assigned to a program (spec §7). No role is ever
 * granted implicitly.
 */
export default async function PendingPage() {
  const context = await getSessionContext();
  if (!context) redirect("/login");
  if (context.user.role && context.user.programId) redirect("/");

  return (
    <main id="main" className="mx-auto w-full max-w-md flex-1 px-5 py-12">
      <Card>
        <CardBody className="text-center">
          <span
            aria-hidden="true"
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-caution-soft text-caution"
          >
            <Clock3 className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-semibold text-ink">
            Your account is not yet configured.
          </h1>
          <p className="mt-3 text-ink-muted">
            Your Google account was authenticated successfully, but you have not yet
            been assigned to a residency program.
          </p>
          <p className="mt-3 text-ink-muted">Please contact your program administrator.</p>
          <div className="mt-6 rounded-xl bg-surface-muted px-4 py-3 text-left text-sm">
            <p className="font-semibold text-ink">Signed in as</p>
            <p className="text-ink-muted">{context.user.fullName}</p>
            <p className="text-ink-muted">{context.user.email}</p>
          </div>
          <a
            href="/api/auth/signout"
            className="mt-6 flex min-h-[2.75rem] items-center justify-center rounded-xl border border-border-strong px-4 font-semibold text-ink"
          >
            Sign out
          </a>
        </CardBody>
      </Card>
    </main>
  );
}
