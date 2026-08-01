import { createHash, randomBytes } from "node:crypto";
import { query, queryOne, withTransaction, type Queryable } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import type { UserRole, UserRow } from "@/server/db/types";
import { notFound, validationFailed } from "@/server/http/errors";
import { logger } from "@/server/observability/logger";
import { recordAudit } from "./audit";
import { linkIdentity } from "./account";
import { claimHeldRows, type ClaimResult } from "./held-rows";

/**
 * Enrollment links.
 *
 * ## Why these exist alongside invitations
 *
 * An invitation names one address and is consumed once. That is the right shape
 * for appointing a chief resident and the wrong shape for onboarding a class:
 * a programme starting a beta has forty residents, a coordinator with a
 * spreadsheet, and no appetite for typing forty addresses correctly.
 *
 * An enrollment link is handed to a group. It expires, it can be revoked, it
 * can cap its own uses, it is rate limited, and every single use is written to
 * `enrollment_events` whether it succeeded or not.
 *
 * ## What stops it being a hole
 *
 * Anybody holding the link can open it, so the link alone never confers
 * membership of anybody else's data. Two things narrow it:
 *
 *   - **The programme's own email domains.** An address inside one is admitted
 *     at once: a hospital address is already proof of belonging.
 *   - **Everybody else joins pending.** They get an account, their program, and
 *     whatever schedule was waiting for them — and they see nothing about
 *     anybody else until somebody with the authority admits them.
 *
 * Refusing the second group outright would be the safer-looking choice and the
 * wrong one: it sends away a real resident using a personal address at the only
 * moment they were willing to sign up, and it does it silently.
 *
 * ## Role and schedule are independent
 *
 * A link grants a *role*. What somebody's schedule contains comes from held
 * import rows matched to their name, and from what they enter themselves.
 * Neither implies the other: a resident may enroll before their block is
 * imported, or after, and gets the same result either way.
 */

const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 180;

/** How many attempts one link tolerates in a window, before it stops answering. */
const RATE_LIMIT_ATTEMPTS = 30;
const RATE_LIMIT_WINDOW_MINUTES = 10;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface EnrollmentLinkRow {
  id: string;
  program_id: string;
  token_hash: string;
  label: string;
  grants_role: UserRole;
  expires_at: Date;
  max_uses: number | null;
  uses: number;
  revoked_at: Date | null;
  revoked_by: string | null;
  created_by: string | null;
  created_at: Date;
}

export type EnrollmentLinkStatus = "active" | "revoked" | "expired" | "used_up";

export function linkStatusOf(row: {
  revoked_at: Date | null;
  expires_at: Date;
  max_uses: number | null;
  uses: number;
}): EnrollmentLinkStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at.getTime() <= Date.now()) return "expired";
  if (row.max_uses !== null && row.uses >= row.max_uses) return "used_up";
  return "active";
}

/** How each status reads to the person looking at the list. Never the bare word. */
export const LINK_STATUS_LABEL: Record<EnrollmentLinkStatus, string> = {
  active: "Working now",
  revoked: "Turned off",
  expired: "Ran out",
  used_up: "Used up",
};

export interface CreatedEnrollmentLink {
  link: EnrollmentLinkRow;
  /** The only moment the raw token exists. It is never stored or logged. */
  token: string;
  url: string;
}

