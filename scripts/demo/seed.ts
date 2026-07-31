import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { ProgramRow, ResidentRow, UserRow } from "@/server/db/types";
import type { AuthedContext } from "@/server/auth/guards";
import { zonedWallTimeToInstant } from "@/server/domain/time";
import { postShiftForTrade } from "@/server/domain/trades";
import { createInvitation, revokeInvitation } from "@/server/domain/invitations";
import {
  anchorMonday,
  buildDemoPlan,
  DEMO_INSTITUTION,
  DEMO_PEOPLE,
  DEMO_PROGRAM_NAME,
  DEMO_ROTATIONS,
  DEMO_RULES,
  DEMO_SERVICES,
  DEMO_TIMEZONE,
} from "./plan";
import { assertDemoAllowed } from "./guard";

/**
 * Seeding and removing the demo program.
 *
 * Idempotence is achieved the blunt way: a seed removes the demo program
 * entirely and rebuilds it. That is deliberate. A merge-style seeder has to
 * decide what to do about a shift somebody edited, an offer somebody made, or a
 * resident somebody deactivated — and every answer to that is a source of
 * "the demo is in a weird state" bugs. Rebuilding means the demo is either
 * exactly as designed or absent, with nothing in between.
 *
 * Every statement that deletes anything is scoped by the demo program's name or
 * id. Nothing here can reach another program's rows.
 */

export interface SeedResult {
  programId: string;
  anchor: string;
  users: number;
  residents: number;
  services: number;
  rotations: number;
  shifts: number;
  posts: number;
  invitations: number;
  /** Plan ref -> shift id, so tests and tooling can address one exact shift. */
  shiftRefs: Record<string, string>;
}

async function findDemoProgram(): Promise<ProgramRow | null> {
  return queryOne<ProgramRow>("SELECT * FROM programs WHERE name = $1", [
    DEMO_PROGRAM_NAME,
  ]);
}

/**
 * Removes the demo program and everything hanging off it.
 *
 * The order matters and is not the obvious one. Three foreign keys refuse to
 * get out of the way on their own:
 *
 *   - `completed_trades` and `trade_legs` reference `shifts` with ON DELETE
 *     RESTRICT, so a demo in which somebody completed a switch cannot have its
 *     shifts removed until those are gone;
 *   - `shift_assignments` references `residents` with ON DELETE RESTRICT, so
 *     the shifts have to go before the people do;
 *   - `users.program_id` is ON DELETE SET NULL, and a user with a role and no
 *     program violates a check constraint — so users are removed before the
 *     program, not left to be nulled by it.
 *
 * Which gives: trades, then shifts, then people, then the program. Everything
 * else (`services`, `rotations`, `rules`, `program_contacts`, `sessions`,
 * `email_records`) cascades from one of those four.
 */
export async function resetDemoProgram(): Promise<boolean> {
  assertDemoAllowed();
  const program = await findDemoProgram();
  if (!program) return false;

  await withTransaction(async (client) => {
    const scoped = [program.id];

    // 1. Trade history, which holds shifts hostage.
    await query(
      `DELETE FROM trade_legs
        WHERE completed_trade_id IN (SELECT id FROM completed_trades WHERE program_id = $1)`,
      scoped,
      client,
    );
    await query("DELETE FROM completed_trades WHERE program_id = $1", scoped, client);
    await query(
      `DELETE FROM trade_offers
        WHERE trade_request_id IN (SELECT id FROM trade_requests WHERE program_id = $1)`,
      scoped,
      client,
    );
    await query("DELETE FROM trade_requests WHERE program_id = $1", scoped, client);

    // 2. Everything else that points at a user or the program directly.
    await query("DELETE FROM audit_logs WHERE program_id = $1", scoped, client);
    await query(
      `DELETE FROM notifications
        WHERE recipient_user_id IN (SELECT id FROM users WHERE program_id = $1)`,
      scoped,
      client,
    );
    await query("DELETE FROM invitations WHERE program_id = $1", scoped, client);

    // 3. Shifts — cascading their assignments, which is what frees the
    //    residents to be deleted at all.
    await query("DELETE FROM shifts WHERE program_id = $1", scoped, client);

    // 4. People, then the program itself.
    await query("DELETE FROM users WHERE program_id = $1", scoped, client);
    await query("DELETE FROM programs WHERE id = $1", scoped, client);
  });

  return true;
}

