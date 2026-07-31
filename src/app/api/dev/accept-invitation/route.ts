import { z } from "zod";
import { createSession } from "@/server/auth/session";
import { acceptInvitation, findUsableInvitation } from "@/server/domain/invitations";
import { apiHandler, ok, parseJson } from "@/server/http/api";
import { forbidden, notFound, validationFailed } from "@/server/http/errors";
import { describeEnvironment } from "@/server/config/environment";
import { logger } from "@/server/observability/logger";

export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().min(20).max(200),
  /** Optional display name for the synthetic account, purely cosmetic. */
  fullName: z.string().max(200).optional(),
});

/**
 * Accepting an invitation as a synthetic account, for development only.
 *
 * The problem this solves: one person cannot test an invitation on their own.
 * Acceptance requires a Google account whose verified address equals the
 * invited address, and that is the whole security model — it is not something
 * to relax. So instead of weakening acceptance, this stands in for *Google*:
 * it supplies the same verified identity Google's callback would, for the
 * address the invitation was already issued to, and then hands off to
 * `acceptInvitation` — the identical function the production callback calls.
 *
 * What that means in practice:
 *
 *   - the invitation is real, its token is real and hashed, and it expires;
 *   - expiry, revocation and single-use are enforced exactly as in production,
 *     because it is the same code enforcing them;
 *   - the email match still has to hold — the identity is *derived from the
 *     invitation*, never supplied by the caller, so this cannot be used to
 *     attach an arbitrary identity to somebody else's invitation;
 *   - the resulting user, role, program and resident record are the real ones.
 *
 * It is disabled by two independent locks, both of which must be open:
 * `NODE_ENV` must not be `production`, and `ALLOW_TEST_LOGIN` must be exactly
 * `"true"`. A production build cannot reach this code even if the flag is set.
 */
export const POST = apiHandler(async (request: Request) => {
  const { invitationSandboxEnabled } = describeEnvironment();
  if (!invitationSandboxEnabled) {
    throw forbidden("The invitation sandbox is not available in this environment.");
  }

  const { token, fullName } = await parseJson(request, schema);

  const offer = await findUsableInvitation(token);
  if (!offer) {
    throw notFound(
      "That invitation is not usable — it may have expired, been cancelled, or already been accepted.",
    );
  }

  const result = await acceptInvitation(token, {
    // A stable synthetic subject per address, so accepting twice from the
    // sandbox recognises the same person rather than colliding on the identity
    // table. Prefixed so it can never be mistaken for a Google `sub`.
    subject: `dev-sandbox:${offer.email.toLowerCase()}`,
    email: offer.email,
    name: fullName?.trim() || offer.email.split("@")[0],
    picture: null,
  });

  if (result.outcome !== "accepted") {
    // Unreachable in practice — `findUsableInvitation` already passed — but a
    // race with a revoke would land here, and it should say so rather than 500.
    throw validationFailed("That invitation could no longer be accepted.");
  }

  logger.warn("dev.invitation_accepted", {
    email: offer.email,
    role: offer.role,
    program: offer.programName,
  });

  await createSession(result.user.id, { userAgent: "dev-invitation-sandbox" });

  return ok({
    accepted: true,
    user: {
      id: result.user.id,
      email: result.user.email,
      fullName: result.user.full_name,
      role: result.user.role,
    },
  });
});
