import {
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent,
} from "react";
import { useNavigate } from "react-router";
import { Spinner } from "./ui";
import { tapFeedback } from "@/native/shell";

/**
 * The frame every screen sits in: a header that respects the notch, a scrolling
 * body with pull-to-refresh, and space at the bottom for the tab bar.
 *
 * Pull-to-refresh is implemented here rather than with a plugin because it must
 * only engage when the pane is already at the top — otherwise a resident
 * scrolling back up through a month of shifts triggers a reload every time.
 */

const PULL_THRESHOLD = 72;
const MAX_PULL = 110;

export function Screen({
  title,
  subtitle,
  back,
  action,
  onRefresh,
  refreshing = false,
  children,
  padded = true,
}: {
  title: string;
  subtitle?: string;
  /** Shows a back control. `true` goes back in history; a string navigates. */
  back?: boolean | string;
  action?: ReactNode;
  onRefresh?: () => Promise<void> | void;
  refreshing?: boolean;
  children: ReactNode;
  padded?: boolean;
}) {
  const navigate = useNavigate();
  const pane = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [pulling, setPulling] = useState(false);

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (!onRefresh || refreshing) return;
      if ((pane.current?.scrollTop ?? 0) > 0) return;
      startY.current = event.touches[0].clientY;
    },
    [onRefresh, refreshing],
  );

  const onTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (startY.current === null) return;
      const delta = event.touches[0].clientY - startY.current;
      if (delta <= 0) {
        setPull(0);
        setPulling(false);
        return;
      }
      setPulling(true);
      // Resistance: the further you pull, the less it moves.
      setPull(Math.min(MAX_PULL, delta * 0.5));
    },
    [],
  );

  const onTouchEnd = useCallback(() => {
    const shouldRefresh = pull >= PULL_THRESHOLD;
    startY.current = null;
    setPull(0);
    setPulling(false);
    if (shouldRefresh && onRefresh) {
      void tapFeedback();
      void onRefresh();
    }
  }, [pull, onRefresh]);

  const showSpinner = refreshing || pull >= PULL_THRESHOLD;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="safe-top safe-x z-10 border-b border-border-base bg-surface px-4 pb-3">
        <div className="flex items-center gap-2">
          {back && (
            <button
              type="button"
              onClick={() =>
                typeof back === "string" ? navigate(back) : navigate(-1)
              }
              className="tap -ml-2 flex items-center rounded-lg pr-1 text-brand-ink"
              aria-label="Go back"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M15 5l-7 7 7 7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold text-ink">{title}</h1>
            {subtitle && (
              <p className="truncate text-sm text-ink-muted">{subtitle}</p>
            )}
          </div>
          {action}
        </div>
      </header>

      <div
        ref={pane}
        className="scroll-pane safe-x flex-1"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div
          className="flex items-end justify-center overflow-hidden text-ink-muted"
          style={{
            height: refreshing ? 44 : pull,
            transition: pulling ? "none" : "height 0.2s ease-out",
          }}
        >
          {showSpinner && (
            <div className="pb-2">
              <Spinner label="Refreshing" />
            </div>
          )}
        </div>
        <div className={padded ? "px-4 pt-1 pb-28" : "pb-28"}>{children}</div>
      </div>
    </div>
  );
}
