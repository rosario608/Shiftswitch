import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "./ui";
import { SUPPORT_EMAIL, APP_VERSION } from "@/config";

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

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept to the device console. Nothing is sent anywhere: the app has no
    // analytics or crash-reporting SDK, and a stack trace from a scheduling
    // screen can name a resident.
    console.error("Screen crashed:", error, info.componentStack);
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
