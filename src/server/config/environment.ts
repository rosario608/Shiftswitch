/**
 * Which environment this is, and what that means for anything that leaves the
 * building.
 *
 * The distinction the product cares about is not "is NODE_ENV production" — it
 * is **can a message reach a real person**. Those are different questions, and
 * conflating them is how a test invitation ends up in a resident's inbox. A
 * production build with no mail credential cannot deliver; a staging build with
 * one can. So delivery is gated on both, and everything else keys off the same
 * single source of truth.
 */

export type DeploymentEnvironment = "development" | "staging" | "production";

export interface EnvironmentInfo {
  environment: DeploymentEnvironment;
  /** True only where a real message could actually reach a real inbox. */
  emailDeliveryEnabled: boolean;
  /** Why delivery is off, when it is. Shown to administrators verbatim. */
  emailDeliveryReason: string;
  /**
   * Whether the development-only invitation sandbox is available: the panel
   * that shows invitation links and lets one person walk the whole acceptance
   * flow without a second Google account.
   */
  invitationSandboxEnabled: boolean;
}

type EnvLike = Record<string, string | undefined>;

function isProduction(env: EnvLike): boolean {
  return env.NODE_ENV === "production";
}

export function describeEnvironment(env: EnvLike = process.env): EnvironmentInfo {
  const production = isProduction(env);
  const hasMailCredential = Boolean(env.RESEND_API_KEY);

  /* The sandbox is two independent locks, both of which have to be open:
     it is never available in a production build, and even outside production it
     has to be asked for. A single flag would be one typo away from shipping. */
  const invitationSandboxEnabled = !production && env.ALLOW_TEST_LOGIN === "true";

  const environment: DeploymentEnvironment = production
    ? "production"
    : env.NODE_ENV === "test" || env.APP_URL?.includes("localhost")
      ? "development"
      : "staging";

  let emailDeliveryEnabled = false;
  let emailDeliveryReason: string;
  if (!production) {
    /* The hard rule this exists for: outside production, nothing is sent, no
       matter what credentials happen to be lying around in the environment. A
       staging deployment that inherited a real API key must not be able to mail
       a resident. */
    emailDeliveryReason =
      "This is not the production environment, so ShiftSwitch will not send email to anybody. Invitations are created normally and you send the link yourself.";
  } else if (!hasMailCredential) {
    emailDeliveryReason =
      "No email service is configured, so the invitation was not sent automatically. Copy the link and send it yourself.";
  } else {
    emailDeliveryEnabled = true;
    emailDeliveryReason = "";
  }

  return {
    environment,
    emailDeliveryEnabled,
    emailDeliveryReason,
    invitationSandboxEnabled,
  };
}

export const ENVIRONMENT_LABEL: Record<DeploymentEnvironment, string> = {
  development: "Development",
  staging: "Staging",
  production: "Production",
};
