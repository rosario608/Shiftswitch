import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody } from "@/components/ui/card";
import { requirePageCapability } from "@/server/auth/page-guards";
import { can, type Capability } from "@/server/auth/roles";
import { getProgramAnalytics } from "@/server/domain/admin";
import { listCorrections, todayIn } from "@/server/domain/schedule-corrections";
import { loadWorkspace } from "@/server/domain/schedule-workspace";
import { listScheduleVersions } from "@/server/domain/schedule-versions";
import { MaintenanceButton } from "@/components/app/admin-actions";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration" };

/**
 * The landing screen, and it is not the same screen for everybody.
 *
 * The five roles arrive with genuinely different first questions, and a single
 * page of tiles answers whichever one it was built for and none of the others:
 *
 *   - a **chief** asks *is tonight covered* and *what is waiting for me* — so
 *     coverage leads, with the gaps and the anything-wrong count first;
 *   - an **APD or PD** asks *is the programme all right* — the same numbers,
 *     one level up, plus what has been changed since it was published;
 *   - an **administrator** asks *is the software all right* — configuration,
 *     import, export, audit, housekeeping.
 *
 * The difference is expressed entirely through the capability matrix. There is
 * no `role === "chief"` here and there must never be: every one of those ever
 * written in this repository became a bug the day APD and PD were added.
 */
export default async function AdminHomePage() {
  const context = await requirePageCapability("audit.view");
  const allows = (capability: Capability) => can(context.user.role, capability);

  const analytics = await getProgramAnalytics(context.program.id);

  /* The coverage numbers are only loaded for somebody who could act on them.
     A screen that computes a month of constraints to show a count nobody on
     this page can do anything about is a slow page for no reason. */
  const coverage = allows("scheduling.plan")
    ? await loadWorkspace(context, { versionId: null })
    : null;

  const [drafts, corrections] = await Promise.all([
    allows("scheduling.plan")
      ? listScheduleVersions(context.program.id)
      : Promise.resolve([]),
    allows("schedule.manage")
      ? listCorrections(context.program.id, {
          from: todayIn(context.program.timezone),
          limit: 5,
        })
      : Promise.resolve([]),
  ]);

  const openDrafts = drafts.filter((draft) => draft.status === "draft");
  const awaitingApproval = openDrafts.filter((draft) => !draft.approved_at);
  const approvedAndWaiting = openDrafts.filter((draft) => draft.approved_at);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Administration</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {context.program.name} · {context.program.institution}
        </p>
      </header>

      {/* Anything genuinely wrong, before anything else. A count of completed
          switches is interesting; a ward with nobody on it is not. */}
      {coverage && coverage.report.hardCount > 0 ? (
        <Alert tone="error" title="The published schedule has problems">
          <p>
            {coverage.report.hardCount} thing
            {coverage.report.hardCount === 1 ? "" : "s"} must be fixed, and{" "}
            {coverage.unfilled.length} position
            {coverage.unfilled.length === 1 ? " is" : "s are"} unfilled.
          </p>
          <Link href="/admin/coverage" className="mt-1 inline-block font-semibold underline">
            Open coverage
          </Link>
        </Alert>
      ) : null}

      {approvedAndWaiting.length > 0 && allows("schedule.publish") ? (
        <Alert tone="warning" title="A schedule is approved and not published">
          {approvedAndWaiting.map((draft) => (
            <p key={draft.id}>
              <Link href={`/admin/scheduler/${draft.id}`} className="font-semibold underline">
                {draft.name}
              </Link>{" "}
              was approved by {draft.approved_by_name ?? "somebody"} and residents
              cannot see it yet.
            </p>
          ))}
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        {coverage ? (
          <Tile
            label="Unfilled positions"
            value={coverage.unfilled.length}
            href="/admin/coverage"
          />
        ) : null}
        <Tile
          label="Pending approvals"
          value={analytics.totals.pendingApprovals}
          href="/admin/approvals"
        />
        {openDrafts.length > 0 ? (
          <Tile
            label={awaitingApproval.length > 0 ? "Drafts to sign off" : "Drafts in progress"}
            value={openDrafts.length}
            href="/admin/scheduler"
          />
        ) : null}
        <Tile
          label="Upcoming shifts"
          value={analytics.totals.upcomingShifts}
          href="/admin/schedule"
        />
        <Tile
          label="Completed switches"
          value={analytics.totals.completedTrades}
          href="/admin/analytics"
        />
      </div>

      {corrections.length > 0 ? (
        <section>
          <h2 className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase">
            Changed since it was published
          </h2>
          <Card className="divide-y divide-border-base">
            {corrections.map((correction) => (
              <div key={correction.id} className="px-4 py-2.5 text-sm">
                <span className="font-medium text-ink">{correction.service_name}</span>{" "}
                <span className="text-ink-muted">
                  {/* Never the ISO string: every surface names a day the way
                      the rest of the product does. */}
                  {fmtDate(correction.start_datetime, context.program.timezone)}
                </span>
                <span className="mt-0.5 block text-ink-muted">
                  {correction.previous_resident_name ?? "Nobody"} →{" "}
                  {correction.new_resident_name ?? "nobody"} ·{" "}
                  {correction.corrected_by_name ?? "somebody"}
                </span>
              </div>
            ))}
            <Link
              href="/admin/corrections"
              className="block px-4 py-2.5 text-sm font-semibold text-brand"
            >
              All corrections
            </Link>
          </Card>
        </section>
      ) : null}

      {allows("maintenance.run") ? (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="font-semibold text-ink">Housekeeping</p>
              <p className="mt-1 text-sm text-ink-muted">
                Expire stale posted shifts and offers, and close out shifts that
                have already been worked. Safe to run at any time.
              </p>
            </div>
            <MaintenanceButton />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function Tile({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href}>
      <Card className="h-full">
        <CardBody>
          <p className="text-2xl font-semibold text-ink">{value}</p>
          <p className="mt-1 text-sm text-ink-muted">{label}</p>
        </CardBody>
      </Card>
    </Link>
  );
}
