import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import { requirePageRole } from "@/server/auth/page-guards";
import { getProgramAnalytics } from "@/server/domain/admin";
import { MaintenanceButton } from "@/components/app/admin-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration" };

export default async function AdminHomePage() {
  const context = await requirePageRole("chief");
  const analytics = await getProgramAnalytics(context.program.id);

  const tiles = [
    { label: "Pending approvals", value: analytics.totals.pendingApprovals, href: "/admin/approvals" },
    { label: "Completed switches", value: analytics.totals.completedTrades, href: "/admin/analytics" },
    { label: "Upcoming shifts", value: analytics.totals.upcomingShifts, href: "/admin/schedule" },
    { label: "Trade posts", value: analytics.totals.tradeRequests, href: "/admin/analytics" },
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Administration</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {context.program.name} · {context.program.institution}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href}>
            <Card className="h-full">
              <CardBody>
                <p className="text-2xl font-semibold text-ink">{tile.value}</p>
                <p className="mt-1 text-sm text-ink-muted">{tile.label}</p>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardBody className="space-y-3">
          <div>
            <p className="font-semibold text-ink">Housekeeping</p>
            <p className="mt-1 text-sm text-ink-muted">
              Expire stale trade posts and offers, and close out shifts that have
              already been worked. Safe to run at any time.
            </p>
          </div>
          <MaintenanceButton />
        </CardBody>
      </Card>
    </div>
  );
}
