import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/**
 * Every variant meets a 44px minimum tap target on mobile except `xs`, which is
 * only used for inline text actions inside a larger touch surface.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:pointer-events-none disabled:opacity-55 select-none",
  {
    variants: {
      variant: {
        primary: "bg-brand text-white hover:bg-brand-strong active:bg-brand-strong",
        secondary:
          "bg-surface text-ink border border-border-strong hover:bg-surface-muted",
        soft: "bg-brand-soft text-brand-ink hover:brightness-95",
        ghost: "text-ink-muted hover:bg-surface-muted",
        danger: "bg-critical text-white hover:brightness-110",
        link: "text-brand-ink underline underline-offset-4 hover:opacity-80",
      },
      size: {
        xs: "h-8 px-2.5 text-sm",
        sm: "h-10 px-3.5 text-sm",
        md: "min-h-[2.75rem] px-4 py-2.5 text-base",
        lg: "min-h-[3.25rem] px-5 py-3 text-base",
        icon: "h-11 w-11",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", block: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  loadingLabel?: string;
}

export function Button({
  className,
  variant,
  size,
  block,
  loading = false,
  loadingLabel,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner />
          <span>{loadingLabel ?? "Working…"}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("h-4 w-4 animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

export { buttonVariants };
