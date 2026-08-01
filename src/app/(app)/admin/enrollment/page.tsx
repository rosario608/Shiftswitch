import { Card, CardBody } from "@/components/ui/card";
import { EnrollmentManager } from "@/components/app/enrollment-manager";
import { requirePageCapability } from "@/server/auth/page-guards";
import {
  LINK_STATUS_LABEL,
  listEmailDomains,
  listEnrollmentEvents,
  listEnrollmentLinks,
  listPendingMembers,
} from "@/server/domain/enrollment";
import { listUnmatched } from "@/server/domain/held-rows";
import { fmtDate, fmtTimestamp } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Getting people in" };

/**
 * Everything about how somebody joins this program, on one screen.
 *
 * Three questions, in the order they come up during a real onboarding: how do I
 * get people in, who is waiting on me, and whose shifts have nobody to give
 * them to. Splitting these across three screens is how the middle one gets
 * forgotten — a person who joined pending and was never confirmed sees a
 * product that half works and has nobody to tell.
 */
export default async function EnrollmentPage() {
  const context = await requirePageCapability("invitations.manage");
  const zone = context.program.timezone;

  const [links, pending, unmatched, domains, events] = await Promise.all([
    listEnrollmentLinks(context.program.id),
    listPendingMembers(context.program.id),
    listUnmatched(context.program.id),
    listEmailDomains(context.program.id),
    listEnrollmentEvents(context.program.id, 25),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Getting people in</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          {domains.length > 0
            ? `Anybody with an address at ${domains.join(" or ")} joins straight away. Everybody else joins able to see only their own schedule, until you confirm them below.`
            : "Your program has not listed its email domains, so everybody who joins can see only their own schedule until you confirm them. Adding your domains under Program settings lets your own people in without the extra step."}
        </p>
      </header>

      <EnrollmentManager
        links={links.map((link) => ({
          id: link.id,
          label: link.label,
          status: link.status,
          statusLabel: LINK_STATUS_LABEL[link.status],
          expiresAt: fmtDate(link.expires_at, zone),
          maxUses: link.max_uses,
          uses: link.uses,
          joined: link.joined,
        }))}
        pending={pending.map((person) => ({
          userId: person.user_id,
          email: person.email,
          fullName: person.full_name,
          shifts: person.shifts,
        }))}
        unmatched={unmatched.map((person) => ({
          name: person.resident_name,
          key: person.match_key,
          email: person.email,
          shifts: person.shifts,
          firstDate: person.first_date,
          lastDate: person.last_date,
        }))}
      />

      <Card>
        <CardBody className="space-y-3">
          <div>
            <p className="font-semibold text-ink">Every time somebody used a link</p>
            <p className="mt-1 text-sm text-ink-muted">
              Including the attempts that were refused. This is the record if you
              ever need to answer &ldquo;who let them in&rdquo;.
            </p>
          </div>
          {events.length === 0 ? (
            <p className="text-sm text-ink-subtle">Nobody has used a link yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-base pb-1.5 last:border-0 last:pb-0"
                >
                  <span className="font-medium text-ink">{event.email}</span>
                  <span className="text-ink-muted">
                    {OUTCOME_LABEL[event.outcome] ?? event.outcome} ·{" "}
                    {fmtTimestamp(event.created_at, zone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  admitted: "Joined",
  pending: "Joined, waiting for you",
  refused: "Refused",
};
