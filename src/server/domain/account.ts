import { createHash, randomBytes } from "node:crypto";
import { getPool, query, queryOne, withTransaction, type Queryable } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { logger } from "@/server/observability/logger";

/**
 * Account lifecycle: linking identities, deletion, and the calendar feed.
 *
 * Deletion is deliberately not "erase everything". A completed switch is the
 * operational record of who was responsible for a shift; a program cannot lose
 * that because somebody uninstalled the app. What deletion does is end access,
 * remove personal contact details and devices, and anonymise the account, while
 * the schedule and audit history remain attached to an anonymous resident
 * record. This is documented for users in docs/DATA_RETENTION.md and in the
 * privacy policy, and surfaced in the app before the user confirms.
 */

// ---------------------------------------------------------------------------
// Identity linking
// ---------------------------------------------------------------------------

export interface IdentityInput {
  provider: "google" | "apple";
  subject: string;
  email: string | null;
  isPrivateRelay?: boolean;
}

/**
 * Finds the application user an identity belongs to, without ever creating a
 * second account for the same person:
 *   1. an identity row for this exact (provider, subject);
 *   2. an existing user with this verified email;
 *   3. a previously linked identity that used the same email.
 */
export async function findUserForIdentity(
  input: IdentityInput,
): Promise<string | null> {
  const linked = await queryOne<{ user_id: string }>(
    "SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2",
    [input.provider, input.subject],
  );
  if (linked) return linked.user_id;

  if (!input.email) return null;

  const byUser = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE lower(email) = lower($1)",
    [input.email],
  );
  if (byUser) return byUser.id;

  const byIdentity = await queryOne<{ user_id: string }>(
    "SELECT user_id FROM user_identities WHERE lower(email) = lower($1) LIMIT 1",
    [input.email],
  );
  return byIdentity?.user_id ?? null;
}

/** Records that this provider identity belongs to this user. Idempotent. */
export async function linkIdentity(
  userId: string,
  input: IdentityInput,
  // Callers inside a transaction must pass their client: the insert has a
  // foreign key to `users`, and a second connection would block on the
  // uncommitted row.
  executor: Queryable = getPool(),
): Promise<void> {
  await query(
    `INSERT INTO user_identities (user_id, provider, subject, email, is_private_relay, last_login_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider, subject) DO UPDATE
        SET last_login_at = now(),
            email = COALESCE(EXCLUDED.email, user_identities.email)`,
    [
      userId,
      input.provider,
      input.subject,
      input.email,
      input.isPrivateRelay ?? false,
    ],
    executor,
  );
}

export async function listIdentities(userId: string) {
  return query<{ provider: string; email: string | null; last_login_at: Date | null }>(
    "SELECT provider, email, last_login_at FROM user_identities WHERE user_id = $1 ORDER BY provider",
    [userId],
  );
}

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

export interface DeletionPreview {
  /** Removed outright. */
  removed: string[];
  /** Kept, and why. */
  retained: Array<{ item: string; reason: string }>;
  /** Blocks immediate deletion until resolved. */
  blockers: string[];
}

/**
 * Deletion has to work for *any* account that exists, including one an
 * administrator has not yet attached to a program. Such an account is still a
 * real account with a real email address, so it takes a looser context than the
 * rest of the domain: no role, no program, no resident record.
 */
export interface DeletionContext {
  user: { id: string; email: string };
  program: { id: string } | null;
  resident: { id: string } | null;
}

export function deletionContext(context: AuthedContext): DeletionContext {
  return {
    user: { id: context.user.id, email: context.user.email },
    program: { id: context.program.id },
    resident: context.resident ? { id: context.resident.id } : null,
  };
}

export async function previewAccountDeletion(
  context: DeletionContext,
): Promise<DeletionPreview> {
  const residentId = context.resident?.id ?? null;

  const upcoming = residentId
    ? await queryOne<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM shift_assignments sa
           JOIN shifts s ON s.id = sa.shift_id
          WHERE sa.resident_id = $1 AND sa.assignment_status = 'active'
            AND s.start_datetime > now() AND s.status <> 'cancelled'`,
        [residentId],
      )
    : null;
  const liveTrades = residentId
    ? await queryOne<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM trade_requests r
          WHERE r.initiating_resident_id = $1
            AND r.status IN ('open', 'offer_pending', 'accepted', 'pending_approval')`,
        [residentId],
      )
    : null;

  const blockers: string[] = [];
  const upcomingCount = Number(upcoming?.count ?? 0);
  if (upcomingCount > 0) {
    blockers.push(
      `You are still assigned to ${upcomingCount} upcoming shift${upcomingCount === 1 ? "" : "s"}. Your program must reassign them before your account can be deleted.`,
    );
  }
  const liveCount = Number(liveTrades?.count ?? 0);
  if (liveCount > 0) {
    blockers.push(
      `You have ${liveCount} trade post${liveCount === 1 ? "" : "s"} still live. Cancel them first.`,
    );
  }

  return {
    removed: [
      "Your name, email address and profile photo",
      "Your sign-in identities (you will no longer be able to sign in)",
      "Every device registered for push notifications",
      "Your notification preferences and in-app notifications",
      "Your calendar subscription link",
    ],
    retained: [
      {
        item: "Completed shift switches and who worked each shift",
        reason:
          "Your program needs a permanent record of who was responsible for each shift. These records are kept against an anonymised resident.",
      },
      {
        item: "Audit history of schedule changes",
        reason: "Required for the program's operational and accreditation records.",
      },
      {
        item: "Program notification emails you generated",
        reason:
          "They form part of the program's record of a completed switch. Your name remains in emails already sent from your own mail client.",
      },
    ],
    blockers,
  };
}

