import * as React from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "brand" | "positive" | "caution" | "critical";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-ink-muted border-border-base",
  brand: "bg-brand-soft text-brand-ink border-transparent",
  positive: "bg-positive-soft text-positive border-transparent",
  caution: "bg-caution-soft text-caution border-transparent",
  critical: "bg-critical-soft text-critical border-transparent",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
