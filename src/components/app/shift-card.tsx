import { MapPin, Moon, Sun } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { ShiftView } from "@/lib/views";

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  posted: { label: "Posted for trade", tone: "brand" },
  offer_pending: { label: "Offer pending", tone: "caution" },
  pending_approval: { label: "Pending approval", tone: "caution" },
  completed: { label: "Completed", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "critical" },
};

export function ShiftStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, tone: "neutral" as BadgeTone };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function ShiftCard({
  shift,
  href,
  action,
  emphasis = false,
  showResident = false,
  className,
}: {
  shift: ShiftView;
  href?: string;
  action?: React.ReactNode;
  emphasis?: boolean;
  showResident?: boolean;
  className?: string;
}) {
  const isNight = shift.shiftType === "night" || shift.timeRange.includes("+1");
  const Wrapper = href ? "a" : "div";

  return (
    <Card className={cn("overflow-hidden", className)}>
      <Wrapper
        {...(href ? { href } : {})}
        className={cn(
          "block px-4 py-3.5",
          href && "hover:bg-surface-muted focus-visible:bg-surface-muted",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className={cn(
                "font-semibold text-ink",
                emphasis ? "text-xl" : "text-base",
              )}
            >
              {shift.dayLabel}
            </p>
            <p
              className={cn(
                "mt-0.5 flex items-center gap-1.5 text-ink-muted",
                emphasis ? "text-base" : "text-sm",
              )}
            >
              {isNight ? (
                <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <Sun className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>{shift.timeRange}</span>
              <span aria-hidden="true">·</span>
              <span>{shift.duration}</span>
            </p>
          </div>
          <ShiftStatusBadge status={shift.status} />
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-medium text-ink">{shift.serviceName}</span>
          {shift.location ? (
            <span className="flex items-center gap-1 text-ink-subtle">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {shift.location}
            </span>
          ) : null}
          {shift.rotationName ? (
            <span className="text-ink-subtle">{shift.rotationName}</span>
          ) : null}
          {showResident && shift.residentName ? (
            <span className="text-ink-subtle">
              {shift.residentName}
              {shift.residentPgy ? ` · PGY-${shift.residentPgy}` : ""}
            </span>
          ) : null}
          {!shift.tradeable ? (
            <Badge tone="neutral">Not tradeable</Badge>
          ) : null}
          {shift.approvalRequired ? (
            <Badge tone="caution">Approval required</Badge>
          ) : null}
        </div>
      </Wrapper>
      {action ? (
        <div className="border-t border-border-base px-4 py-3">{action}</div>
      ) : null}
    </Card>
  );
}
