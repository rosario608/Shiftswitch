import { useAuth } from "@/auth/AuthProvider";
import { Button, Card } from "@/components/ui";
import { SUPPORT_EMAIL } from "@/config";

/**
 * A signed-in account that an administrator has not yet attached to a program.
 *
 * The account genuinely cannot do anything until that happens — every API call
 * would be refused server-side — so the app says so plainly instead of showing
 * empty screens.
 */
export function PendingScreen() {
  const { session, signOut, refresh } = useAuth();

  return (
    <div className="safe-top safe-bottom safe-x flex h-full flex-col justify-center bg-canvas px-6">
      <Card className="mx-auto w-full max-w-sm">
        <h1 className="text-xl font-bold text-ink">Almost there</h1>
        <p className="mt-2 text-sm text-ink-muted">
          You&rsquo;re signed in as{" "}
          <span className="selectable font-medium text-ink">
            {session?.user?.email}
          </span>
          , but your program administrator hasn&rsquo;t added you to a program
          yet.
        </p>
        <p className="mt-3 text-sm text-ink-muted">
          Once they do, your schedule appears here automatically — we&rsquo;ll
          send you a notification.
        </p>
        <div className="mt-6 space-y-2">
          <Button block variant="secondary" onClick={() => void refresh()}>
            Check again
          </Button>
          <Button
            block
            variant="ghost"
            onClick={() => {
              globalThis.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                "ShiftSwitch access",
              )}`;
            }}
          >
            Contact support
          </Button>
          <Button block variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </Card>
    </div>
  );
}
