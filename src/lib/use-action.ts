"use client";

import * as React from "react";
import { ApiError } from "./api-client";

export interface ActionState<T> {
  run: (...args: unknown[]) => Promise<T | undefined>;
  pending: boolean;
  error: string | null;
  errorDetails: unknown;
  /**
   * True when the product cannot say whether the action happened.
   *
   * Only ever set by a connection that dropped mid-flight. It is deliberately
   * separate from `error`, because the interface's response has to be
   * different: an error offers "try again", an uncertainty has to offer "find
   * out" first. Presenting the two identically is how a resident ends up
   * accepting the same switch twice, or abandoning one that had already gone
   * through.
   */
  uncertain: boolean;
  /** The six characters that find this in the server's logs, when there are any. */
  requestId: string | null;
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
  const [uncertain, setUncertain] = React.useState(false);
  const [requestId, setRequestId] = React.useState<string | null>(null);
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
      setUncertain(false);
      setRequestId(null);
      try {
        const result = await (action as (...a: unknown[]) => Promise<T>)(...args);
        options.onSuccess?.(result);
        return result;
      } catch (caught) {
        /* An `Error` a component raised deliberately carries the sentence
           somebody is meant to read — "nothing could be built that satisfies
           every rule", "the period ends before it starts". Collapsing those
           into "something went wrong" throws away the only part of the failure
           that helps, and it is indistinguishable on screen from the app
           actually breaking. The generic message stays for what it was for:
           a network failure, a driver error, a thrown non-Error. */
        const message =
          caught instanceof ApiError || caught instanceof Error
            ? caught.message
            : "Something went wrong. Please try again.";
        if (mounted.current) {
          setError(message);
          setErrorDetails(caught instanceof ApiError ? caught.details : null);
          setUncertain(caught instanceof ApiError && caught.uncertain);
          setRequestId(
            caught instanceof ApiError ? (caught.requestId ?? null) : null,
          );
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
    setUncertain(false);
    setRequestId(null);
  }, []);

  return { run, pending, error, errorDetails, uncertain, requestId, reset };
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
