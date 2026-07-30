import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Clock, MapPin, Users } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody } from "@/components/ui/card";
import { ShiftStatusBadge } from "@/components/app/shift-card";
import { PostShiftButton } from "@/components/app/post-shift-sheet";
import { requirePageUser } from "@/server/auth/page-guards";
import { queryOne } from "@/server/db/pool";
import { getShiftDetail } from "@/server/domain/schedule";
import { listOfferableForPosting } from "@/server/domain/schedule-actions";
import { toShiftView } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function ShiftDetailPage({
  params,
}: {
  params: Promise<{ shiftId: string }>;
}) {
  const context = await requirePageUser();
  const { shiftId } = await params;
  const shift = await getShiftDetail(shiftId);

  if (!shift || shift.program_id !== context.program.id) notFound();

  const isOwner = context.resident?.id === shift.resident_id;
  const elevated = context.user.role === "chief" || context.user.role === "admin";
  if (!isOwner && !elevated) notFound();

  const view = toShiftView(shift, context.program.timezone);
  const postable = context.resident
    ? await listOfferableForPosting(context.resident.id)
    : [];

  const activePost = await queryOne<{ id: string }>(
    `SELECT id FROM trade_requests
      WHERE source_shift_id = $1
        AND status IN ('open', 'offer_pending', 'accepted', 'pending_approval', 'approved')`,
    [shiftId],
  );

  const blockReason = !shift.tradeable
    ? "Your program has marked this shift non-tradeable."
    : shift.status === "cancelled"
      ? "This shift has been cancelled."
      : shift.status === "completed"
        ? "This shift has already been worked."
        : shift.start_datetime.getTime() <= Date.now()
          ? "This shift has already started."
          : null;

  return (
    <div className="space-y-5">
      <Link
        href="/schedule"
        className="inline-flex min-h-[2.5rem] items-center gap-1.5 text-sm font-semibold text-brand-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Schedule
      </Link>

      <header>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold text-ink">{view.serviceName}</h1>
          <ShiftStatusBadge status={view.status} />
        </div>
        <p className="mt-1 text-ink-muted">{view.dateLong}</p>
      </header>

      <Card>
        <CardBody className="space-y-3 text-sm">
          <Row icon={<Clock className="h-4 w-4" />} label="Time">
            {view.timeRange} · {view.duration}
          </Row>
          <Row icon={<CalendarDays className="h-4 w-4" />} label="Shift type">
            <span className="capitalize">{view.shiftType}</span>
            {view.rotationName ? ` · ${view.rotationName}` : ""}
          </Row>
          {view.location ? (
            <Row icon={<MapPin className="h-4 w-4" />} label="Location">
              {view.location}
            </Row>
          ) : null}
          <Row icon={<Users className="h-4 w-4" />} label="Assigned to">
            {view.residentName ?? "Unassigned"}
            {view.residentPgy ? ` · PGY-${view.residentPgy}` : ""}
          </Row>
          <Row icon={<Users className="h-4 w-4" />} label="Eligible levels">
            PGY-{view.requiredPgyMin}
            {view.requiredPgyMax !== view.requiredPgyMin
              ? ` to PGY-${view.requiredPgyMax}`
              : ""}
          </Row>
        </CardBody>
      </Card>

      {view.approvalRequired ? (
        <Alert tone="warning" title="Chief approval required">
          A switch involving this shift only takes effect once a chief resident
          approves it.
        </Alert>
      ) : null}

      {isOwner ? (
        activePost ? (
          <Card>
            <CardBody>
              <p className="mb-3 text-sm text-ink-muted">
                This shift is already posted for trade.
              </p>
              <Link
                href={`/trades/${activePost.id}`}
                className="flex min-h-[2.75rem] items-center justify-center rounded-xl bg-brand px-4 font-semibold text-white"
              >
                View trade post
              </Link>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody>
              <PostShiftButton
                shifts={postable.map((item) => toShiftView(item, context.program.timezone))}
                preselectedShiftId={shift.id}
                label="Post for trade"
                disabledReason={blockReason}
              />
            </CardBody>
          </Card>
        )
      ) : null}
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-ink-subtle" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold tracking-wide text-ink-subtle uppercase">
          {label}
        </span>
        <span className="block text-ink">{children}</span>
      </span>
    </div>
  );
}
