import { useEffect, useState } from "react";
import { Button, InlineNotice } from "@/components/ui";
import {
  hasBeenPrimed,
  markPrimed,
  permissionState,
  primePush,
  type PushPermission,
} from "@/native/push";

/**
 * Permission priming.
 *
 * The system notification prompt can only be shown once. So the app explains
 * first, in its own words, exactly what it will send — and only calls the
 * platform when the resident taps "Turn on". Someone who taps "Not now" is not
 * asked again from here; they can still turn notifications on from Settings,
 * where the real permission state is shown rather than assumed.
 */
export function PushPrimer() {
  const [state, setState] = useState<PushPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(hasBeenPrimed());

  useEffect(() => {
    void permissionState().then(setState);
  }, []);

  if (dismissed || state === null || state !== "prompt") return null;

  return (
    <InlineNotice tone="brand" title="Get told when something needs you">
      <p className="mt-1">
        We&rsquo;ll notify you when someone offers to take your shift, when your
        switch is approved, and when a chief needs to review one. Nothing else.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            const result = await primePush();
            setBusy(false);
            setState(result);
            setDismissed(true);
          }}
        >
          Turn on
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            markPrimed();
            setDismissed(true);
          }}
        >
          Not now
        </Button>
      </div>
    </InlineNotice>
  );
}
