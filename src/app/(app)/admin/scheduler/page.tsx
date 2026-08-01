import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Info,
  Layers,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GenerateDraftButton } from "@/components/app/generate-draft-button";
import { NewDraftButton } from "@/components/app/new-draft-button";
import { ScheduleCheck } from "@/components/app/schedule-check";
import { requirePageCapability } from "@/server/auth/page-guards";
import { loadSchedulerSnapshot } from "@/server/domain/scheduler-dashboard";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scheduler" };

const SEVERITY_TONE = {
  high: "critical",
  medium: "caution",
  low: "neutral",
} as const;

/**
 * The scheduler's home.
 *
 * Written for a chief resident with fifteen minutes, not for somebody
 * administering a database. Problems first, because the reason to open this
 * screen is usually that something is wrong; then the work in progress; then
 * the four things a schedule is made of, each a door rather than a table.
 */
export default async function SchedulerPage() {
  const context = await requirePageCapability("scheduling.plan");
  const snapshot = await loadSchedulerSnapshot(context);
  const { roster, cohorts, services, blocks, schedule, problems } = snapshot;

  const nothingConfigured =
    roster.total === 0 && services.total === 0 && blocks.structures === 0;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Scheduler</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Your program&rsquo;s people, services, blocks and schedules in one
          place.
        </p>
      </header>

      {nothingConfigured ? (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" aria-hidden="true" />}
          title="Nothing is set up yet"
          description="Start with your services — everything else refers to them. You can load a starting template and edit it, rather than typing the list from scratch."
          action={
            <Link
              href="/admin/services"
              className="inline-flex min-h-[2.75rem] items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white"
            >
              Set up services
            </Link>
          }
        />
      ) : null}

      {problems.length > 0 ? (
        <section aria-labelledby="problems-heading">
          <h2
            id="problems-heading"
            className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase"
          >
            Needs a decision
          </h2>
          <ul className="space-y-2">
            {problems.map((problem, index) => (
              <li key={`${problem.title}-${index}`}>
                <Card>
                  <Link
                    href={problem.href}
                    className="flex items-start gap-3 px-4 py-3.5 hover:bg-surface-muted"
                  >
                    <AlertTriangle
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        problem.severity === "high" ? "text-critical" : "text-caution"
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink">{problem.title}</p>
                      <p className="mt-0.5 text-sm text-ink-muted">{problem.detail}</p>
                    </div>
                    <Badge tone={SEVERITY_TONE[problem.severity]}>
                      {problem.severity === "high" ? "Fix" : "Review"}
                    </Badge>
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : nothingConfigured ? null : (
        <Card className="flex items-start gap-3 px-4 py-3.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-positive" aria-hidden="true" />
          <p className="text-sm text-ink-muted">
            Nothing needs a decision. Every mandatory service has a coverage
            requirement, every upcoming shift has somebody on it, and every
            resident is in a cohort.
          </p>
        </Card>
      )}

      {/* On demand rather than on load: it reads the whole window and runs
          every constraint, and a chief opening the dashboard to see one number
          should not pay for a full validation they did not ask for. */}
      {nothingConfigured ? null : (
        <section aria-labelledby="check-heading">
          <h2 id="check-heading" className="sr-only">
            Check the live schedule
          </h2>
          <ScheduleCheck />
        </section>
      )}

      <section aria-labelledby="drafts-heading">
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h2
            id="drafts-heading"
            className="text-sm font-semibold tracking-wide text-ink-muted uppercase"
          >
            Draft schedules
          </h2>
          <div className="flex gap-2">
            <GenerateDraftButton timezone={context.program.timezone} />
            <NewDraftButton timezone={context.program.timezone} />
          </div>
        </div>
        {schedule.drafts.length === 0 ? (
          <EmptyState
            title="No drafts in progress"
            description="A draft is a schedule residents cannot see yet. Build one, check what it changes, then publish it."
          />
        ) : (
          <ul className="space-y-2">
            {schedule.drafts.map((draft) => (
              <li key={draft.id}>
                <Card>
                  <Link
                    href={`/admin/scheduler/${draft.id}`}
                    className="flex items-start justify-between gap-3 px-4 py-3.5 hover:bg-surface-muted"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{draft.name}</p>
                      <p className="mt-0.5 text-sm text-ink-muted">
                        {fmtDate(draft.periodStart, context.program.timezone)} –{" "}
                        {fmtDate(draft.periodEnd, context.program.timezone)} ·{" "}
                        {draft.shiftCount} shift{draft.shiftCount === 1 ? "" : "s"}
                      </p>
                      {draft.createdByName ? (
                        <p className="mt-1 text-xs text-ink-subtle">
                          Started by {draft.createdByName}
                        </p>
                      ) : null}
                    </div>
                    <Badge tone="caution">Draft</Badge>
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="pieces-heading">
        <h2
          id="pieces-heading"
          className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase"
        >
          What a schedule is made of
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          <SummaryCard
            href="/admin/roster"
            icon={<Users className="h-4 w-4" aria-hidden="true" />}
            title="Residents"
            headline={`${roster.schedulable} schedulable of ${roster.total}`}
            lines={[
              roster.byPgy.map((row) => `PGY-${row.pgy}: ${row.count}`).join(" · ") ||
                "Nobody on the roster yet",
              roster.unschedulable > 0
                ? `${roster.unschedulable} not currently schedulable`
                : null,
            ]}
          />
          <SummaryCard
            href="/admin/cohorts"
            icon={<Users className="h-4 w-4" aria-hidden="true" />}
            title="Cohorts"
            headline={
              cohorts.total === 0
                ? "None yet"
                : `${cohorts.total} cohort${cohorts.total === 1 ? "" : "s"}`
            }
            lines={[
              cohorts.total === 0
                ? "Groups within a PGY class that move through the year together"
                : `${cohorts.paired} paired · ${cohorts.unpaired} unpaired`,
              roster.withoutCohort > 0
                ? `${roster.withoutCohort} resident(s) not in one`
                : null,
            ]}
          />
          <SummaryCard
            href="/admin/services"
            icon={<Layers className="h-4 w-4" aria-hidden="true" />}
            title="Services"
            headline={
              services.total === 0
                ? "None yet"
                : `${services.active} active of ${services.total}`
            }
            lines={[
              services.total === 0
                ? "Load a starting template and edit it"
                : `${services.withCoverage} with coverage defined · ${services.tradeable} tradeable`,
              services.mandatoryWithoutCoverage.length > 0
                ? `${services.mandatoryWithoutCoverage.length} mandatory service(s) with no coverage`
                : null,
            ]}
          />
          <SummaryCard
            href="/admin/cohorts"
            icon={<CalendarDays className="h-4 w-4" aria-hidden="true" />}
            title="Blocks"
            headline={
              blocks.currentStructure
                ? `${blocks.currentStructure.name}`
                : "No block structure"
            }
            lines={[
              blocks.currentStructure
                ? `${blocks.currentStructure.blockCount} blocks · ` +
                  `${blocks.currentStructure.assignedBlocks} assigned`
                : "The shape of your academic year — any block length, paired or not",
              blocks.currentStructure && blocks.currentStructure.unassignedBlocks > 0
                ? `${blocks.currentStructure.unassignedBlocks} with no cohort`
                : null,
            ]}
          />
        </ul>
      </section>

      <section aria-labelledby="live-heading">
        <h2
          id="live-heading"
          className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase"
        >
          The live schedule
        </h2>
        <Card className="px-4 py-3.5">
          <p className="text-sm text-ink">
            <span className="font-semibold">{schedule.upcomingShifts}</span> upcoming
            shift{schedule.upcomingShifts === 1 ? "" : "s"} published, out of{" "}
            {schedule.publishedShifts} in total.
          </p>
          {schedule.unassignedUpcoming > 0 ? (
            <p className="mt-1 text-sm text-critical">
              {schedule.unassignedUpcoming} of them have nobody assigned.
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">
              Every upcoming shift has somebody on it.
            </p>
          )}
          <Link
            href="/admin/schedule"
            className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-brand"
          >
            Open the schedule
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Card>
      </section>
    </div>
  );
}

function SummaryCard({
  href,
  icon,
  title,
  headline,
  lines,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  headline: string;
  lines: Array<string | null>;
}) {
  return (
    <li>
      <Card className="h-full">
        <Link
          href={href}
          className="flex h-full flex-col px-4 py-3.5 hover:bg-surface-muted"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-ink-muted">
            {icon}
            {title}
          </span>
          <span className="mt-1.5 font-semibold text-ink">{headline}</span>
          {lines.filter(Boolean).map((line, index) => (
            <span key={index} className="mt-0.5 text-sm text-ink-muted">
              {line}
            </span>
          ))}
        </Link>
      </Card>
    </li>
  );
}
