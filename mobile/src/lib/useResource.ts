import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/api/client";

/**
 * Loads a value from the API and keeps it fresh.
 *
 * Deliberately small: this app has a handful of screens, each of which loads
 * one thing and reloads it after an action or a pull-to-refresh. What it does
 * carefully is the part that goes wrong on a phone — a refresh must not blank
 * the screen, a slow response that arrives after the user has moved on must
 * not overwrite newer data, and an error must not discard what is already
 * shown.
 */

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  /** True only for the initial load, when there is nothing to show yet. */
  loading: boolean;
  /** True while re-fetching with data already on screen. */
  refreshing: boolean;
  reload: () => Promise<void>;
  /** Applies a local change immediately, before the server round trip. */
  setData: (next: T) => void;
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (isRefresh: boolean) => {
    const attempt = ++generation.current;
    const controller = new AbortController();
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const result = await loadRef.current(controller.signal);
      // A newer request has started; its result wins.
      if (attempt !== generation.current || !mounted.current) return;
      setData(result);
      setError(null);
    } catch (caught) {
      if (attempt !== generation.current || !mounted.current) return;
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError("internal", "Something went wrong. Please try again."),
      );
    } finally {
      if (attempt === generation.current && mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void run(false);
    // The caller controls re-fetching through `deps`, exactly like a query key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, ...deps]);

  const reload = useCallback(async () => {
    await run(true);
  }, [run]);

  return { data, error, loading, refreshing, reload, setData };
}