export async function seedDemoProgram(
  options: { anchor?: string; now?: Date } = {},
): Promise<SeedResult> {
  assertDemoAllowed();

  const anchor = options.anchor ?? anchorMonday(options.now ?? new Date());
  const plan = buildDemoPlan(anchor);

  await resetDemoProgram();

  const program = (await queryOne<ProgramRow>(
    `INSERT INTO programs (name, institution, timezone, approved_email_domains,
                           default_trade_approval_required)
     VALUES ($1, $2, $3, '{}', false)
     RETURNING *`,
    [DEMO_PROGRAM_NAME, DEMO_INSTITUTION, DEMO_TIMEZONE],
  ))!;

  const services = new Map<string, string>();
  for (const service of DEMO_SERVICES) {
    const row = (await queryOne<{ id: string }>(
      `INSERT INTO services (program_id, name, tradeable, active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [program.id, service.name, service.tradeable],
    ))!;
    services.set(service.name, row.id);
  }

  const rotations = new Map<string, string>();
  for (const name of DEMO_ROTATIONS) {
    const row = (await queryOne<{ id: string }>(
      "INSERT INTO rotations (program_id, name) VALUES ($1, $2) RETURNING id",
      [program.id, name],
    ))!;
    rotations.set(name, row.id);
  }

  // `rules.rule_type` is plain text with no foreign key: a wrong identifier
  // inserts happily and is then never evaluated, leaving a program that looks
  // governed and is not. Fail loudly instead.
  const { RULE_HANDLERS_BY_TYPE } = await import("@/server/domain/rules/handlers");
  for (const rule of DEMO_RULES) {
    if (!RULE_HANDLERS_BY_TYPE.has(rule.type)) {
      throw new Error(`No rule handler is registered for "${rule.type}".`);
    }
    await query(
      `INSERT INTO rules (program_id, rule_type, name, params)
       VALUES ($1, $2, $2, $3::jsonb)`,
      [program.id, rule.type, JSON.stringify(rule.params)],
    );
  }

  await query(
    `INSERT INTO program_contacts (program_id, name, email, contact_type, notify_role, active)
     VALUES ($1, 'Demo Coordinator', 'coordinator@demo.invalid', 'program_coordinator', 'to', true),
            ($1, 'Demo Chief', 'chiefs@demo.invalid', 'chief_resident', 'cc', true)`,
    [program.id],
  );

  const users = new Map<string, UserRow>();
  const residents = new Map<string, ResidentRow>();
  for (const entry of DEMO_PEOPLE) {
    // No `auth_user_id`: none of these accounts has a sign-in identity, so
    // nobody can authenticate as one through Google. In a development
    // environment with ALLOW_TEST_LOGIN the test-login endpoint will attach to
    // them, which is the whole point of having them.
    const user = (await queryOne<UserRow>(
      `INSERT INTO users (email, full_name, role, program_id, active)
       VALUES ($1, $2, $3, $4, true) RETURNING *`,
      [entry.email, entry.fullName, entry.role, program.id],
    ))!;
    users.set(entry.key, user);

    if (entry.pgy !== null) {
      const resident = (await queryOne<ResidentRow>(
        `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials, active)
         VALUES ($1, $2, $3, $4, '{BLS,ACLS}', true) RETURNING *`,
        [user.id, program.id, entry.pgy, 2027 + (4 - entry.pgy)],
      ))!;
      residents.set(entry.key, resident);
    }
  }

  const shiftIdByRef = new Map<string, string>();
  for (const planned of plan.shifts) {
    const start = zonedWallTimeToInstant(planned.date, planned.startTime, DEMO_TIMEZONE);
    const endDate = planned.endsNextDay
      ? new Date(new Date(`${planned.date}T00:00:00Z`).getTime() + 86_400_000)
          .toISOString()
          .slice(0, 10)
      : planned.date;
    const end = zonedWallTimeToInstant(endDate, planned.endTime, DEMO_TIMEZONE);

    const shift = (await queryOne<{ id: string }>(
      `INSERT INTO shifts (program_id, service_id, rotation_id, date, start_datetime,
                           end_datetime, location, shift_type, required_pgy_min,
                           required_pgy_max, tradeable, approval_required, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'scheduled')
       RETURNING id`,
      [
        program.id,
        services.get(planned.service),
        rotations.get(planned.rotation) ?? null,
        planned.date,
        start,
        end,
        planned.location,
        planned.shiftType,
        planned.requiredPgyMin,
        planned.requiredPgyMax,
        planned.tradeable,
        planned.approvalRequired,
      ],
    ))!;
    shiftIdByRef.set(planned.ref, shift.id);

    await query(
      `INSERT INTO shift_assignments (shift_id, resident_id, assignment_status)
       VALUES ($1, $2, 'active')`,
      [shift.id, residents.get(planned.residentKey)!.id],
    );
  }

  // Posting goes through the real domain function rather than an INSERT, so the
  // demo contains exactly the state a resident tapping "post" would produce —
  // including the shift status transition and the audit entry.
  let posts = 0;
  for (const post of plan.posts) {
    const planned = plan.shifts.find((shift) => shift.ref === post.ref)!;
    await postShiftForTrade(contextFor(program, users, residents, planned.residentKey), {
      shiftId: shiftIdByRef.get(post.ref)!,
      notes: post.notes,
    });
    posts += 1;
  }

  // Invitations likewise: created through `createInvitation`, so the tokens are
  // real, hashed and expiring exactly as a live one would be.
  const adminContext = contextFor(program, users, residents, "admin");
  let invitations = 0;
  for (const invitation of plan.invitations) {
    const created = await createInvitation(adminContext, {
      email: invitation.email,
      role: invitation.role,
      pgyLevel: invitation.pgy,
      expiresInDays: invitation.expiresInDays,
    });
    if (invitation.revoked) {
      await revokeInvitation(adminContext, created.invitation.id);
    }
    invitations += 1;
  }

  return {
    programId: program.id,
    anchor,
    users: users.size,
    residents: residents.size,
    services: services.size,
    rotations: rotations.size,
    shifts: plan.shifts.length,
    posts,
    invitations,
    shiftRefs: Object.fromEntries(shiftIdByRef),
  };
}

/**
 * The context the domain functions expect. The demo has no HTTP request and no
 * session, so this is assembled directly — but from the rows that were actually
 * written, so authorization behaves exactly as it would for a signed-in person.
 */
function contextFor(
  program: ProgramRow,
  users: Map<string, UserRow>,
  residents: Map<string, ResidentRow>,
  key: string,
): AuthedContext & { resident: ResidentRow } {
  const user = users.get(key)!;
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      pictureUrl: null,
      role: user.role!,
      programId: program.id,
      active: user.active,
    },
    program,
    resident: residents.get(key) ?? null,
    sessionId: "demo-seed",
  } as AuthedContext & { resident: ResidentRow };
}

export { DEMO_PROGRAM_NAME };
