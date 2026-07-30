import { queryOne, withTransaction } from "@/server/db/pool";
import type { ProgramRow, UserRow } from "@/server/db/types";
import { recordAudit } from "@/server/domain/audit";
import type { VerifiedIdentity } from "./oidc";

/**
 * Turns a verified Google identity into an application user.
 *
 * Rules:
 *  - The identity is only ever taken from a verified id_token.
 *  - An account is matched by Google `sub` first, then by verified email
 *    (which lets an administrator pre-provision a resident by email).
 *  - A brand new account is created *without* a role or program. It cannot do
 *    anything until an administrator configures it (see /pending).
 *  - `BOOTSTRAP_ADMIN_EMAILS` promotes the very first administrator(s) so a
 *    fresh deployment is usable. It is a no-op once an admin exists.
 *  - If the user's program restricts email domains, a mismatch is rejected.
 */

export type ProvisionResult =
  | { outcome: "ok"; user: UserRow }
  | { outcome: "domain_rejected"; message: string };

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

export function domainAllowed(email: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const domain = emailDomain(email);
  return domains.some((entry) => {
    const normalised = entry.trim().toLowerCase().replace(/^@/, "");
    return normalised.length > 0 && normalised === domain;
  });
}

function bootstrapEmails(): string[] {
  return (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export async function provisionUserFromIdentity(
  identity: VerifiedIdentity,
): Promise<ProvisionResult> {
  return withTransaction(async (client) => {
    const existing =
      (await queryOne<UserRow>(
        "SELECT * FROM users WHERE auth_user_id = $1",
        [identity.subject],
        client,
      )) ??
      (await queryOne<UserRow>(
        "SELECT * FROM users WHERE lower(email) = lower($1)",
        [identity.email],
        client,
      ));

    if (existing?.program_id) {
      const program = await queryOne<ProgramRow>(
        "SELECT * FROM programs WHERE id = $1",
        [existing.program_id],
        client,
      );
      if (
        program &&
        !domainAllowed(identity.email, program.approved_email_domains)
      ) {
        await recordAudit(
          {
            programId: program.id,
            actorUserId: existing.id,
            actorLabel: identity.email,
            action: "auth.login_denied",
            entityType: "user",
            entityId: existing.id,
            reason: "email_domain_not_approved",
          },
          client,
        );
        return {
          outcome: "domain_rejected" as const,
          message: `Sign-in for ${identity.email} is not permitted for ${program.name}. Approved domains: ${program.approved_email_domains
            .map((d) => `@${d.replace(/^@/, "")}`)
            .join(", ")}.`,
        };
      }
    }

    if (existing) {
      const updated = await queryOne<UserRow>(
        `UPDATE users
            SET auth_user_id = COALESCE(auth_user_id, $2),
                full_name    = CASE WHEN $3 <> '' THEN $3 ELSE full_name END,
                picture_url  = COALESCE($4, picture_url),
                last_login_at = now()
          WHERE id = $1
        RETURNING *`,
        [existing.id, identity.subject, identity.name, identity.picture],
        client,
      );
      await recordAudit(
        {
          programId: updated?.program_id ?? null,
          actorUserId: existing.id,
          actorLabel: identity.email,
          action: "auth.login",
          entityType: "user",
          entityId: existing.id,
        },
        client,
      );
      return { outcome: "ok" as const, user: updated as UserRow };
    }

    // New account. Only the configured bootstrap emails may self-promote, and
    // only while the instance has no administrator at all.
    const adminExists = await queryOne<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin') AS exists",
      [],
      client,
    );
    const isBootstrap =
      !adminExists?.exists &&
      bootstrapEmails().includes(identity.email.toLowerCase());

    let role: UserRow["role"] = null;
    let programId: string | null = null;
    if (isBootstrap) {
      const program = await queryOne<ProgramRow>(
        "SELECT * FROM programs ORDER BY created_at LIMIT 1",
        [],
        client,
      );
      if (program) {
        role = "admin";
        programId = program.id;
      }
    }

    const created = await queryOne<UserRow>(
      `INSERT INTO users (auth_user_id, email, full_name, picture_url, role, program_id, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       RETURNING *`,
      [
        identity.subject,
        identity.email,
        identity.name,
        identity.picture,
        role,
        programId,
      ],
      client,
    );
    await recordAudit(
      {
        programId,
        actorUserId: created?.id ?? null,
        actorLabel: identity.email,
        action: "user.created",
        entityType: "user",
        entityId: created?.id ?? null,
        newState: { email: identity.email, role },
        reason: isBootstrap ? "bootstrap_admin" : "first_google_login",
      },
      client,
    );
    return { outcome: "ok" as const, user: created as UserRow };
  });
}
