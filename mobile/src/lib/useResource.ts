import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/api/client";

/**
 * Loads a value from the API and keeps it fresh.
 *
 * Deliberately small: every screen here loads one thing and reloads it after an
 * action or a pull-to-refresh. What it does carefully is the part that goes
 * wrong on a phone — a refresh must not blank the screen, a slow response that
 * arrives after the user has moved on must not overwrite newer data, and an
 * error must not discard what is already being read.
 *
 * The loading flags are *derived* from which request has settled rather than
 * written by the effect. That keeps the effect free of synchronous state
 * updates (no cascading renders) and makes "stale result arrives late"
 * impossible to get wrong: a result carries the key of the request that
 * produced it, and only the current key is displayed.
 */

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  /** True only for the very first load, when there is nothing to show yet. */
  loading: boolean;
  /** True while re-fetching with data already on screen. */
  refreshing: boolean;
  reload: () => Promise<void>;
  /** Applies a local change immediately, ahead of the server round trip. */
  setData: (next: T) => void;
}

interface Settled<T> {
  key: string;
  data: T | null;
  error: ApiError | null;
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): Resource<T> {
  // `deps` are the query key, exactly as in a data-fetching library. They are
  // primitives in this app (ids and flags), so serialising them is a stable
  // identity that does not change on every render the way an array does.
  const depsKey = JSON.stringify(deps);
  const [reloadCount, setReloadCount] = useState(0);
  const key = `${depsKey}#${reloadCount}`;

  const [settled, setSettled] = useState<Settled<T> | null>(null);

  // The loader closure changes every render; the fetch must not. Updating the
  // ref in its own effect (declared first, so it runs first) keeps the latest
  // closure available without re-triggering the request.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    loadRef.current(controller.signal).then(
      (result) => {
        if (!cancelled) setSettled({ key, data: result, error: null });
      },
      (caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        const error =
          caught instanceof ApiError
            ? caught
            : new ApiError("internal", "Something went wrong. Please try again.");
        // Keep whatever is already on screen; only the error is new.
        setSettled((previous) => ({
          key,
          data: previous?.data ?? null,
          error,
        }));
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key]);

  const reload = useCallback(async () => {
    setReloadCount((count) => count + 1);
  }, []);

  const setData = useCallback(
    (next: T) => {
      setSettled((previous) => ({
        key: previous?.key ?? key,
        data: next,
        error: null,
      }));
    },
    [key],
  );

  const settledForCurrent = settled?.key === key;

  return {
    data: settled?.data ?? null,
    error: settledForCurrent ? (settled?.error ?? null) : null,
    loading: settled === null,
    refreshing: settled !== null && !settledForCurrent,
    reload,
    setData,
  };
}
