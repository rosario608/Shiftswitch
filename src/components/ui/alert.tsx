import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "info" | "success" | "warning" | "error";

const TONES: Record<Tone, { className: string; Icon: React.ElementType; label: string }> = {
  info: { className: "bg-brand-soft text-brand-ink", Icon: Info, label: "Information" },
  success: {
    className: "bg-positive-soft text-positive",
    Icon: CheckCircle2,
    label: "Success",
  },
  warning: {
    className: "bg-caution-soft text-caution",
    Icon: AlertTriangle,
    label: "Warning",
  },
  error: { className: "bg-critical-soft text-critical", Icon: XCircle, label: "Error" },
};

export function Alert({
  tone = "info",
  title,
  children,
  className,
  live,
}: {
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
  className?: string;
  /** Announce the message to screen readers when it appears. */
  live?: boolean;
}) {
  const { className: toneClass, Icon, label } = TONES[tone];
  return (
    <div
      className={cn("flex gap-3 rounded-xl px-3.5 py-3 text-sm", toneClass, className)}
      role={tone === "error" ? "alert" : live ? "status" : undefined}
      aria-live={live && tone !== "error" ? "polite" : undefined}
    >
      <Icon className="mt-0.5 h-4.5 w-4.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="sr-only">{label}: </span>
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5")}>{children}</div> : null}
      </div>
    </div>
  );
}
