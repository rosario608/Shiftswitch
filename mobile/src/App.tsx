import { hasAdminArea } from "@/api/roles";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { App as CapacitorApp } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { Capacitor } from "@capacitor/core";
import { api } from "@/api/client";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { isAuthCallback } from "@/auth/session";
import { routeFromUrl } from "@/native/deeplinks";
import { initPush, setPushRouteHandler } from "@/native/push";
import {
  applyStatusBarStyle,
  configureShell,
  hideSplash,
} from "@/native/shell";
import { TabBar } from "@/components/TabBar";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Spinner } from "@/components/ui";
import { LoginScreen } from "@/screens/Login";
import { PendingScreen } from "@/screens/Pending";
import { HomeScreen } from "@/screens/Home";
import { ScheduleScreen } from "@/screens/Schedule";
import { ShiftDetailScreen } from "@/screens/ShiftDetail";
import { TradesScreen } from "@/screens/Trades";
import { TradeDetailScreen } from "@/screens/TradeDetail";
import { SwitchDetailScreen } from "@/screens/SwitchDetail";
import { ApprovalsScreen } from "@/screens/Approvals";
import { NotificationsScreen } from "@/screens/Notifications";
import { ProfileScreen } from "@/screens/Profile";
import { DeleteAccountScreen } from "@/screens/DeleteAccount";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  );
}

/**
 * The shell owns everything that is true of the whole app rather than of one
 * screen: which top-level state we are in, the tab bar, the offline banner,
 * and the native integrations that need a router to act on — deep links,
 * notification taps and the Android back button.
 */
function Shell() {
  const { status, session, handleAuthCallback, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [online, setOnline] = useState(true);
  const [unread, setUnread] = useState(0);
  /** A route a deep link asked for before the session was ready. */
  const deferredRoute = useRef<string | null>(null);

  const go = useCallback(
    (route: string) => {
      if (status === "signed_in") navigate(route);
      else deferredRoute.current = route;
    },
    [navigate, status],
  );

  // Native start-up: shell chrome, push listeners, and the URL the app was
  // launched with (a cold start from a notification or a link).
  useEffect(() => {
    void (async () => {
      await configureShell();
      setPushRouteHandler(go);
      await initPush();
      const launch = await CapacitorApp.getLaunchUrl().catch(() => null);
      if (launch?.url) {
        if (isAuthCallback(launch.url)) await handleAuthCallback(launch.url);
        else {
          const route = routeFromUrl(launch.url);
          if (route) go(route);
        }
      }
      await hideSplash();
    })();
  }, [go, handleAuthCallback]);

  // Links and OAuth callbacks arriving while the app is already running.
  useEffect(() => {
    const handle = CapacitorApp.addListener("appUrlOpen", (event) => {
      if (isAuthCallback(event.url)) {
        void handleAuthCallback(event.url);
        return;
      }
      const route = routeFromUrl(event.url);
      if (route) go(route);
    });
    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, [go, handleAuthCallback]);

  // The Android hardware/gesture back button. At a top-level screen it should
  // close the app, exactly like every other Android app; anywhere else it goes
  // back one step.
  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    const handle = CapacitorApp.addListener("backButton", ({ canGoBack }) => {
      const atRoot = [
        "/",
        "/schedule",
        "/trades",
        "/approvals",
        "/notifications",
        "/profile",
      ].includes(globalThis.location.pathname);
      if (atRoot || !canGoBack) void CapacitorApp.exitApp();
      else navigate(-1);
    });
    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, [navigate]);

  // Refresh when the app returns to the foreground: a resident who acted on a
  // notification expects the screen to be current, not to show what it showed
  // an hour ago.
  useEffect(() => {
    const handle = CapacitorApp.addListener(
      "appStateChange",
      ({ isActive }) => {
        if (isActive) {
          void refresh();
          void applyStatusBarStyle();
        }
      },
    );
    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, [refresh]);

  // Connectivity.
  useEffect(() => {
    void Network.getStatus()
      .then((state) => setOnline(state.connected))
      .catch(() => setOnline(true));
    const handle = Network.addListener("networkStatusChange", (state) =>
      setOnline(state.connected),
    );
    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, []);

  // Follow a deferred deep link once the session is usable.
  useEffect(() => {
    if (status === "signed_in" && deferredRoute.current) {
      const route = deferredRoute.current;
      deferredRoute.current = null;
      navigate(route);
    }
  }, [status, navigate]);

  // The unread badge, refreshed whenever the user changes screens.
  useEffect(() => {
    if (status !== "signed_in") return;
    let cancelled = false;
    void api
      .get<{ unread: number }>("/api/notifications?limit=1")
      .then((result) => {
        if (!cancelled) setUnread(result.unread);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status, location.pathname]);

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <Spinner size={28} label="Loading" />
      </div>
    );
  }

  if (status === "signed_out") return <LoginScreen />;
  if (status === "not_configured") {
    // An account with no program can do nothing except wait — except leave.
    // Account deletion has to be reachable for every account that exists, so
    // this state gets its own two-route router rather than a dead end.
    return (
      <ErrorBoundary key={location.pathname}>
        <Routes>
          <Route
            path="/settings/delete-account"
            element={<DeleteAccountScreen />}
          />
          <Route path="*" element={<PendingScreen />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  const elevated = hasAdminArea(session?.user?.role);

  return (
    <div className="flex h-full flex-col">
      {!online && (
        <div
          role="status"
          className="safe-top bg-caution px-4 py-2 text-center text-sm font-semibold text-white"
        >
          You&rsquo;re offline — showing the last information we loaded.
        </div>
      )}

      {/*
        Keyed on the path so navigating away from a screen that failed clears
        the error and the next screen renders normally.
      */}
      <div className="min-h-0 flex-1">
        <ErrorBoundary key={location.pathname}>
          <Routes>
            <Route path="/" element={<HomeScreen />} />
            <Route path="/schedule" element={<ScheduleScreen />} />
            <Route path="/schedule/:shiftId" element={<ShiftDetailScreen />} />
            <Route path="/trades" element={<TradesScreen />} />
            <Route path="/trades/:tradeId" element={<TradeDetailScreen />} />
            <Route path="/switches/:tradeId" element={<SwitchDetailScreen />} />
            {elevated && (
              <Route path="/approvals" element={<ApprovalsScreen />} />
            )}
            <Route
              path="/notifications"
              element={<NotificationsScreen onRead={() => setUnread(0)} />}
            />
            <Route path="/profile" element={<ProfileScreen />} />
            <Route path="/settings" element={<ProfileScreen />} />
            <Route
              path="/settings/delete-account"
              element={<DeleteAccountScreen />}
            />
            <Route path="*" element={<HomeScreen />} />
          </Routes>
        </ErrorBoundary>
      </div>

      <TabBar unread={unread} showApprovals={Boolean(elevated)} />
    </div>
  );
}
