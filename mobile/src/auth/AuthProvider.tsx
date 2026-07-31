import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, configureApi } from "@/api/client";
import type { SessionResponse } from "@/api/types";
import {
  beginGoogleSignIn,
  clearStoredSession,
  completeSignIn,
  fetchSession,
  loadStoredSession,
  testSignIn,
} from "./session";
import { registerDevice, unregisterDevice } from "@/native/push";

/**
 * Holds the session for the whole app.
 *
 * The token lives in a ref as well as state: `configureApi` needs to read the
 * current value synchronously from inside `fetch`, and a stale closure there
 * would silently sign the user out mid-session.
 */

export type AuthStatus =
  | "loading"
  | "signed_out"
  | "not_configured"
  | "signed_in";

export interface AuthValue {
  status: AuthStatus;
  session: SessionResponse | null;
  /** Non-null whenever the last auth action failed, for display on the screen. */
  error: string | null;
  signingIn: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string) => Promise<void>;
  handleAuthCallback: (url: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = use(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const tokenRef = useRef<string | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const forgetSession = useCallback(async () => {
    tokenRef.current = null;
    setSession(null);
    setStatus("signed_out");
    await clearStoredSession();
  }, []);

  // Wire the API client once, before any screen can issue a request.
  useEffect(() => {
    configureApi({
      getToken: () => tokenRef.current,
      onUnauthorized: () => {
        void forgetSession();
      },
    });
  }, [forgetSession]);

  const applySession = useCallback(async () => {
    const probe = await fetchSession();
    setSession(probe);
    if (!probe.authenticated) {
      await forgetSession();
      return;
    }
    setStatus(probe.configured ? "signed_in" : "not_configured");
    // Register for push once we know who this is. A pending account registers
    // too, so it can be told when an administrator finishes setting it up.
    void registerDevice();
  }, [forgetSession]);

  // Restore a stored session on launch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadStoredSession();
      if (cancelled) return;
      if (!stored) {
        setStatus("signed_out");
        return;
      }
      tokenRef.current = stored.token;
      try {
        await applySession();
      } catch {
        if (!cancelled) {
          // A network failure at launch must not discard a valid session —
          // that would sign the user out every time they open the app in a
          // basement reading room.
          setStatus("signed_in");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      await beginGoogleSignIn();
    } catch {
      setSigningIn(false);
      setError("Could not open the sign-in page. Please try again.");
    }
    // `signingIn` stays true until the callback arrives or the user returns to
    // the app without completing it (handled by the shell's resume listener).
  }, []);

  const handleAuthCallback = useCallback(
    async (url: string) => {
      try {
        const stored = await completeSignIn(url);
        tokenRef.current = stored.token;
        await applySession();
        setError(null);
      } catch (caught) {
        await forgetSession();
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Sign-in did not complete. Please try again.",
        );
      } finally {
        setSigningIn(false);
      }
    },
    [applySession, forgetSession],
  );

  const signInWithEmail = useCallback(
    async (email: string) => {
      setError(null);
      setSigningIn(true);
      try {
        const stored = await testSignIn(email);
        tokenRef.current = stored.token;
        await applySession();
      } catch (caught) {
        await forgetSession();
        setError(caught instanceof ApiError ? caught.message : "Sign-in failed.");
      } finally {
        setSigningIn(false);
      }
    },
    [applySession, forgetSession],
  );

  const signOut = useCallback(async () => {
    // Drop the push registration first: a signed-out device must stop
    // receiving another person's notifications even if the network call below
    // fails.
    await unregisterDevice().catch(() => undefined);
    await api.post("/api/auth/signout", undefined).catch(() => undefined);
    await forgetSession();
  }, [forgetSession]);

  const refresh = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      await applySession();
    } catch {
      // Leave the current view in place; individual screens surface their own
      // load failures.
    }
  }, [applySession]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      session,
      error,
      signingIn,
      signInWithGoogle,
      signInWithEmail,
      handleAuthCallback,
      signOut,
      refresh,
      clearError: () => setError(null),
    }),
    [
      status,
      session,
      error,
      signingIn,
      signInWithGoogle,
      signInWithEmail,
      handleAuthCallback,
      signOut,
      refresh,
    ],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
