"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/use-action";

/**
 * How a failed action is shown, including the case where nobody knows whether
 * it failed.
 *
 * Every mutation in the product renders its failure the same way — a message in
 * a red box — and for an ordinary refusal ("that shift is no longer available")
 * that is right. The case it gets wrong is the connection dropping mid-flight,
 * because then the red box is asserting something the product does not know.
 *
 * So this component has two modes:
 *
 * **Failed.** The server answered and said no. Red, the message, the request id
 * if there is one. Trying again is safe and obvious.
 *
 * **Uncertain.** The request left and nothing came back. Amber rather than red,
 * because "this went wrong" is not established. The action offered is
 * **reload**, not retry — find out what actually happened first. Offering
 * "try again" here is how a resident accepts the same switch twice.
 */
export function ActionAlert({
  action,
  className,
}: {
  action: Pick<ActionState<unknown>, "error" | "uncertain" | "requestId">;
  className?: string;
}) {
  if (!action.error) return null;

  const reference = action.requestId ? (
    <span className="mt-1 block text-xs opacity-80">
      Reference <span className="font-mono font-semibold">{action.requestId}</span>
    </span>
  ) : null;

  if (action.uncertain) {
    return (
      <div className={className}>
        <Alert tone="warning" title="We don't know if that went through">
          {action.error}
          {reference}
        </Alert>
        <Button
          className="mt-2"
          variant="secondary"
          onClick={() => window.location.reload()}
        >
          <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
          Reload and check
        </Button>
      </div>
    );
  }

  return (
    <Alert tone="error" className={className}>
      {action.error}
      {reference}
    </Alert>
  );
}
