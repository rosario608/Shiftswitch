import type { ReactNode } from "react";
import type { ShiftDetail, ValidationCheck } from "@/api/types";
import { formatShiftWindow, isOvernight, statusLabel } from "@/lib/format";
import { Card, Pill, cx, toneForStatus } from "./ui";

/**
 * One shift, shown the same way everywhere it appears: what it is, when it
 * runs, where, and who currently holds it.
 */
export function ShiftCard({
  shift,
  timezone,
  footer,
  onClick,
  showResident = false,
  highlight = false,
}: {
  shift: ShiftDetail;
  timezone: string;
  footer?: ReactNode;
  onClick?: () => void;
  showResident?: boolean;
  highlight?: boolean;
}) {
  const overnight = isOvernight(shift.start_datetime, shift.end_datetime, timezone);

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{shift.service_name}</p>
          <p className="text-sm text-ink-muted">
            {formatShiftWindow(shift.start_datetime, shift.end_datetime, timezone)}
          </p>
        </div>
        {shift.status !== "scheduled" && (
          <Pill tone={toneForStatus(shift.status)}>
            {statusLabel(shift.status)}
          </Pill>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
        <span>{shift.location}</span>
        <span aria-hidden="true">·</span>
        <span className="capitalize">{shift.shift_type.replace(/_/g, " ")}</span>
        {overnight && (
          <>
            <span aria-hidden="true">·</span>
            <span>Overnight</span>
          </>
        )}
        {shift.rotation_name && (
          <>
            <span aria-hidden="true">·</span>
            <span>{shift.rotation_name}</span>
          </>
        )}
      </div>
      {showResident && shift.resident_name && (
        <p className="mt-2 text-sm text-ink-muted">
          {shift.resident_name}
          {shift.resident_pgy ? ` · PGY-${shift.resident_pgy}` : ""}
        </p>
      )}
      {footer && <div className="mt-3">{footer}</div>}
    </>
  );

  const className = cx(
    "w-full text-left",
    highlight && "border-brand/40 bg-brand-soft",
  );

  if (!onClick) return <Card className={className}>{body}</Card>;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "tap w-full rounded-card border border-border-base bg-surface p-4 text-left active:bg-surface-muted",
        highlight && "border-brand/40 bg-brand-soft",
      )}
    >
      {body}
    </button>
  );
}

/**
 * The rules engine's verdict, in the resident's words.
 *
 * Failures come first because they are the reason a switch cannot proceed;
 * every entry states which rule it came from so a resident can take it to their
 * chief rather than guessing.
 */
export function ValidationChecks({
  checks,
  emptyMessage = "No rule concerns.",
}: {
  checks: ValidationCheck[];
  emptyMessage?: string;
}) {
  const ordered = [...checks].sort((a, b) => {
    const rank = { fail: 0, warn: 1, pass: 2 } as const;
    return rank[a.status] - rank[b.status];
  });
  const notable = ordered.filter((check) => check.status !== "pass");

  if (notable.length === 0) {
    return <p className="text-sm text-ink-muted">{emptyMessage}</p>;
  }

  return (
    <ul className="space-y-2">
      {notable.map((check) => (
        <li
          key={check.key}
          className={cx(
            "rounded-lg border px-3 py-2 text-sm",
            check.status === "fail"
              ? "border-critical/40 bg-critical-soft"
              : "border-caution/40 bg-caution-soft",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium text-ink">{check.label}</p>
            <Pill tone={check.status === "fail" ? "critical" : "caution"}>
              {check.status === "fail" ? "Blocks" : "Needs approval"}
            </Pill>
          </div>
          <p className="mt-1 text-ink-muted">{check.message}</p>
          {check.detail?.required && (
            <p className="mt-1 text-xs text-ink-subtle">
              Required: {check.detail.required}
              {check.detail.available ? ` · Actual: ${check.detail.available}` : ""}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