export function enrollmentUrl(token: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/join/${token}`;
}

export async function createEnrollmentLink(
  context: AuthedContext,
  input: {
    label?: string;
    expiresInDays?: number;
    maxUses?: number | null;
    grantsRole?: UserRole;
  } = {},
): Promise<CreatedEnrollmentLink> {
  const days = input.expiresInDays ?? DEFAULT_TTL_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TTL_DAYS) {
    throw validationFailed(
      `A link can last between 1 and ${MAX_TTL_DAYS} days. A link that never expires is a link somebody still holds after they leave.`,
    );
  }
  if (
    input.maxUses !== undefined &&
    input.maxUses !== null &&
    (!Number.isInteger(input.maxUses) || input.maxUses < 1)
  ) {
    throw validationFailed("A limit on uses is a whole number, one or more.");
  }
  /* Only a role junior to the issuer's, and only ever a role somebody would
     actually hand to a class. A link that grants leadership is not a feature
     anybody asked for and is the worst thing a leaked URL could carry. */
  const grants = input.grantsRole ?? "resident";
  if (grants !== "resident") {
    throw validationFailed(
      "An enrollment link signs people up as residents. To appoint a chief or program leadership, invite them by name under Users.",
    );
  }

  const token = randomBytes(32).toString("base64url");
  const link = await queryOne<EnrollmentLinkRow>(
    `INSERT INTO enrollment_links
       (program_id, token_hash, label, grants_role, expires_at, max_uses, created_by)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval, $6, $7)
     RETURNING *`,
    [
      context.program.id,
      hashToken(token),
      (input.label ?? "").trim(),
      grants,
      String(days),
      input.maxUses ?? null,
      context.user.id,
    ],
  );

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "enrollment_link.created",
    entityType: "enrollment_link",
    entityId: link!.id,
    newState: { label: link!.label, expiresAt: link!.expires_at, maxUses: link!.max_uses },
  });

  return { link: link!, token, url: enrollmentUrl(token) };
}

export interface EnrollmentLinkView extends EnrollmentLinkRow {
  status: EnrollmentLinkStatus;
  created_by_name: string | null;
  joined: number;
}

export async function listEnrollmentLinks(
  programId: string,
  executor?: Queryable,
): Promise<EnrollmentLinkView[]> {
  const rows = await query<EnrollmentLinkRow & { created_by_name: string | null; joined: number }>(
    `SELECT l.*, u.full_name AS created_by_name,
            (SELECT count(*)::int FROM enrollment_events e
              WHERE e.link_id = l.id AND e.outcome <> 'refused') AS joined
       FROM enrollment_links l
       LEFT JOIN users u ON u.id = l.created_by
      WHERE l.program_id = $1
      ORDER BY l.created_at DESC`,
    [programId],
    executor,
  );
  return rows.map((row) => ({ ...row, status: linkStatusOf(row) }));
}

export async function revokeEnrollmentLink(
  context: AuthedContext,
  linkId: string,
): Promise<EnrollmentLinkRow> {
  const row = await queryOne<EnrollmentLinkRow>(
    `UPDATE enrollment_links
        SET revoked_at = coalesce(revoked_at, now()), revoked_by = $3
      WHERE id = $1 AND program_id = $2
      RETURNING *`,
    [linkId, context.program.id, context.user.id],
  );
  if (!row) throw notFound("That link no longer exists.");

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "enrollment_link.revoked",
    entityType: "enrollment_link",
    entityId: row.id,
  });
  return row;
}

// ---------------------------------------------------------------------------
// The programme's own email domains
// ---------------------------------------------------------------------------

export async function listEmailDomains(
  programId: string,
  executor?: Queryable,
): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    "SELECT domain FROM program_email_domains WHERE program_id = $1 ORDER BY domain",
    [programId],
    executor,
  );
  return rows.map((row) => row.domain);
}

export async function addEmailDomain(
  context: AuthedContext,
  domain: string,
): Promise<string> {
  const cleaned = domain.trim().toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(cleaned)) {
    throw validationFailed(
      `"${domain}" does not look like an email domain. Enter the part after the @ sign, for example hospital.org.`,
    );
  }
  await query(
    `INSERT INTO program_email_domains (program_id, domain, created_by)
     VALUES ($1, $2, $3) ON CONFLICT (program_id, domain) DO NOTHING`,
    [context.program.id, cleaned, context.user.id],
  );
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "program.updated",
    entityType: "program_email_domain",
    newState: { added: cleaned },
  });
  return cleaned;
}

export async function removeEmailDomain(
  context: AuthedContext,
  domain: string,
): Promise<void> {
  await query("DELETE FROM program_email_domains WHERE program_id = $1 AND domain = $2", [
    context.program.id,
    domain.trim().toLowerCase(),
  ]);
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "program.updated",
    entityType: "program_email_domain",
    newState: { removed: domain },
  });
}

/** Whether an address sits inside one of the programme's own domains. */
export function domainMatches(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const host = email.slice(at + 1).toLowerCase();
  /* A subdomain of a listed domain counts — `med.hospital.org` under
     `hospital.org` — because that is how hospital mail is actually arranged.
     The boundary is a dot, so `nothospital.org` does not match `hospital.org`. */
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export type EnrollRefusal =
  | "unknown"
  | "expired"
  | "revoked"
  | "used_up"
  | "rate_limited"
  | "other_program";

export type EnrollOutcome =
  | {
      outcome: "enrolled";
      user: UserRow;
      residentId: string;
      /** Whether the account is a full member or waiting to be admitted. */
      status: "confirmed" | "pending";
      /** What was already waiting for them. */
      schedule: ClaimResult;
    }
  | { outcome: "refused"; reason: EnrollRefusal };

/** What a refusal says to the person holding the link. No dead ends. */
export const ENROLL_REFUSAL_MESSAGE: Record<EnrollRefusal, string> = {
  unknown:
    "This link is not one we recognise. Check you copied the whole thing, or ask your program for a new one.",
  expired:
    "This link has run out. Ask your chief or program coordinator for a new one — it takes them a few seconds.",
  revoked:
    "This link has been turned off. Ask your chief or program coordinator for a new one.",
  used_up:
    "This link has been used as many times as it was set up for. Ask your program for a new one.",
  rate_limited:
    "This link has been opened a lot in the last few minutes, so it has paused. Try again in ten minutes.",
  other_program:
    "You are already signed in to a different program. Sign out first, then open this link again.",
};

/**
 * Somebody arriving with a link and a verified Google identity.
 *
 * Everything happens in one transaction: the account, the resident record, the
 * held rows that were waiting for them, and the audit entry. A person whose
 * enrollment half-succeeded would be the worst version of this — an account
 * with no schedule, or a schedule claimed by an account that does not exist.
 */
export async function enrollWithLink(
  token: string,
  identity: { subject: string; email: string; name: string; picture: string | null },
  meta: { ip?: string } = {},
): Promise<EnrollOutcome> {
  return withTransaction(async (client) => {
    const link = await queryOne<EnrollmentLinkRow>(
      "SELECT * FROM enrollment_links WHERE token_hash = $1 FOR UPDATE",
      [hashToken(token)],
      client,
    );
    if (!link) {
      /* Nothing to record against: there is no link to attribute the attempt
         to, and writing one row per guessed token is how a log becomes a denial
         of service against itself. The logger keeps the shape of the event. */
      logger.warn("enrollment.unknown_token", {});
      return { outcome: "refused" as const, reason: "unknown" as const };
    }

    const status = linkStatusOf(link);
    if (status !== "active") {
      const reason = (status === "expired"
        ? "expired"
        : status === "revoked"
          ? "revoked"
          : "used_up") as EnrollRefusal;
      await recordEnrollmentEvent(client, link, identity.email, "refused", reason, meta);
      return { outcome: "refused" as const, reason };
    }

    /* Rate limit. Counted per link rather than per address, because the thing
       being protected is the link: somebody working through a list of addresses
       against one URL is exactly the attack, and they would use a new address
       each time. */
    const recent = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM enrollment_events
        WHERE link_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
      [link.id, String(RATE_LIMIT_WINDOW_MINUTES)],
      client,
    );
    if ((recent?.count ?? 0) >= RATE_LIMIT_ATTEMPTS) {
      await recordEnrollmentEvent(
        client,
        link,
        identity.email,
        "refused",
        "rate_limited",
        meta,
      );
      return { outcome: "refused" as const, reason: "rate_limited" as const };
    }

    const existing = await queryOne<UserRow>(
      "SELECT * FROM users WHERE lower(email) = lower($1) FOR UPDATE",
      [identity.email],
      client,
    );
    if (existing && existing.program_id && existing.program_id !== link.program_id) {
      await recordEnrollmentEvent(
        client,
        link,
        identity.email,
        "refused",
        "other_program",
        meta,
      );
      return { outcome: "refused" as const, reason: "other_program" as const };
    }

    const domains = await listEmailDomains(link.program_id, client);
    /* No domains listed means the programme has not told us what its addresses
       look like, so we cannot claim an address proves anything. Everybody lands
       pending, which is the honest reading of "we do not know". */
    const admitted = domains.length > 0 && domainMatches(identity.email, domains);
    const enrollmentStatus = admitted ? "confirmed" : "pending";

    /* An account that already exists and is already confirmed keeps that: this
       link is not a way to demote somebody, and re-opening it should be a
       no-op rather than a downgrade. */
    const keepConfirmed = existing?.enrollment_status === "confirmed";
    const finalStatus = keepConfirmed ? "confirmed" : enrollmentStatus;

    const user = existing
      ? await queryOne<UserRow>(
          `UPDATE users
              SET auth_user_id = COALESCE(auth_user_id, $2),
                  full_name    = CASE WHEN $3 <> '' THEN $3 ELSE full_name END,
                  picture_url  = COALESCE($4, picture_url),
                  role         = COALESCE(role, $5),
                  program_id   = $6,
                  enrollment_status = $7,
                  active       = true,
                  last_login_at = now()
            WHERE id = $1
          RETURNING *`,
          [
            existing.id,
            identity.subject,
            identity.name,
            identity.picture,
            link.grants_role,
            link.program_id,
            finalStatus,
          ],
          client,
        )
      : await queryOne<UserRow>(
          `INSERT INTO users
             (auth_user_id, email, full_name, picture_url, role, program_id,
              enrollment_status, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           RETURNING *`,
          [
            identity.subject,
            identity.email,
            identity.name,
            identity.picture,
            link.grants_role,
            link.program_id,
            finalStatus,
          ],
          client,
        );

    /* A schedule needs somewhere to live. The resident record is created here
       rather than when somebody is confirmed, because held rows are attached in
       this same transaction and a person who lands with nothing has no reason
       to come back. */
    let resident = await queryOne<{ id: string }>(
      "SELECT id FROM residents WHERE user_id = $1 AND program_id = $2",
      [user!.id, link.program_id],
      client,
    );
    if (!resident) {
      resident = await queryOne<{ id: string }>(
        `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials)
         VALUES ($1, $2, $3, $4, '{}')
         RETURNING id`,
        [user!.id, link.program_id, 1, new Date().getFullYear() + 3],
        client,
      );
    }

    await linkIdentity(
      user!.id,
      { provider: "google", subject: identity.subject, email: identity.email },
      client,
    );

    /* The point of the whole thing: whatever the programme's file said about
       this person, waiting since before they had an account. */
    const schedule = await claimHeldRows(
      link.program_id,
      { id: resident!.id, name: user!.full_name, email: user!.email },
      client,
    );

    await query("UPDATE enrollment_links SET uses = uses + 1 WHERE id = $1", [link.id], client);
    await recordEnrollmentEvent(
      client,
      link,
      identity.email,
      admitted ? "admitted" : "pending",
      admitted
        ? "email domain recognised"
        : "email domain not recognised; sees only their own schedule until admitted",
      meta,
      user!.id,
    );

    await recordAudit(
      {
        programId: link.program_id,
        actorUserId: user!.id,
        actorLabel: user!.email,
        action: "enrollment.joined",
        entityType: "user",
        entityId: user!.id,
        newState: {
          linkId: link.id,
          status: finalStatus,
          claimedShifts: schedule.createdShifts,
        },
      },
      client,
    );

    return {
      outcome: "enrolled" as const,
      user: user!,
      residentId: resident!.id,
      status: finalStatus as "confirmed" | "pending",
      schedule,
    };
  });
}

async function recordEnrollmentEvent(
  client: Queryable,
  link: EnrollmentLinkRow,
  email: string,
  outcome: "admitted" | "pending" | "refused",
  detail: string,
  meta: { ip?: string },
  userId?: string,
): Promise<void> {
  await query(
    `INSERT INTO enrollment_events (link_id, program_id, user_id, email, outcome, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      link.id,
      link.program_id,
      userId ?? null,
      email.toLowerCase(),
      outcome,
      detail,
      meta.ip ?? "",
    ],
    client,
  );
}

