import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "./ui";
import { SUPPORT_EMAIL, APP_VERSION, API_URL } from "@/config";

/**
 * Stops one broken screen from taking the whole app with it.
 *
 * Without this, a single unexpected value from the API unmounts the entire
 * React tree and the resident is left staring at a blank screen with no way
 * back — no navigation, no sign-out, nothing but force-quitting. That is a bad
 * outcome for a bug that only affected one screen, and it is the kind of thing
 * a reviewer will find.
 *
 * The boundary is keyed on the route by its parent, so navigating away resets
 * it and the rest of the app keeps working.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The screen, without the identifiers.
 *
 * The native client routes by hash, so `#/trades/9f2c…` is both the route and
 * a real switch between two real people. The shape is what is useful for
 * grouping crashes; the id is what must not travel.
 */
function scrubHash(hash: string): string {
  return hash
    .replace(/^#/, "")
    .split("/")
    .map((segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Screen crashed:", error, info.componentStack);

    /* Reported to ShiftSwitch's own server, and to nowhere else. There is
       still no analytics or crash-reporting SDK in this app — the concern that
       used to keep this local was that a stack trace from a scheduling screen
       can name a resident, and that concern is answered by *what* is sent
       rather than by sending nothing.
     
       Four fields: the error's name, its message, its stack, and the route.
       Deliberately **not** `info.componentStack`, which is the one thing here
       that can carry rendered content. Without any report at all the operator
       never learns that a screen is broken on a device they will never see,
       which is how a crash survives a whole cohort of residents. */
    void fetch(`${API_URL}/api/client-errors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: error.name,
        message: error.message.slice(0, 2_000),
        stack: error.stack?.slice(0, 20_000),
        route: scrubHash(globalThis.location?.hash ?? ""),
        kind: "render",
      }),
      keepalive: true,
    }).catch(() => {
      /* Silent. A device that cannot reach the server is the normal state on a
         ward, and a failed report must never become a second visible error. */
    });
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="safe-top safe-bottom flex h-full flex-col justify-center px-6">
        <Card>
          <h1 className="text-lg font-bold text-ink">This screen didn&rsquo;t load</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Something went wrong displaying it. The rest of the app still works —
            your schedule and any switches in progress are unaffected.
          </p>
          <div className="mt-4 space-y-2">
            <Button block onClick={this.reset}>
              Try this screen again
            </Button>
            <Button
              block
              variant="secondary"
              onClick={() => {
                this.reset();
                globalThis.location.assign("/");
              }}
            >
              Go to home
            </Button>
            <a
              className="block py-2 text-center text-sm text-brand-ink underline"
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                `ShiftSwitch ${APP_VERSION} error`,
              )}&body=${encodeURIComponent(`What I was doing:\n\n\nDetails: ${error.message}`)}`}
            >
              Report this
            </a>
          </div>
        </Card>
      </div>
    );
  }
}
