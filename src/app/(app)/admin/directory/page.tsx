import { Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requirePageCapability } from "@/server/auth/page-guards";
import { ROLE_SHORT_LABEL } from "@/server/auth/roles";
import { formatPhone, listDirectory } from "@/server/domain/roster";
import { formatShiftDate, formatShiftTime } from "@/server/domain/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Directory" };

/**
 * How to reach people, ordered by who is on.
 *
 * The page is guarded by `residents.contact_info` rather than
 * `scheduling.plan`, because it exists to show phone numbers and a screen whose
 * entire purpose is redacted for the person reading it is a worse answer than
 * not offering it to them.
 *
 * Numbers are `tel:` links. On a phone that is one tap to a call, which is the
 * whole point at two in the morning; on a desktop the browser either hands it
 * to a soft phone or does nothing, and the number is still legible on screen
 * either way.
 */
export default async function DirectoryPage() {
  const context = await requirePageCapability("residents.contact_info");
  const now = new Date();
  const people = await listDirectory(context, now);
  const zone = context.program.timezone;

  const onNow = people.filter((person) => person.on_now);
  const everyoneElse = people.filter((person) => !person.on_now);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Directory</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Everybody in {context.program.name}, with whoever is on shift right now
          first. Tap a number to call.
        </p>
      </header>

      {people.length === 0 ? (
        <EmptyState
          title="Nobody yet"
          description="Invite people from Users & roles and they will appear here."
        />
      ) : (
        <div className="space-y-6">
          {onNow.length > 0 ? (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">
                On now
              </h2>
              <PersonList people={onNow} zone={zone} />
            </section>
          ) : null}

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">
              {onNow.length > 0 ? "Everybody else" : "Everybody"}
            </h2>
            <PersonList people={everyoneElse} zone={zone} />
          </section>
        </div>
      )}
    </div>
  );
}

function PersonList({
  people,
  zone,
}: {
  people: Awaited<ReturnType<typeof listDirectory>>;
  zone: string;
}) {
  return (
    <Card className="divide-y divide-border">
      {people.map((person) => (
        <div
          key={person.user_id}
          className="flex flex-wrap items-center justify-between gap-3 p-4"
        >
          <div className="min-w-0">
            <p className="font-medium text-ink">{person.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral">{ROLE_SHORT_LABEL[person.role]}</Badge>
              {person.pgy_level ? (
                <Badge tone="neutral">PGY-{person.pgy_level}</Badge>
              ) : null}
              {person.on_now ? (
                <Badge tone="positive">On {person.on_now}</Badge>
              ) : person.next_start ? (
                <span className="text-sm text-ink-subtle">
                  Next: {person.next_service},{" "}
                  {formatShiftDate(person.next_start, zone)}{" "}
                  {formatShiftTime(person.next_start, zone)}
                </span>
              ) : (
                <span className="text-sm text-ink-subtle">Nothing scheduled</span>
              )}
            </div>
          </div>

          {person.phone ? (
            <a
              href={`tel:${person.phone}`}
              className="flex min-h-[2.75rem] shrink-0 items-center gap-2 rounded-xl border border-border-strong px-4 font-semibold text-ink"
            >
              <Phone className="h-4 w-4" aria-hidden="true" />
              <span>{formatPhone(person.phone)}</span>
              <span className="sr-only">Call {person.name}</span>
            </a>
          ) : (
            /* Said rather than left blank. "No number recorded" tells a chief to
               go and find one; an empty cell reads as a bug in the page. */
            <span className="shrink-0 text-sm text-ink-subtle">No number recorded</span>
          )}
        </div>
      ))}
    </Card>
  );
}
