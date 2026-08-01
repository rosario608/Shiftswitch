import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { DraftActions } from "@/components/app/draft-actions";
import { DraftShiftEditor } from "@/components/app/draft-shift-editor";
import { ScheduleCheck } from "@/components/app/schedule-check";
import { requirePageCapability } from "@/server/auth/page-guards";
import {
  diffScheduleVersion,
  getScheduleVersion,
  listDraftShifts,
} from "@/server/domain/schedule-versions";
import { listRoster } from "@/server/domain/roster";
import { fmtDate, fmtTimestamp } from "@/lib/format";

/** Enough to work through a month at a sitting without shipping a whole year. */
const SHIFT_LIMIT = 300;

export const dynamic = "force-dynamic";
export const metadata = { title: "Draft schedule" };

/**
 * One draft, and what publishing it would change.
 *
 * The diff is the whole point of the screen. Publishing rewrites a month of
 * people's lives; a scheduler who can see that three shifts move and one
 * resident changes service will publish confidently, and one who cannot will
 * either not publish or publish and find out afterwards.
 */
export default async function DraftPage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const context = await requirePageCapability("scheduling.plan");
  const { versionId } = await params;
  const version = await getScheduleVersion(context.program.id, versionId);
  if (!version) notFound();

  const timezone = context.program.timezone;
  const diff = await diffScheduleVersion(context.program.id, versionId, timezone);
  const [draftShifts, roster] =
    version.status === "draft"
      ? await Promise.all([
          listDraftShifts(context.program.id, versionId, { limit: SHIFT_LIMIT }),
          listRoster(context),
        ])
      : [[], []];
  const nothingChanges =
    diff.added.length === 0 && diff.removed.length === 0 && diff.reassigned.length === 0;

  return (
    <div className="space-y-5">
      <Link
        href="/admin/scheduler"
        className="inline-flex items-center gap-1 text-sm font-semibold text-brand"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Scheduler
      </Link>

      <header>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold text-ink">{version.name}</h1>
          <Badge tone={version.status === "draft" ? "caution" : "positive"}>
            {version.status === "draft" ? "Draft" : "Published"}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          {fmtDate(version.period_start, timezone)} –{" "}
          {fmtDate(version.period_end, timezone)} · {version.shift_count} shift
          {version.shift_count === 1 ? "" : "s"}
        </p>
        {version.published_at ? (
          <p className="mt-1 text-sm text-ink-subtle">
            Published by {version.published_by_name ?? "somebody"} on{" "}
            {fmtTimestamp(version.published_at, timezone)}
          </p>
        ) : version.created_by_name ? (
          <p className="mt-1 text-sm text-ink-subtle">
            Started by {version.created_by_name}
          </p>
        ) : null}
        {version.notes ? (
          <p className="mt-2 max-w-prose text-sm text-ink-muted italic">
            &ldquo;{version.notes}&rdquo;
          </p>
        ) : null}
      </header>

      {version.status === "draft" ? (
        <>
          <section aria-labelledby="diff-heading">
            <h2
              id="diff-heading"
              className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase"
            >
              What publishing would change
            </h2>

            {nothingChanges ? (
              <EmptyState
                title="Nothing would change"
                description={
                  version.shift_count === 0
                    ? "This draft has no shifts. Publishing it would clear the live schedule for this period — which is a real thing to want, but rarely by accident."
                    : "Every shift in this draft matches the published schedule already."
                }
              />
            ) : (
              <div className="space-y-4">
                <DiffGroup
                  title="Added"
                  tone="positive"
                  count={diff.added.length}
                  description="New shifts that do not exist in the live schedule."
                >
                  {diff.added.map((shift) => (
                    <ShiftLine key={shift.id} shift={shift} timezone={timezone} />
                  ))}
                </DiffGroup>

                <DiffGroup
                  title="Removed"
                  tone="critical"
                  count={diff.removed.length}
                  description="Live shifts in this period that the draft does not contain. Publishing deletes them."
                >
                  {diff.removed.map((shift) => (
                    <ShiftLine key={shift.id} shift={shift} timezone={timezone} />
                  ))}
                </DiffGroup>

                <DiffGroup
                  title="Reassigned"
                  tone="caution"
                  count={diff.reassigned.length}
                  description="Same shift, different resident."
                >
                  {diff.reassigned.map((entry) => (
                    <li key={entry.shift.id} className="px-4 py-2.5 text-sm">
                      <span className="font-medium text-ink">
                        {entry.shift.service_name}
                      </span>{" "}
                      <span className="text-ink-muted">
                        {fmtDate(entry.shift.start_datetime, timezone)}
                      </span>
                      <span className="mt-0.5 block text-ink-muted">
                        {entry.from ?? "nobody"} → {entry.to ?? "nobody"}
                      </span>
                    </li>
                  ))}
                </DiffGroup>

                {diff.unchanged > 0 ? (
                  <p className="px-1 text-sm text-ink-subtle">
                    {diff.unchanged} shift{diff.unchanged === 1 ? "" : "s"} unchanged.
                  </p>
                ) : null}
              </div>
            )}
          </section>

          {diff.blockers.length > 0 ? (
            <section aria-labelledby="blockers-heading">
              <h2
                id="blockers-heading"
                className="mb-2 px-1 text-sm font-semibold tracking-wide text-critical uppercase"
              >
                Live switches in the way
              </h2>
              <Card className="px-4 py-3.5">
                <p className="text-sm text-ink-muted">
                  Publishing would delete shifts that residents have already
                  posted or offered. Those switches would be cancelled without
                  either resident being asked.
                </p>
                <ul className="mt-2 space-y-1">
                  {diff.blockers.map((blocker) => (
                    <li key={blocker.shift.id} className="text-sm text-ink">
                      {blocker.reason}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ) : null}

          <section aria-labelledby="shifts-heading">
            <h2
              id="shifts-heading"
              className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase"
            >
              The shifts in this draft
            </h2>
            <p className="mb-2 max-w-prose px-1 text-sm text-ink-muted">
              Changing anything here is safe: nobody can see this schedule, and
              nothing in it can be traded until it is published.
            </p>
            <DraftShiftEditor
              versionId={version.id}
              timezone={timezone}
              truncated={version.shift_count > draftShifts.length}
              shifts={draftShifts.map((shift) => ({
                id: shift.id,
                serviceName: shift.service_name,
                start: shift.start_datetime.toISOString(),
                end: shift.end_datetime.toISOString(),
                residentId: shift.resident_id,
                residentName: shift.resident_name,
              }))}
              residents={roster
                .filter((resident) => resident.active && resident.schedulable)
                .map((resident) => ({
                  id: resident.id,
                  name: resident.name,
                  pgyLevel: resident.pgy_level,
                }))}
            />
          </section>

          {/* Above the publish button on purpose. The diff says what would
              change; this says whether what it would change to is legal, and
              that is the last question before the irreversible step. */}
          <ScheduleCheck
            versionId={version.id}
            periodStart={version.period_start.toISOString().slice(0, 10)}
            periodEnd={version.period_end.toISOString().slice(0, 10)}
          />

          <DraftActions
            versionId={version.id}
            hasBlockers={diff.blockers.length > 0}
          />
        </>
      ) : (
        <Card className="px-4 py-3.5">
          <p className="text-sm text-ink-muted">
            This schedule is published and residents are working it. To change
            it, start a new draft for the same period.
          </p>
        </Card>
      )}
    </div>
  );
}

function DiffGroup({
  title,
  tone,
  count,
  description,
  children,
}: {
  title: string;
  tone: "positive" | "critical" | "caution";
  count: number;
  description: string;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <Badge tone={tone}>{title}</Badge>
        <span className="text-sm text-ink-muted">
          {count} · {description}
        </span>
      </div>
      <Card>
        <ul className="divide-y divide-border-base">{children}</ul>
      </Card>
    </div>
  );
}

function ShiftLine({
  shift,
  timezone,
}: {
  shift: {
    id: string;
    service_name: string;
    start_datetime: Date;
    resident_name: string | null;
  };
  timezone: string;
}) {
  return (
    <li className="px-4 py-2.5 text-sm">
      <span className="font-medium text-ink">{shift.service_name}</span>{" "}
      <span className="text-ink-muted">
        {fmtDate(shift.start_datetime, timezone)}
      </span>
      <span className="mt-0.5 block text-ink-muted">
        {shift.resident_name ?? "Nobody assigned"}
      </span>
    </li>
  );
}
