import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftRight, CheckCircle2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody } from "@/components/ui/card";
import { NotifyProgramPanel } from "@/components/app/notify-program";
import { requirePageUser } from "@/server/auth/page-guards";
import { getCompletedTrade } from "@/server/domain/trades";
import { buildMailtoUrl, listEmailRecords } from "@/server/domain/email";
import { isUuid } from "@/lib/cn";
import { toShiftView } from "@/lib/views";
import { fmtTimestamp } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Switch completed" };

export default async function SwitchPage({
  params,
}: {
  params: Promise<{ tradeId: string }>;
}) {
  const context = await requirePageUser();
  const { tradeId } = await params;
  if (!isUuid(tradeId)) notFound();
  const trade = await getCompletedTrade(tradeId, context.program.id);
  if (!trade) notFound();

  const isParticipant =
    context.resident?.id === trade.resident_a || context.resident?.id === trade.resident_b;
  const elevated = context.user.role === "chief" || context.user.role === "admin";
  if (!isParticipant && !elevated) notFound();

  const timezone = context.program.timezone;
  const source = toShiftView(trade.source_shift, timezone);
  const destination = toShiftView(trade.destination_shift, timezone);

  const records = await listEmailRecords(trade.id, context.program.id);
  const mine = records.find((record) => record.generated_by === context.user.id) ?? null;
  const initialEmail = mine
    ? {
        emailRecordId: mine.id,
        to: mine.recipients,
        cc: mine.cc_recipients,
        subject: mine.subject,
        body: mine.body,
        status: mine.status,
        mailtoUrl: buildMailtoUrl({
          to: mine.recipients,
          cc: mine.cc_recipients,
          subject: mine.subject,
          body: mine.body,
        }),
      }
    : null;

  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius-card)] bg-positive-soft px-4 py-5 text-center">
        <CheckCircle2
          className="mx-auto mb-2 h-9 w-9 text-positive"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold text-ink">Switch completed</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Both schedules were updated on {fmtTimestamp(trade.completed_at, timezone)}.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-3">
          <div className="rounded-xl border border-border-base p-3">
            <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              {source.dateLabel} — {source.serviceName}
            </p>
            <p className="mt-1 text-ink">
              <span className="line-through opacity-60">{trade.resident_a_name}</span>{" "}
              → <span className="font-semibold">{trade.resident_b_name}</span>
            </p>
            <p className="text-sm text-ink-muted">
              {source.timeRange}
              {source.location ? ` · ${source.location}` : ""}
            </p>
          </div>
          <div className="flex justify-center text-ink-subtle">
            <ArrowLeftRight className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="rounded-xl border border-border-base p-3">
            <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              {destination.dateLabel} — {destination.serviceName}
            </p>
            <p className="mt-1 text-ink">
              <span className="line-through opacity-60">{trade.resident_b_name}</span>{" "}
              → <span className="font-semibold">{trade.resident_a_name}</span>
            </p>
            <p className="text-sm text-ink-muted">
              {destination.timeRange}
              {destination.location ? ` · ${destination.location}` : ""}
            </p>
          </div>
        </CardBody>
      </Card>

      {trade.approval_required ? (
        <Alert tone="info" title="Approved">
          This switch was reviewed and approved by a chief resident
          {trade.approved_at ? ` on ${fmtTimestamp(trade.approved_at, timezone)}` : ""}.
          {trade.override_applied
            ? " An administrator override was recorded in the audit log."
            : ""}
        </Alert>
      ) : null}

      <NotifyProgramPanel completedTradeId={trade.id} initialEmail={initialEmail} />

      <div className="flex gap-2">
        <Link
          href="/schedule"
          className="flex min-h-[2.75rem] flex-1 items-center justify-center rounded-xl border border-border-strong px-4 font-semibold text-ink"
        >
          View my schedule
        </Link>
        <Link
          href="/trades?tab=history"
          className="flex min-h-[2.75rem] flex-1 items-center justify-center rounded-xl border border-border-strong px-4 font-semibold text-ink"
        >
          Switch history
        </Link>
      </div>
    </div>
  );
}
