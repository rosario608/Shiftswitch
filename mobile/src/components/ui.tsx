import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

/**
 * The app's visual primitives.
 *
 * Rules that apply to all of them: every interactive element is at least 44pt
 * tall, status is never carried by colour alone, and a disabled control always
 * says why it is disabled somewhere the user can read.
 */

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
  block?: boolean;
}

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white active:bg-brand-strong disabled:bg-border-strong disabled:text-ink-subtle",
  secondary:
    "bg-surface text-ink border border-border-strong active:bg-surface-muted disabled:text-ink-subtle",
  ghost: "text-brand-ink active:bg-brand-soft disabled:text-ink-subtle",
  danger:
    "bg-critical text-white active:opacity-90 disabled:bg-border-strong disabled:text-ink-subtle",
};

export function Button({
  variant = "primary",
  busy = false,
  block = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "tap inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-semibold transition-colors",
        BUTTON_STYLES[variant],
        block && "w-full",
        className,
      )}
    >
      {busy && <Spinner size={18} />}
      {children}
    </button>
  );
}

export function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      className="inline-block animate-spin-slow rounded-full border-2 border-current border-t-transparent align-[-2px]"
      style={{ width: size, height: size }}
    />
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li" | "section";
}) {
  return (
    <Tag
      className={cx(
        "rounded-card border border-border-base bg-surface p-4",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function SectionHeading({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">
        {children}
      </h2>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type PillTone = "neutral" | "brand" | "positive" | "caution" | "critical";

const PILL_STYLES: Record<PillTone, string> = {
  neutral: "bg-surface-muted text-ink-muted",
  brand: "bg-brand-soft text-brand-ink",
  positive: "bg-positive-soft text-positive",
  caution: "bg-caution-soft text-caution",
  critical: "bg-critical-soft text-critical",
};

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: PillTone;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold",
        PILL_STYLES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function toneForStatus(status: string): PillTone {
  switch (status) {
    case "completed":
    case "approved":
    case "accepted":
      return "positive";
    case "pending_approval":
    case "offer_pending":
    case "pending":
      return "caution";
    case "cancelled":
    case "expired":
    case "rejected":
    case "invalidated":
      return "critical";
    case "open":
    case "posted":
      return "brand";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-border-strong px-5 py-10 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {detail && <p className="mt-1 text-sm text-ink-muted">{detail}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  retryable = true,
}: {
  message: string;
  onRetry?: () => void;
  retryable?: boolean;
}) {
  return (
    <div
      role="alert"
      className="rounded-card border border-critical/40 bg-critical-soft px-5 py-6 text-center"
    >
      <p className="font-semibold text-critical">Something went wrong</p>
      <p className="selectable mt-1 text-sm text-ink">{message}</p>
      {onRetry && retryable && (
        <Button variant="secondary" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function InlineNotice({
  tone = "brand",
  title,
  children,
}: {
  tone?: PillTone;
  title?: string;
  children: ReactNode;
}) {
  const styles: Record<PillTone, string> = {
    neutral: "border-border-base bg-surface-muted",
    brand: "border-brand/30 bg-brand-soft",
    positive: "border-positive/30 bg-positive-soft",
    caution: "border-caution/40 bg-caution-soft",
    critical: "border-critical/40 bg-critical-soft",
  };
  return (
    <div className={cx("rounded-card border px-4 py-3 text-sm", styles[tone])}>
      {title && <p className="font-semibold text-ink">{title}</p>}
      <div className="text-ink-muted">{children}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx("animate-fade-in rounded-card bg-surface-muted", className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="animate-sheet-in safe-bottom relative max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-surface"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-base bg-surface px-4 py-3">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="tap -mr-2 rounded-lg px-3 text-brand-ink"
          >
            Done
          </button>
        </div>
        <div className="px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export function ConfirmSheet({
  open,
  title,
  body,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet open={open} onClose={busy ? () => {} : onCancel} title={title}>
      <div className="space-y-4 text-sm text-ink-muted">{body}</div>
      <div className="mt-6 space-y-2">
        <Button
          block
          busy={busy}
          variant={destructive ? "danger" : "primary"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button block variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export function useToast() {
  const [message, setMessage] = useState<{
    text: string;
    tone: PillTone;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const show = (text: string, tone: PillTone = "positive") => {
    setMessage({ text, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 4000);
  };

  const node = message ? (
    <div
      role="status"
      aria-live="polite"
      className="animate-fade-in pointer-events-none fixed inset-x-4 bottom-24 z-40"
    >
      <div
        className={cx(
          "rounded-card px-4 py-3 text-center text-sm font-medium shadow-lg",
          message.tone === "critical"
            ? "bg-critical text-white"
            : "bg-ink text-canvas",
        )}
      >
        {message.text}
      </div>
    </div>
  ) : null;

  return { show, node };
}
