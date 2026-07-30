"use client";

import * as React from "react";
import { ApiError } from "./api-client";

export interface ActionState<T> {
  run: (...args: unknown[]) => Promise<T | undefined>;
  pending: boolean;
  error: string | null;
  errorDetails: unknown;
  reset: () => void;
}

/**
 * Runs an async action with:
 *  - a single-flight guard, so double-tapping a button cannot submit twice,
 *  - a pending flag for loading states,
 *  - an already-friendly error message for display.
 */
export function useAction<T>(
  action: (...args: never[]) => Promise<T>,
  options: { onSuccess?: (result: T) => void } = {},
): ActionState<T> {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorDetails, setErrorDetails] = React.useState<unknown>(null);
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = React.useCallback(
    async (...args: unknown[]) => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setPending(true);
      setError(null);
      setErrorDetails(null);
      try {
        const result = await (action as (...a: unknown[]) => Promise<T>)(...args);
        options.onSuccess?.(result);
        return result;
      } catch (caught) {
        const message =
          caught instanceof ApiError
            ? caught.message
            : "Something went wrong. Please try again.";
        if (mounted.current) {
          setError(message);
          setErrorDetails(caught instanceof ApiError ? caught.details : null);
        }
        return undefined;
      } finally {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action, options.onSuccess],
  );

  const reset = React.useCallback(() => {
    setError(null);
    setErrorDetails(null);
  }, []);

  return { run, pending, error, errorDetails, reset };
}

/** Tracks browser connectivity so mutations can be blocked while offline. */
export function useOnline(): boolean {
  const [online, setOnline] = React.useState(true);
  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
