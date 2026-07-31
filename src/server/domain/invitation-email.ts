import type { AuthedContext } from "@/server/auth/guards";
import type { CreatedInvitation } from "./invitations";
import { APP_NAME } from "./email";
import { logger } from "@/server/observability/logger";
import { describeEnvironment } from "@/server/config/environment";

/**
 * Delivering an invitation.
 *
 * The application has never had server-side email: the program-notification
 * flow deliberately hands a `mailto:` link to the resident's own mail client so
 * the message comes from a real person at a real address. Invitations follow
 * the same principle, which has a useful consequence — **invitations work today
 * with no email credential at all**. The administrator gets a link to copy, and
 * a pre-filled `mailto:` they can send from their own mailbox.
 *
 * A real transport can be added later without changing anything above this
 * file. `sendInvitationEmail` always succeeds from the caller's point of view
 * and records what actually happened; it never reports a delivery that did not
 * occur.
 *
 * To enable automatic delivery, one credential is needed:
 *
 *     RESEND_API_KEY        (and optionally INVITATION_FROM_ADDRESS)
 *
 * With it unset — the default — `NoopInvitationTransport` is used and the UI
 * tells the administrator to send the link themselves.
 *
 * **And it only applies in production.** Outside a production build nothing is
 * ever sent, credential or not: see `getInvitationTransport`.
 */

export interface InvitationMessage {
  to: string;
  subject: string;
  text: string;
  url: string;
}

export type DeliveryOutcome =
  | { delivered: true; via: string }
  | { delivered: false; reason: string };

export interface InvitationTransport {
  readonly name: string;
  send(message: InvitationMessage): Promise<DeliveryOutcome>;
}

/**
 * The default. It does not attempt delivery and says so plainly, so nothing in
 * the product can mistake "no transport configured" for "email sent".
 */
export class NoopInvitationTransport implements InvitationTransport {
  readonly name = "noop";

  constructor(
    private readonly reason = "No email service is configured, so the invitation was not sent automatically. Copy the link and send it yourself.",
  ) {}

  async send(): Promise<DeliveryOutcome> {
    return { delivered: false, reason: this.reason };
  }
}

/**
 * Sends through Resend's HTTP API. Chosen because it needs one API key and no
 * SMTP configuration, which matters when the person deploying this is a program
 * coordinator rather than an administrator of a mail server.
 */
export class ResendInvitationTransport implements InvitationTransport {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: InvitationMessage): Promise<DeliveryOutcome> {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return {
          delivered: false,
          reason: `The email service refused the message (${response.status}). ${detail.slice(0, 200)}`,
        };
      }
      return { delivered: true, via: this.name };
    } catch (error) {
      return {
        delivered: false,
        reason: `The email service could not be reached: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      };
    }
  }
}

let transport: InvitationTransport | null = null;

/**
 * Picks the transport for this environment.
 *
 * The decision is not "is there an API key" — it is `describeEnvironment()`,
 * which says whether a message could reach a real person *here*. Outside
 * production the answer is always no, even if a real credential is sitting in
 * the environment, because a staging deployment that inherited production's
 * secrets must not be able to email a resident who has no idea the system
 * exists yet. That is the single mistake this whole seam is guarding against,
 * and it is not recoverable once made.
 */
export function getInvitationTransport(): InvitationTransport {
  if (transport) return transport;
  const environment = describeEnvironment();
  if (!environment.emailDeliveryEnabled) {
    transport = new NoopInvitationTransport(environment.emailDeliveryReason);
    return transport;
  }
  const from =
    process.env.INVITATION_FROM_ADDRESS ?? "ShiftSwitch <onboarding@resend.dev>";
  transport = new ResendInvitationTransport(process.env.RESEND_API_KEY!, from);
  return transport;
}

/** Test seam, matching `setPushTransport`. */
export function setInvitationTransport(next: InvitationTransport | null): void {
  transport = next;
}

export function buildInvitationMessage(
  context: Pick<AuthedContext, "program" | "user">,
  created: CreatedInvitation,
): InvitationMessage {
  const { program, user } = context;
  const roleLabel =
    created.invitation.role === "chief"
      ? "chief resident"
      : created.invitation.role === "admin"
        ? "program administrator"
        : "resident";

  const text = [
    `${user.fullName || user.email} has invited you to ${APP_NAME} for ${program.name} at ${program.institution}.`,
    "",
    `${APP_NAME} is how the program swaps shifts: post a shift you cannot work, see what your co-residents can offer, and complete an approved switch from your phone.`,
    "",
    `You have been invited as a ${roleLabel}.`,
    "",
    "Accept your invitation:",
    created.url,
    "",
    `Sign in with Google using ${created.invitation.email} — that address has to match, so this link only works for you.`,
    "",
    `The link expires on ${created.invitation.expires_at.toDateString()}.`,
  ].join("\n");

  return {
    to: created.invitation.email,
    subject: `You've been invited to ${APP_NAME} for ${program.name}`,
    text,
    url: created.url,
  };
}

/**
 * Attempts delivery. Never throws: a transport failure must not roll back an
 * invitation that was created successfully — the link still works, and the
 * administrator can send it by hand.
 */
export async function sendInvitationEmail(
  context: Pick<AuthedContext, "program" | "user">,
  created: CreatedInvitation,
): Promise<DeliveryOutcome> {
  const transportName = getInvitationTransport().name;
  let outcome: DeliveryOutcome;
  try {
    const message = buildInvitationMessage(context, created);
    outcome = await getInvitationTransport().send(message);
  } catch (error) {
    // A transport that throws must not turn a created invitation into a
    // reported failure. The link exists and works; only delivery went wrong,
    // and the administrator can still send it by hand.
    outcome = {
      delivered: false,
      reason: `The email service failed: ${
        error instanceof Error ? error.message : "unknown error"
      }. The invitation link still works — copy it and send it yourself.`,
    };
  }
  logger.info("invitation.delivery", {
    invitationId: created.invitation.id,
    transport: transportName,
    delivered: outcome.delivered,
  });
  return outcome;
}

/** A `mailto:` the administrator can send from their own mailbox. */
export function invitationMailtoUrl(
  context: Pick<AuthedContext, "program" | "user">,
  created: CreatedInvitation,
): string {
  const message = buildInvitationMessage(context, created);
  const params = new URLSearchParams({
    subject: message.subject,
    body: message.text,
  });
  return `mailto:${encodeURIComponent(message.to)}?${params.toString()}`;
}
