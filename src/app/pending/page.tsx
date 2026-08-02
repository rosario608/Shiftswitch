import { redirect } from "next/navigation";
import { Clock3 } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { getSessionContext } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account not configured" };

/**
 * The screen for an account there is no programme to put in.
 *
 * It used to be the *ordinary* first-login experience: every new account
 * landed here and waited for an administrator to assign a role. That is no
 * longer how the product works — a new account joins as a resident and can use
 * it straight away — so reaching this page now means something genuinely
 * unusual and worth naming:
 *
 *  - the deployment has no programme yet, which is a setup step nobody has
 *    done rather than anything the person signing in did wrong; or
 *  - there are several programmes and the address does not say which, because
 *    none of them lists a matching email domain.
 *
 * Both are somebody else's job to fix, so the wording says who and what,
 * rather than the old "contact your program administrator" — advice that was
 * unactionable for the first person to ever sign in, since there was no
 * administrator to contact.
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
            There is no program to put you in yet
          </h1>
          <p className="mt-3 text-ink-muted">
            You are signed in — that part worked. ShiftSwitch just has no
            residency program set up for you to join, so there is no schedule
            and nothing to switch.
          </p>
          <p className="mt-3 text-ink-muted">
            Whoever set this up needs to create the program. Once they have,
            sign in again and you will go straight in.
          </p>
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