export interface DeletionResult {
  requestId: string;
  status: "completed" | "pending";
}

/**
 * Deletes the caller's account: anonymises the user, drops personal data and
 * access, and leaves the operational record intact.
 */
export async function deleteOwnAccount(
  context: DeletionContext,
  options: { reason?: string; confirm: string },
): Promise<DeletionResult> {
  if (options.confirm.trim().toUpperCase() !== "DELETE") {
    throw validationFailed('Type "DELETE" to confirm.');
  }
  const preview = await previewAccountDeletion(context);
  if (preview.blockers.length > 0) {
    throw conflict(preview.blockers[0]);
  }

  return withTransaction(async (client) => {
    const request = await queryOne<{ id: string }>(
      `INSERT INTO account_deletion_requests (user_id, requested_by, email_at_request, reason, status, completed_at)
       VALUES ($1, $1, $2, $3, 'completed', now())
       RETURNING id`,
      [context.user.id, context.user.email, options.reason ?? null],
      client,
    );

    // The resident record survives so the schedule keeps its shape, but it is
    // deactivated and no longer identifies a person.
    if (context.resident) {
      await query(
        "UPDATE residents SET active = false, credentials = '{}' WHERE id = $1",
        [context.resident.id],
        client,
      );
    }

    await query("DELETE FROM user_identities WHERE user_id = $1", [context.user.id], client);
    await query("DELETE FROM devices WHERE user_id = $1", [context.user.id], client);
    await query("DELETE FROM sessions WHERE user_id = $1", [context.user.id], client);
    await query("DELETE FROM notifications WHERE recipient_user_id = $1", [context.user.id], client);
    await query("DELETE FROM notification_preferences WHERE user_id = $1", [context.user.id], client);
    if (context.resident) {
      await query(
        "UPDATE calendar_feeds SET revoked_at = now() WHERE resident_id = $1 AND revoked_at IS NULL",
        [context.resident.id],
        client,
      );
    }

    // Anonymise rather than delete: foreign keys from completed trades, audit
    // entries and email records must keep resolving.
    const placeholder = `deleted-${context.user.id}@deleted.invalid`;
    await query(
      `UPDATE users
          SET email = $2,
              full_name = 'Former resident',
              picture_url = NULL,
              auth_user_id = NULL,
              active = false,
              anonymised_at = now()
        WHERE id = $1`,
      [context.user.id, placeholder],
      client,
    );

    await recordAudit(
      {
        // Null for an account that never got a program; audit_logs allows it.
        programId: context.program?.id ?? null,
        actorUserId: context.user.id,
        actorLabel: "account deletion",
        action: "user.deactivated",
        entityType: "user",
        entityId: context.user.id,
        newState: { anonymised: true, deletionRequestId: request!.id },
        reason: options.reason ?? "Account deleted by the user",
      },
      client,
    );

    logger.info("account.deleted", { userId: context.user.id });
    return { requestId: request!.id, status: "completed" as const };
  });
}

// ---------------------------------------------------------------------------
// Calendar feed
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Returns the resident's feed token, creating one on first use. */
export async function ensureCalendarFeed(residentId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO calendar_feeds (resident_id, token_hash) VALUES ($1, $2)
     ON CONFLICT (resident_id) WHERE revoked_at IS NULL DO NOTHING
     RETURNING id`,
    [residentId, hashToken(token)],
  );
  if (inserted) return token;
  // A feed already exists. Tokens are stored hashed, so the only way to hand
  // the user a URL again is to rotate it.
  return rotateCalendarFeed(residentId);
}

export async function rotateCalendarFeed(residentId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await withTransaction(async (client) => {
    await query(
      "UPDATE calendar_feeds SET revoked_at = now() WHERE resident_id = $1 AND revoked_at IS NULL",
      [residentId],
      client,
    );
    await query(
      "INSERT INTO calendar_feeds (resident_id, token_hash) VALUES ($1, $2)",
      [residentId, hashToken(token)],
      client,
    );
  });
  return token;
}

export async function revokeCalendarFeed(residentId: string): Promise<void> {
  await query(
    "UPDATE calendar_feeds SET revoked_at = now() WHERE resident_id = $1 AND revoked_at IS NULL",
    [residentId],
  );
}

export async function resolveCalendarFeed(token: string): Promise<{
  residentId: string;
  programId: string;
} | null> {
  const row = await queryOne<{ resident_id: string; program_id: string }>(
    `SELECT f.resident_id, r.program_id
       FROM calendar_feeds f
       JOIN residents r ON r.id = f.resident_id
      WHERE f.token_hash = $1 AND f.revoked_at IS NULL`,
    [hashToken(token)],
  );
  if (!row) return null;
  void query(
    "UPDATE calendar_feeds SET last_fetched_at = now() WHERE token_hash = $1",
    [hashToken(token)],
  ).catch(() => undefined);
  return { residentId: row.resident_id, programId: row.program_id };
}

export async function hasCalendarFeed(residentId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    "SELECT id FROM calendar_feeds WHERE resident_id = $1 AND revoked_at IS NULL",
    [residentId],
  );
  return Boolean(row);
}
