import { describeEnvironment, ENVIRONMENT_LABEL } from "@/server/config/environment";

/**
 * A standing marker of which environment the administrator is looking at.
 *
 * It exists for one specific mistake: sending a real invitation to a real
 * resident while you thought you were testing. That mistake is silent and
 * cannot be undone, so the environment is stated on every administrative
 * screen rather than left to be inferred from the URL.
 *
 * Production renders nothing. A badge that is always there is furniture; one
 * that only appears when something is unusual is information.
 */
export function EnvironmentBadge() {
  const { environment, emailDeliveryEnabled } = describeEnvironment();
  if (environment === "production" && emailDeliveryEnabled) return null;
  if (environment === "production") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-caution/50 bg-caution-soft px-3 py-1 text-xs font-semibold text-caution">
        Email not configured — invitations are sent by hand
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-caution/50 bg-caution-soft px-3 py-1 text-xs font-semibold text-caution">
      <span aria-hidden="true">●</span>
      {ENVIRONMENT_LABEL[environment]} — no email is sent from here
    </span>
  );
}
