import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { PoolClient } from "pg";
import type { ProgramRow, UserRow } from "@/server/db/types";
import { recordAudit } from "@/server/domain/audit";
import { linkIdentity } from "@/server/domain/account";
import { claimHeldRows } from "@/server/domain/held-rows";
import type { VerifiedIdentity } from "./oidc";

/**
 * Turns a verified Google identity into an application user.
 *
 * Rules:
 *  - The identity is only ever taken from a verified id_token.
 *  - An account is matched by Google `sub` first, then by verified email
 *    (which lets an administrator pre-provision a resident by email).
 *  - A brand new account **joins the programme as a resident** and can use the
 *    product immediately. See `selfEnrol` for what that means and what it
 *    costs.
 *  - `BOOTSTRAP_ADMIN_EMAILS` promotes the very first administrator(s) so a
 *    fresh deployment is usable. It is a no-op once an admin exists.
 *  - If the program restricts email domains, a mismatch is rejected — on the
 *    way in as well as on the way back.
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

/**
 * Which programme a person signing in for the first time joins.
 *
 * One programme is the ordinary case and the only one a deployment has today,
 * so it is the answer whenever there is exactly one. With several, the address
 * has to say which — a programme that lists approved domains has told us what
 * its people look like, and exactly one match is a decision rather than a
 * guess. Anything else returns null and the account lands unconfigured, which
 * is the old behaviour and the honest one: two programmes and nothing to
 * distinguish them is not a question this function may answer by picking.
 */
async function programForNewMember(
  email: string,
  client: PoolClient,
): Promise<ProgramRow | null> {
  const programs = await query<ProgramRow>(
    "SELECT * FROM programs ORDER BY created_at",
    [],
    client,
  );
  if (programs.length === 0) return null;
  if (programs.length === 1) return programs[0];

  const matching = programs.filter(
    (program) =>
      program.approved_email_domains.length > 0 &&
      domainAllowed(email, program.approved_email_domains),
  );
  return matching.length === 1 ? matching[0] : null;
}

/**
 * Joining as a resident, with nobody's permission.
 *
 * ## Why this is the default
 *
 * The product's whole value is that a resident who cannot work Saturday can do
 * something about it *now*. An account that signs in and reads "contact your
 * program administrator" has no way to do anything about Saturday, and the
 * administrator it names is a person who may be operating. Requiring a human
 * step between a resident downloading the app and using it meant, in practice,
 * that the first thing the product did was fail.
 *
 * So a new account is a **resident of the programme, confirmed**, from the
 * first sign-in. This was chosen deliberately by the product owner over two
 * narrower alternatives, and it is recorded under **Decisions** in
 * `docs/AI_PROJECT_STATE.md` with what it costs.
 *
 * ## What it costs, stated plainly
 *
 * A confirmed resident can read the whole programme's schedule, the switch
 * board, and the contact directory including phone numbers. With no approved
 * email domains configured, *any* Google account that reaches the sign-in page
 * gets that. This is not a side effect to be discovered later — it is the
 * trade the deployment has made, and the mitigation is one field.
 *
 * ## The one control that still binds
 *
 * `programs.approved_email_domains`. When an administrator has set it, an
 * address outside it is refused at sign-in — before this function runs, and on
 * every later sign-in too. Setting it turns the paragraph above off. It is
 * deliberately still honoured here: "no administrator has to assign a role" is
 * a statement about *roles*, not a licence to ignore a restriction somebody
 * went and configured on purpose.
 *
 * ## Why a resident record, and why held rows
 *
 * A role without a `residents` row is a resident who cannot post a shift, so
 * the two are created together or the account is no better off than pending.
 * Claiming held rows is what makes the first screen worth looking at: if the
 * programme imported a roster naming this person before they had an account,
 * their real shifts are waiting, and this is the moment they become theirs.
 */