export interface EnrollmentEventView {
  id: string;
  email: string;
  outcome: string;
  detail: string;
  created_at: Date;
  label: string;
}

/** Every use of every link, which is what "audit every enrollment" means. */
export async function listEnrollmentEvents(
  programId: string,
  limit = 100,
  executor?: Queryable,
): Promise<EnrollmentEventView[]> {
  return query<EnrollmentEventView>(
    `SELECT e.id, e.email, e.outcome, e.detail, e.created_at,
            coalesce(l.label, '') AS label
       FROM enrollment_events e
       LEFT JOIN enrollment_links l ON l.id = e.link_id
      WHERE e.program_id = $1
      ORDER BY e.created_at DESC
      LIMIT $2`,
    [programId, Math.min(limit, 500)],
    executor,
  );
}

// ---------------------------------------------------------------------------
// Admitting somebody who joined pending
// ---------------------------------------------------------------------------

export interface PendingMember {
  user_id: string;
  email: string;
  full_name: string;
  created_at: Date;
  shifts: number;
}

export async function listPendingMembers(
  programId: string,
  executor?: Queryable,
): Promise<PendingMember[]> {
  return query<PendingMember>(
    `SELECT u.id AS user_id, u.email, u.full_name, u.created_at,
            (SELECT count(*)::int
               FROM shift_assignments sa
               JOIN residents r ON r.id = sa.resident_id
              WHERE r.user_id = u.id AND sa.assignment_status = 'active') AS shifts
       FROM users u
      WHERE u.program_id = $1 AND u.enrollment_status = 'pending' AND u.active
      ORDER BY u.created_at`,
    [programId],
    executor,
  );
}

export async function countPendingMembers(
  programId: string,
  executor?: Queryable,
): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM users
      WHERE program_id = $1 AND enrollment_status = 'pending' AND active`,
    [programId],
    executor,
  );
  return row?.count ?? 0;
}

export async function admitMember(
  context: AuthedContext,
  userId: string,
): Promise<UserRow> {
  const row = await queryOne<UserRow>(
    `UPDATE users SET enrollment_status = 'confirmed'
      WHERE id = $1 AND program_id = $2 AND enrollment_status = 'pending'
      RETURNING *`,
    [userId, context.program.id],
  );
  if (!row) throw notFound("That person is not waiting to be admitted.");

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "enrollment.admitted",
    entityType: "user",
    entityId: row.id,
    newState: { email: row.email },
  });
  return row;
}
