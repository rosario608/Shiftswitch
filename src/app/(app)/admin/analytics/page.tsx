import { Alert } from "@/components/ui/alert";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requirePageCapability } from "@/server/auth/page-guards";
import { getProgramAnalytics } from "@/server/domain/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  const context = await requirePageCapability("analytics.view");
  const analytics = await getProgramAnalytics(context.program.id);

  const tiles = [
    { label: "Total shifts", value: analytics.totals.shifts },
    { label: "Shifts posted", value: analytics.totals.tradeRequests },
    { label: "Completed switches", value: analytics.totals.completedTrades },
    { label: "Completion rate", value: `${analytics.completionRate}%` },
    { label: "Pending approvals", value: analytics.totals.pendingApprovals },
    {
      label: "Avg. approval time",
      value:
        analytics.averageApprovalHours == null
          ? "—"
          : `${analytics.averageApprovalHours.toFixed(1)} h`,
    },
    { label: "Emails generated", value: analytics.totals.emailsGenerated },
    { label: "Emails marked sent", value: analytics.totals.emailsMarkedSent },
  ];

  const maxWeek = Math.max(1, ...analytics.tradesOverTime.map((row) => row.count));

  /* Eight equal tiles answer nothing — they are a data dump, and whoever
     arrives has to decide for themselves which number was the point. The
     question an APD or a PD actually arrives with is "is switching working for
     us", so that gets said in a sentence, in words, and the tiles become the
     detail underneath it. */
  const posted = analytics.totals.tradeRequests;
  const completed = analytics.totals.completedTrades;
  const headline =
    posted === 0
      ? "Nobody has posted a shift yet"
      : `${completed} of ${posted} posted shift${posted === 1 ? "" : "s"} found a switch`;
  const slowApprovals =
    analytics.averageApprovalHours != null && analytics.averageApprovalHours > 24;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">{headline}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {context.program.name}
          {posted > 0 ? ` · ${analytics.completionRate}% completion rate` : ""}
          {analytics.averageApprovalHours != null
            ? ` · chiefs take ${analytics.averageApprovalHours.toFixed(1)} h to decide on average`
            : ""}
        </p>
      </header>

      {slowApprovals ? (
        <Alert tone="warning" title="Approvals are taking more than a day">
          A posted shift expires while it waits. The longer a switch sits with a
          chief, the more likely it is that the offer is withdrawn or the shift
          starts.
        </Alert>
      ) : null}

      <h2 className="px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase">
        The numbers
      </h2>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((tile) => (
          <Card key={tile.label}>
            <CardBody>
              <p className="text-2xl font-semibold text-ink">{tile.value}</p>
              <p className="mt-1 text-sm text-ink-muted">{tile.label}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardBody>
          <h2 className="mb-3 font-semibold text-ink">Switches over time</h2>
          {analytics.tradesOverTime.length === 0 ? (
            <p className="text-sm text-ink-muted">No completed switches yet.</p>
          ) : (
            <ul className="space-y-2">
              {analytics.tradesOverTime.map((row) => (
                <li key={row.week} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 text-ink-muted">
                    Week of {row.week}
                  </span>
                  <span className="flex-1">
                    <span
                      className="block h-2.5 rounded-full bg-brand"
                      style={{ width: `${Math.max(6, (row.count / maxWeek) * 100)}%` }}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="w-6 text-right font-semibold text-ink">
                    {row.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="mb-3 font-semibold text-ink">Switches by service</h2>
          {analytics.tradesByService.length === 0 ? (
            <p className="text-sm text-ink-muted">No data yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {analytics.tradesByService.map((row) => (
                <li key={row.service} className="flex justify-between">
                  <span className="text-ink-muted">{row.service}</span>
                  <span className="font-semibold text-ink">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="mb-3 font-semibold text-ink">Switches by PGY</h2>
          {analytics.tradesByPgy.length === 0 ? (
            <p className="text-sm text-ink-muted">No data yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {analytics.tradesByPgy.map((row) => (
                <li key={row.pgy} className="flex justify-between">
                  <span className="text-ink-muted">PGY-{row.pgy}</span>
                  <span className="font-semibold text-ink">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="mb-3 font-semibold text-ink">
            Most common reasons switches are blocked
          </h2>
          {analytics.failedValidationReasons.length === 0 ? (
            <EmptyState
              title="No switches have been blocked"
              description="Reasons appear here when an offer is invalidated or a switch is rejected."
            />
          ) : (
            <ul className="space-y-1.5 text-sm">
              {analytics.failedValidationReasons.map((row) => (
                <li key={row.reason} className="flex justify-between gap-3">
                  <span className="text-ink-muted">{row.reason}</span>
                  <span className="shrink-0 font-semibold text-ink">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