async function attachAsResident(
  user: UserRow,
  program: ProgramRow,
  client: PoolClient,
): Promise<void> {
  let resident = await queryOne<{ id: string }>(
    "SELECT id FROM residents WHERE user_id = $1 AND program_id = $2",
    [user.id, program.id],
    client,
  );
  if (!resident) {
    /* PGY-1 and a graduation year three out are placeholders the resident can
       correct, and the scheduler can overwrite. A wrong-but-editable level
       lets somebody start; a missing one stops them. */
    resident = await queryOne<{ id: string }>(
      `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials)
       VALUES ($1, $2, $3, $4, '{}')
       RETURNING id`,
      [user.id, program.id, 1, new Date().getFullYear() + 3],
      client,
    );
  }

  await claimHeldRows(
    program.id,
    { id: resident!.id, name: user.full_name, email: user.email },
    client,
  );
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
      /**
       * An account that never got a role is adopted on sight.
       *
       * Without this, everybody who signed in before this change stays on the
       * "contact your program administrator" screen for ever — the fix would
       * apply only to people who had not tried yet, which is the wrong half.
       * It also covers an account an administrator created by email and never
       * finished configuring.
       *
       * Only a *missing* role is filled in. An account somebody deliberately
       * made a chief is not quietly demoted to resident by signing in.
       */
      const adopting = !existing.role;
      const target = adopting
        ? ((existing.program_id
            ? await queryOne<ProgramRow>(
                "SELECT * FROM programs WHERE id = $1",
                [existing.program_id],
                client,
              )
            : await programForNewMember(identity.email, client)) ?? null)
        : null;

      if (target && !domainAllowed(identity.email, target.approved_email_domains)) {
        await recordAudit(
          {
            programId: target.id,
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
          message: `Sign-in for ${identity.email} is not permitted for ${target.name}. Approved domains: ${target.approved_email_domains
            .map((d) => `@${d.replace(/^@/, "")}`)
            .join(", ")}.`,
        };
      }

      const updated = await queryOne<UserRow>(
        `UPDATE users
            SET auth_user_id = COALESCE(auth_user_id, $2),
                full_name    = CASE WHEN $3 <> '' THEN $3 ELSE full_name END,
                picture_url  = COALESCE($4, picture_url),
                role         = COALESCE(role, $5),
                program_id   = COALESCE(program_id, $6),
                last_login_at = now()
          WHERE id = $1
        RETURNING *`,
        [
          existing.id,
          identity.subject,
          identity.name,
          identity.picture,
          target ? "resident" : null,
          target?.id ?? null,
        ],
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
      // Record the provider identity so signing in again — or through another
      // provider with the same verified address — resolves to this same account.
      await linkIdentity(
        existing.id,
        { provider: "google", subject: identity.subject, email: identity.email },
        client,
      );
      if (target && updated?.role === "resident") {
        await attachAsResident(updated, target, client);
        await recordAudit(
          {
            programId: target.id,
            actorUserId: existing.id,
            actorLabel: identity.email,
            action: "user.updated",
            entityType: "user",
            entityId: existing.id,
            newState: { role: "resident", programId: target.id },
            reason: "self_enrolled_resident",
          },
          client,
        );
      }
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

    const program = await programForNewMember(identity.email, client);

    /* Checked before anything is written, so a refused address leaves no
       account behind. The same restriction is applied above to somebody who
       already belongs to the programme — a domain list that only bound on the
       way in would be a door that locks behind you. */
    if (program && !domainAllowed(identity.email, program.approved_email_domains)) {
      await recordAudit(
        {
          programId: program.id,
          actorUserId: null,
          actorLabel: identity.email,
          action: "auth.login_denied",
          entityType: "user",
          entityId: null,
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

    /* Bootstrap outranks self-enrolment: the first administrator of a fresh
       instance must not arrive as a resident, or nobody can configure the
       programme they just joined. */
    const role: UserRow["role"] = program ? (isBootstrap ? "admin" : "resident") : null;
    const programId = program?.id ?? null;

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
        reason: isBootstrap
          ? "bootstrap_admin"
          : role === "resident"
            ? "self_enrolled_resident"
            : "first_google_login",
      },
      client,
    );
    await linkIdentity(
      created!.id,
      { provider: "google", subject: identity.subject, email: identity.email },
      client,
    );
    if (program && role === "resident") {
      await attachAsResident(created as UserRow, program, client);
    }
    return { outcome: "ok" as const, user: created as UserRow };
  });
}
