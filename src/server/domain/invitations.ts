import { createHash, randomBytes } from "node:crypto";
import { getPool, query, queryOne, withTransaction, type Queryable } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import type { UserRole, UserRow } from "@/server/db/types";
import { conflict, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { linkIdentity } from "./account";
import { expectsResidentRecord } from "@/server/auth/roles";
import { logger } from "@/server/observability/logger";

/**
 * Invitations.
 *
 * The security model has two independent halves, and both must hold:
 *
 *   - the **token** proves the link reached the person it was sent to. It is
 *     32 random bytes, stored only as a SHA-256 hash, and it expires.
 *   - the **email match** proves identity. Acceptance requires the Google
 *     account's *verified* email to equal the invited address.
 *
 * Requiring both is what makes a forwarded link harmless: whoever receives it
 * cannot accept unless they also control the mailbox it was addressed to. A
 * token alone would turn "I forwarded this to the wrong resident" into a
 * silent, permanent access grant on somebody else's schedule.
 */

const DEFAULT_TTL_DAYS = 14;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface InvitationRow {
  id: string;
  program_id: string;
  email: string;
  role: UserRole;
  full_name: string;
  pgy_level: number | null;
  graduation_year: number | null;
  expires_at: Date;
  revoked_at: Date | null;
  accepted_at: Date | null;
  accepted_user_id: string | null;
  invited_by: string | null;
  send_count: number;
  last_sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type InvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export interface InvitationView extends InvitationRow {
  status: InvitationStatus;
  invited_by_name: string | null;
  accepted_user_email: string | null;
}

/** Status is derived, never stored — a stored copy would go stale on expiry. */
export function statusOf(row: {
  accepted_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
}): InvitationStatus {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (row.expires_at.getTime() <= Date.now()) return "expired";
  return "pending";
}

export interface CreateInvitationInput {
  email: string;
  role: UserRole;
  fullName?: string;
  pgyLevel?: number | null;
  graduationYear?: number | null;
  expiresInDays?: number;
}

export interface CreatedInvitation {
  invitation: InvitationRow;
  /** The only time the raw token exists. It is never stored or logged. */
  token: string;
  url: string;
}

export function invitationUrl(token: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/invite/${token}`;
}

function normaliseEmail(email: string): string {
  return email.trim();
}

/**
 * Creates one invitation.
 *
 * Refuses when the address already belongs to a configured member of this
 * program — inviting somebody who can already sign in produces a confusing
 * second identity for the same person, which is exactly the duplication this
 * feature is supposed to prevent.
 */
export async function createInvitation(
  context: AuthedContext,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const email = normaliseEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw validationFailed(`"${email}" is not a valid email address.`);
  }

  const existingUser = await queryOne<UserRow>(
    "SELECT * FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  if (existingUser?.program_id === context.program.id && existingUser.role) {
    throw conflict(
      `${email} is already a member of your program. Change their role under Users instead.`,
    );
  }
  if (existingUser && existingUser.program_id && existingUser.program_id !== context.program.id) {
    throw conflict(
      `${email} already belongs to a different program. Contact your administrator.`,
    );
  }

  const ttlDays = input.expiresInDays ?? DEFAULT_TTL_DAYS;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);

  const invitation = await withTransaction(async (client) => {
    /* Serialise concurrent creates for the same address.
     *
     * Superseding-then-inserting is read-modify-write, and the partial unique
     * index `invitations_one_live_per_email` enforces the invariant at the end
     * of it. Two requests racing — a double-tapped button, or a retried
     * request — both saw no live invitation, both revoked nothing, and both
     * inserted; one then died on the constraint with a message naming an index.
     *
     * An advisory lock keyed on the program and address makes the pair atomic
     * without touching any other invitation. It is transaction-scoped, so it is
     * released on commit or rollback with no cleanup path to forget.
     */
    await query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`invitation:${context.program.id}:${email.toLowerCase()}`],
      client,
    );

    // Supersede any live invitation for this address, so "invite again" is a
    // safe thing to do rather than a unique-violation. The old token stops
    // working the moment the new one is issued.
    await query(
      `UPDATE invitations SET revoked_at = now()
        WHERE program_id = $1 AND lower(email) = lower($2)
          AND accepted_at IS NULL AND revoked_at IS NULL`,
      [context.program.id, email],
      client,
    );

    const row = await queryOne<InvitationRow>(
      `INSERT INTO invitations
         (program_id, email, role, full_name, pgy_level, graduation_year,
          token_hash, expires_at, invited_by, send_count, last_sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, now())
       RETURNING *`,
      [
        context.program.id,
        email,
        input.role,
        input.fullName ?? "",
        input.pgyLevel ?? null,
        input.graduationYear ?? null,
        hashToken(token),
        expiresAt,
        context.user.id,
      ],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "invitation.created",
        entityType: "invitation",
        entityId: row!.id,
        newState: { email, role: input.role, expiresAt },
      },
      client,
    );
    return row!;
  });

  return { invitation, token, url: invitationUrl(token) };
}

/** Issues a fresh token for an existing pending invitation. */
export async function resendInvitation(
  context: AuthedContext,
  invitationId: string,
): Promise<CreatedInvitation> {
  const existing = await queryOne<InvitationRow>(
    "SELECT * FROM invitations WHERE id = $1 AND program_id = $2",
    [invitationId, context.program.id],
  );
  if (!existing) throw notFound("That invitation no longer exists.");
  const status = statusOf(existing);
  if (status === "accepted") {
    throw conflict("That invitation has already been accepted.");
  }
  if (status === "revoked") {
    throw conflict("That invitation was cancelled. Send a new one instead.");
  }

  // Resending rotates the token and extends the deadline. The previous link
  // stops working, which is the behaviour an administrator expects when they
  // resend because the first one "might have leaked".
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000);

  const invitation = await withTransaction(async (client) => {
    const row = await queryOne<InvitationRow>(
      `UPDATE invitations
          SET token_hash = $2, expires_at = $3,
              send_count = send_count + 1, last_sent_at = now()
        WHERE id = $1
      RETURNING *`,
      [invitationId, hashToken(token), expiresAt],
      client,
    );
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "invitation.resent",
        entityType: "invitation",
        entityId: invitationId,
        newState: { sendCount: row!.send_count, expiresAt },
      },
      client,
    );
    return row!;
  });

  return { invitation, token, url: invitationUrl(token) };
}

export async function revokeInvitation(
  context: AuthedContext,
  invitationId: string,
): Promise<void> {
  const existing = await queryOne<InvitationRow>(
    "SELECT * FROM invitations WHERE id = $1 AND program_id = $2",
    [invitationId, context.program.id],
  );
  if (!existing) throw notFound("That invitation no longer exists.");
  if (existing.accepted_at) {
    throw conflict(
      "That invitation has already been accepted. Deactivate the account under Users instead.",
    );
  }
  if (existing.revoked_at) return; // Already cancelled; nothing to do.

  await withTransaction(async (client) => {
    await query(
      "UPDATE invitations SET revoked_at = now() WHERE id = $1",
      [invitationId],
      client,
    );
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "invitation.revoked",
        entityType: "invitation",
        entityId: invitationId,
        previousState: { email: existing.email, role: existing.role },
      },
      client,
    );
  });
}

export async function listInvitations(
  programId: string,
): Promise<InvitationView[]> {
  const rows = await query<
    InvitationRow & { invited_by_name: string | null; accepted_user_email: string | null }
  >(
    `SELECT i.*,
            inviter.full_name AS invited_by_name,
            accepted.email     AS accepted_user_email
       FROM invitations i
       LEFT JOIN users inviter  ON inviter.id  = i.invited_by
       LEFT JOIN users accepted ON accepted.id = i.accepted_user_id
      WHERE i.program_id = $1
      ORDER BY i.created_at DESC
      LIMIT 500`,
    [programId],
  );
  return rows.map((row) => ({ ...row, status: statusOf(row) }));
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

export interface InvitationOffer {
  id: string;
  email: string;
  role: UserRole;
  programName: string;
  institution: string;
  invitedByName: string | null;
  expiresAt: Date;
}

/**
 * Looks up an invitation by raw token for the public acceptance page. Returns
 * null for anything not currently usable, so the page cannot distinguish
 * "never existed" from "expired" from "revoked" — that distinction is only
 * useful to somebody guessing tokens.
 */
export async function findUsableInvitation(
  token: string,
  executor: Queryable = getPool(),
): Promise<InvitationOffer | null> {
  if (!token || token.length < 20) return null;
  const row = await queryOne<
    InvitationRow & { program_name: string; institution: string; invited_by_name: string | null }
  >(
    `SELECT i.*, p.name AS program_name, p.institution,
            inviter.full_name AS invited_by_name
       FROM invitations i
       JOIN programs p ON p.id = i.program_id
       LEFT JOIN users inviter ON inviter.id = i.invited_by
      WHERE i.token_hash = $1`,
    [hashToken(token)],
    executor,
  );
  if (!row) return null;
  if (statusOf(row) !== "pending") return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    programName: row.program_name,
    institution: row.institution,
    invitedByName: row.invited_by_name,
    expiresAt: row.expires_at,
  };
}

export type AcceptOutcome =
  | { outcome: "accepted"; user: UserRow }
  | { outcome: "invalid" }
  | { outcome: "email_mismatch"; invitedEmail: string };

/**
 * Redeems an invitation for a verified Google identity.
 *
 * Runs in one transaction and locks the invitation row, so two simultaneous
 * acceptances of the same link cannot both succeed.
 */
export async function acceptInvitation(
  token: string,
  identity: { subject: string; email: string; name: string; picture: string | null },
): Promise<AcceptOutcome> {
  return withTransaction(async (client) => {
    const row = await queryOne<InvitationRow>(
      "SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE",
      [hashToken(token)],
      client,
    );
    if (!row || statusOf(row) !== "pending") return { outcome: "invalid" as const };

    if (row.email.trim().toLowerCase() !== identity.email.trim().toLowerCase()) {
      // Deliberately not consumed: the real invitee must still be able to use
      // their link after somebody else opened it by mistake.
      logger.warn("invitation.email_mismatch", {
        invitationId: row.id,
        invited: row.email,
      });
      return { outcome: "email_mismatch" as const, invitedEmail: row.email };
    }

    // Reuse an existing account for this address if there is one — that is what
    // stops an invitation creating a second user for somebody who already
    // signed in and was waiting to be configured.
    const existing = await queryOne<UserRow>(
      "SELECT * FROM users WHERE lower(email) = lower($1) FOR UPDATE",
      [identity.email],
      client,
    );

    const user = existing
      ? await queryOne<UserRow>(
          `UPDATE users
              SET auth_user_id = COALESCE(auth_user_id, $2),
                  full_name    = CASE WHEN $3 <> '' THEN $3 ELSE full_name END,
                  picture_url  = COALESCE($4, picture_url),
                  role         = $5,
                  program_id   = $6,
                  active       = true,
                  last_login_at = now()
            WHERE id = $1
          RETURNING *`,
          [
            existing.id,
            identity.subject,
            identity.name,
            identity.picture,
            row.role,
            row.program_id,
          ],
          client,
        )
      : await queryOne<UserRow>(
          `INSERT INTO users (auth_user_id, email, full_name, picture_url, role, program_id, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           RETURNING *`,
          [
            identity.subject,
            identity.email,
            identity.name || row.full_name,
            identity.picture,
            row.role,
            row.program_id,
          ],
          client,
        );

    /* A role that holds a schedule needs a resident record, or the person signs
       in to an account with no shifts and no way to trade. That means chief
       residents too — a chief is a resident with extra responsibilities, and
       checking only for `"resident"` here left every invited chief unable to
       hold a shift. The predicate is shared with `updateManagedUser` so the two
       paths cannot drift apart again. */
    if (expectsResidentRecord(row.role)) {
      const resident = await queryOne<{ id: string }>(
        "SELECT id FROM residents WHERE user_id = $1",
        [user!.id],
        client,
      );
      if (!resident) {
        await query(
          `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials)
           VALUES ($1, $2, $3, $4, '{}')`,
          [
            user!.id,
            row.program_id,
            row.pgy_level ?? 1,
            row.graduation_year ?? new Date().getFullYear() + 3,
          ],
          client,
        );
      }
    }

    await query(
      `UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`,
      [row.id, user!.id],
      client,
    );

    await linkIdentity(
      user!.id,
      { provider: "google", subject: identity.subject, email: identity.email },
      client,
    );

    await recordAudit(
      {
        programId: row.program_id,
        actorUserId: user!.id,
        actorLabel: identity.email,
        action: "invitation.accepted",
        entityType: "invitation",
        entityId: row.id,
        newState: { role: row.role },
      },
      client,
    );

    logger.info("invitation.accepted", { invitationId: row.id, role: row.role });
    return { outcome: "accepted" as const, user: user as UserRow };
  });
}

/** Housekeeping: nothing depends on this, but it keeps the table honest. */
export async function purgeExpiredInvitations(): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM invitations
      WHERE accepted_at IS NULL
        AND expires_at < now() - interval '90 days'
      RETURNING id`,
  );
  return rows.length;
}
