import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import type { ProgramRow, ResidentRow, UserRow } from "@/server/db/types";
import { getOfferCandidates } from "@/server/domain/candidates";
import { acceptOffer, createOffer, getTradeRequestDetail } from "@/server/domain/trades";
import { listResidentSchedule } from "@/server/domain/schedule";
import {
  createInvitation,
  findUsableInvitation,
  listInvitations,
} from "@/server/domain/invitations";
import { checkDemoAllowed } from "../../scripts/demo/guard";
import { resetDemoProgram, seedDemoProgram, type SeedResult } from "../../scripts/demo/seed";
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_EXISTING_MEMBER_EMAIL,
  DEMO_PROGRAM_NAME,
} from "../../scripts/demo/plan";
import { closeDatabase, ensureMigrated, makeContext, resetDatabase } from "./helpers";

/**
 * The demo program has to be worth trusting: if the scenarios it advertises do
 * not actually behave as advertised, it is worse than having no demo at all,
 * because somebody will demonstrate the product with it.
 *
 * So every scenario is asserted here through the same domain functions the UI
 * calls — not by re-reading the plan and agreeing with itself.
 */

// A fixed anchor keeps the assertions about specific dates stable. It is a
// Monday, which is what `anchorMonday` always produces.
const ANCHOR = "2026-09-07";

let seeded: SeedResult;
let program: ProgramRow;

async function contextFor(key: string) {
  const user = (await queryOne<UserRow>(
    "SELECT * FROM users WHERE email = $1",
    [`demo.${key}@${DEMO_EMAIL_DOMAIN}`],
  ))!;
  const resident = await queryOne<ResidentRow>(
    "SELECT * FROM residents WHERE user_id = $1",
    [user.id],
  );
  return makeContext(program, user, resident);
}

beforeAll(async () => {
  ensureMigrated();
  await resetDatabase();
  seeded = await seedDemoProgram({ anchor: ANCHOR });
  program = (await queryOne<ProgramRow>("SELECT * FROM programs WHERE id = $1", [
    seeded.programId,
  ]))!;
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe("the safety interlock", () => {
  it("refuses production outright", () => {
    const result = checkDemoAllowed({
      DATABASE_URL: "postgres://user:pw@127.0.0.1:5432/shiftswitch_dev",
      NODE_ENV: "production",
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/production/i);
  });

  it("refuses a database that is not on this machine unless told explicitly", () => {
    const remote = {
      DATABASE_URL: "postgres://user:pw@db.example.com:5432/shiftswitch",
    };
    expect(checkDemoAllowed(remote).allowed).toBe(false);
    expect(
      checkDemoAllowed({ ...remote, ALLOW_REMOTE_DEMO_DATA: "true" }).allowed,
    ).toBe(true);
  });

  it("refuses a database whose name looks like production, even locally", () => {
    const result = checkDemoAllowed({
      DATABASE_URL: "postgres://user:pw@127.0.0.1:5432/shiftswitch_production",
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/looks like production/i);
  });

  it("refuses a production-looking APP_URL", () => {
    const result = checkDemoAllowed({
      DATABASE_URL: "postgres://user:pw@127.0.0.1:5432/shiftswitch_dev",
      APP_URL: "https://prod.shiftswitch.example",
    });
    expect(result.allowed).toBe(false);
  });

  it("refuses when there is no database at all", () => {
    expect(checkDemoAllowed({}).allowed).toBe(false);
  });
});

describe("what gets seeded", () => {
  it("creates the documented program, people and schedule", async () => {
    expect(program.name).toBe(DEMO_PROGRAM_NAME);
    expect(seeded.users).toBe(21);
    expect(seeded.residents).toBe(20);
    expect(seeded.shifts).toBeGreaterThan(300);

    const roles = await query<{ role: string; count: string }>(
      "SELECT role, count(*)::text AS count FROM users WHERE program_id = $1 GROUP BY role",
      [program.id],
    );
    const byRole = Object.fromEntries(roles.map((r) => [r.role, Number(r.count)]));
    expect(byRole.admin).toBe(1);
    expect(byRole.chief).toBe(2);
    expect(byRole.resident).toBe(18);
  });

  it("uses only addresses that can never reach a real person", async () => {
    const users = await query<{ email: string }>(
      "SELECT email FROM users WHERE program_id = $1",
      [program.id],
    );
    for (const user of users) {
      expect(user.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`)).toBe(true);
    }
    const contacts = await query<{ email: string }>(
      "SELECT email FROM program_contacts WHERE program_id = $1",
      [program.id],
    );
    for (const contact of contacts) {
      expect(contact.email.endsWith(".invalid")).toBe(true);
    }
  });

  it("gives nobody a sign-in identity", async () => {
    const withIdentity = await query<{ id: string }>(
      "SELECT id FROM users WHERE program_id = $1 AND auth_user_id IS NOT NULL",
      [program.id],
    );
    expect(withIdentity).toHaveLength(0);
  });

  it("configures rules the engine actually implements", async () => {
    const { RULE_HANDLERS_BY_TYPE } = await import("@/server/domain/rules/handlers");
    const rules = await query<{ rule_type: string }>(
      "SELECT rule_type FROM rules WHERE program_id = $1",
      [program.id],
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(
        RULE_HANDLERS_BY_TYPE.has(rule.rule_type),
        `${rule.rule_type} has no handler`,
      ).toBe(true);
    }
  });

  it("stores overnight and 24-hour shifts as single shifts", async () => {
    const nights = await query<{ hours: string }>(
      `SELECT EXTRACT(EPOCH FROM (s.end_datetime - s.start_datetime)) / 3600 AS hours
         FROM shifts s JOIN services v ON v.id = s.service_id
        WHERE s.program_id = $1 AND v.name = 'Demo Night Float'`,
      [program.id],
    );
    expect(nights.length).toBeGreaterThan(0);
    for (const night of nights) expect(Number(night.hours)).toBe(12);

    const calls = await query<{ hours: string; shift_type: string }>(
      `SELECT EXTRACT(EPOCH FROM (end_datetime - start_datetime)) / 3600 AS hours, shift_type
         FROM shifts WHERE program_id = $1 AND shift_type = 'call'`,
      [program.id],
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(Number(call.hours)).toBe(24);
  });

  it("puts weekday shifts on weekdays and the call shift on a Saturday", async () => {
    const calls = await query<{ dow: string }>(
      `SELECT EXTRACT(DOW FROM date) AS dow FROM shifts
        WHERE program_id = $1 AND shift_type = 'call'`,
      [program.id],
    );
    for (const call of calls) expect(Number(call.dow)).toBe(6); // Saturday

    const clinic = await query<{ dow: string }>(
      `SELECT EXTRACT(DOW FROM s.date) AS dow FROM shifts s
         JOIN services v ON v.id = s.service_id
        WHERE s.program_id = $1 AND v.name = 'Demo Clinic'`,
      [program.id],
    );
    expect(clinic.length).toBeGreaterThan(0);
    for (const session of clinic) {
      expect([2, 3, 4]).toContain(Number(session.dow)); // Tue, Wed, Thu
    }
  });

  it("gives residents genuinely different schedules", async () => {
    const counts = await query<{ resident_id: string; count: string }>(
      `SELECT sa.resident_id, count(*)::text AS count
         FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
        WHERE s.program_id = $1 GROUP BY sa.resident_id`,
      [program.id],
    );
    expect(counts.length).toBe(20);
    const distinct = new Set(counts.map((c) => c.count));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("posts shifts that are open for anyone to offer on", async () => {
    const posted = await query<{ id: string }>(
      "SELECT id FROM trade_requests WHERE program_id = $1 AND status = 'open'",
      [program.id],
    );
    // A lower bound, not an exact count. The exact number is a function of how
    // many scenarios exist and which of them have live offers against them, and
    // pinning it means every new scenario breaks this test for no reason. What
    // matters is that somebody signing in as any resident finds a board with
    // several things on it.
    expect(posted.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * The demo exists so that every state of a trade can be seen without anybody
   * making one. These four are the states with no other way to reach them — you
   * cannot look at a completed switch until somebody completes one — so if the
   * seed stops producing any of them, the demo silently stops demonstrating the
   * product and the only symptom is empty screens.
   */
  it("leaves a trade sitting in every lifecycle state", async () => {
    const [state] = await query<{
      live_offers: string;
      awaiting_approval: string;
      completed: string;
      declined: string;
    }>(
      `SELECT (SELECT count(*) FROM trade_offers o
                 JOIN trade_requests r ON r.id = o.trade_request_id
                WHERE r.program_id = $1 AND o.status = 'pending')::text   AS live_offers,
              (SELECT count(*) FROM trade_requests
                WHERE program_id = $1 AND status = 'pending_approval')::text
                                                                          AS awaiting_approval,
              (SELECT count(*) FROM completed_trades WHERE program_id = $1)::text
                                                                          AS completed,
              (SELECT count(*) FROM trade_offers o
                 JOIN trade_requests r ON r.id = o.trade_request_id
                WHERE r.program_id = $1 AND o.status = 'rejected')::text  AS declined`,
      [program.id],
    );
    expect(Number(state.live_offers), "an offer waiting on a decision").toBeGreaterThan(0);
    expect(Number(state.awaiting_approval), "a switch waiting on a chief").toBeGreaterThan(0);
    expect(Number(state.completed), "a switch that completed").toBeGreaterThan(0);
    expect(Number(state.declined), "an offer that was declined").toBeGreaterThan(0);
  });

  it("produces notifications residents can actually open", async () => {
    const rows = await query<{ type: string; route: string; title: string }>(
      `SELECT n.type, n.route, n.title FROM notifications n
         JOIN users u ON u.id = n.recipient_user_id
        WHERE u.program_id = $1`,
      [program.id],
    );
    expect(rows.length).toBeGreaterThan(0);

    // Every notification leads somewhere specific. The dead end this replaced
    // sent a resident to the board of everyone else's postings.
    for (const row of rows) {
      expect(row.route, `${row.type} has no route`).not.toBe("");
      expect(row.route.startsWith("/"), `${row.type} route "${row.route}"`).toBe(true);
      expect(row.route, `${row.type} leads nowhere in particular`).not.toBe(
        "/notifications",
      );
    }

    // The states an evaluator is looking for are represented.
    const types = new Set(rows.map((row) => row.type));
    expect(types).toContain("offer.created");
    expect(types).toContain("offer.rejected");
    expect(types).toContain("switch.completed");
  });

  it("names the shift in a decline, not just the reason", async () => {
    const [declined] = await query<{ body: string }>(
      `SELECT n.body FROM notifications n
         JOIN users u ON u.id = n.recipient_user_id
        WHERE u.program_id = $1 AND n.type = 'offer.rejected'`,
      [program.id],
    );
    expect(declined).toBeDefined();
    // A resident with two offers out has to be able to tell which one this is.
    expect(declined.body).toMatch(/Your offer for /);
    expect(declined.body).toContain("Demo");
  });

  it("seeds a schedule that does not already break the program's own rules", async () => {
    // A baseline that violates max_consecutive_shifts makes every candidate in
    // the demo ineligible for a reason unrelated to the trade being shown.
    const runs = await query<{ email: string; longest: string }>(
      `WITH days AS (
         SELECT DISTINCT u.email, s.date
           FROM shifts s
           JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
           JOIN residents r ON r.id = sa.resident_id
           JOIN users u ON u.id = r.user_id
          WHERE s.program_id = $1
       ), grouped AS (
         SELECT email, date,
                date - (row_number() OVER (PARTITION BY email ORDER BY date))::int AS grp
           FROM days
       )
       SELECT email, max(run)::text AS longest FROM (
         SELECT email, grp, count(*) AS run FROM grouped GROUP BY email, grp
       ) t GROUP BY email`,
      [program.id],
    );
    expect(runs.length).toBeGreaterThan(0);
    for (const row of runs) {
      expect(Number(row.longest), `${row.email} works too many days in a row`).toBeLessThanOrEqual(6);
    }
  });
});

describe("scenario: a valid two-person swap", () => {
  it("offers, validates and completes", async () => {
    const rivera = await contextFor("rivera");
    const okonkwo = await contextFor("okonkwo");
    const request = (await queryOne<{ id: string }>(
      "SELECT id FROM trade_requests WHERE source_shift_id = $1",
      [seeded.shiftRefs["sc-valid-source"]],
    ))!;

    const { candidates } = await getOfferCandidates(okonkwo, request.id);
    const candidate = candidates.find(
      (entry) => entry.shift.id === seeded.shiftRefs["sc-valid-offer"],
    );
    expect(candidate, "Okonkwo's scenario shift should be offerable").toBeDefined();
    expect(candidate!.eligible).toBe(true);
    expect(candidate!.blockingReason).toBeNull();

    const offer = await createOffer(okonkwo, {
      tradeRequestId: request.id,
      offeredShiftId: seeded.shiftRefs["sc-valid-offer"],
    });
    const accepted = await acceptOffer(rivera, offer.offer.id);
    expect(accepted.status).toBe("completed");

    // Both schedules moved, in the same transaction.
    const riveraShifts = await listResidentSchedule(rivera.resident.id, {
      includePast: true,
    });
    const okonkwoShifts = await listResidentSchedule(okonkwo.resident.id, {
      includePast: true,
    });
    expect(riveraShifts.map((s) => s.id)).toContain(seeded.shiftRefs["sc-valid-offer"]);
    expect(riveraShifts.map((s) => s.id)).not.toContain(
      seeded.shiftRefs["sc-valid-source"],
    );
    expect(okonkwoShifts.map((s) => s.id)).toContain(seeded.shiftRefs["sc-valid-source"]);

    const detail = await getTradeRequestDetail(request.id, program.id);
    expect(detail!.status).toBe("completed");
  });
});

describe("scenario: an invalid swap", () => {
  it("is refused, with the reason attached to the candidate", async () => {
    const abiodun = await contextFor("abiodun");
    const request = (await queryOne<{ id: string }>(
      "SELECT id FROM trade_requests WHERE source_shift_id = $1",
      [seeded.shiftRefs["sc-invalid-source"]],
    ))!;

    const { candidates } = await getOfferCandidates(abiodun, request.id);
    const candidate = candidates.find(
      (entry) => entry.shift.id === seeded.shiftRefs["sc-invalid-offer"],
    );
    expect(candidate).toBeDefined();
    expect(candidate!.eligible).toBe(false);
    expect(candidate!.blockingReason).toMatch(/pgy/i);
  });
});

describe("scenario: no available match", () => {
  it("leaves the resident with nothing they are allowed to offer", async () => {
    const varga = await contextFor("varga");
    const request = (await queryOne<{ id: string }>(
      "SELECT id FROM trade_requests WHERE source_shift_id = $1",
      [seeded.shiftRefs["sc-nomatch-source"]],
    ))!;

    const { candidates } = await getOfferCandidates(varga, request.id);
    expect(candidates).toHaveLength(0);

    // …because every shift she holds is on a service the program does not allow
    // to be traded, which is the realistic reason for this state.
    const hers = await query<{ name: string; tradeable: boolean }>(
      `SELECT v.name, s.tradeable FROM shifts s
         JOIN services v ON v.id = s.service_id
         JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
        WHERE sa.resident_id = $1`,
      [varga.resident.id],
    );
    expect(hers.length).toBeGreaterThan(0);
    for (const shift of hers) {
      expect(shift.name).toBe("Demo Clinic");
      expect(shift.tradeable).toBe(false);
    }
  });
});

describe("scenario: a conflicting schedule", () => {
  it("blocks the offer because the resident is already working that morning", async () => {
    const sorensen = await contextFor("sorensen");
    const request = (await queryOne<{ id: string }>(
      "SELECT id FROM trade_requests WHERE source_shift_id = $1",
      [seeded.shiftRefs["sc-overlap-source"]],
    ))!;

    const { candidates } = await getOfferCandidates(sorensen, request.id);
    const candidate = candidates.find(
      (entry) => entry.shift.id === seeded.shiftRefs["sc-overlap-offer"],
    );
    expect(candidate).toBeDefined();
    expect(candidate!.eligible).toBe(false);
    expect(candidate!.blockingReason).not.toBeNull();

    const overlapCheck = candidate!.validation!.checks.find(
      (check) => check.ruleType === "no_overlapping_shifts",
    );
    expect(overlapCheck?.status).toBe("fail");

    // Creating the offer anyway is refused by the server, not just by the UI.
    await expect(
      createOffer(sorensen, {
        tradeRequestId: request.id,
        offeredShiftId: seeded.shiftRefs["sc-overlap-offer"],
      }),
    ).rejects.toMatchObject({ code: "rule_violation" });
  });
});

describe("scenario: invitations", () => {
  it("seeds one pending, one expired and one revoked", async () => {
    const invitations = await listInvitations(program.id);
    const byStatus = invitations.reduce<Record<string, number>>((acc, invitation) => {
      acc[invitation.status] = (acc[invitation.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStatus.pending).toBe(1);
    expect(byStatus.expired).toBe(1);
    expect(byStatus.revoked).toBe(1);
  });

  it("refuses to invite somebody who is already a member", async () => {
    const admin = await contextFor("admin");
    await expect(
      createInvitation(admin, { email: DEMO_EXISTING_MEMBER_EMAIL, role: "resident" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("supersedes rather than duplicating when the same address is invited twice", async () => {
    const admin = await contextFor("admin");
    const first = await createInvitation(admin, {
      email: `demo.twice@${DEMO_EMAIL_DOMAIN}`,
      role: "resident",
    });
    const second = await createInvitation(admin, {
      email: `demo.twice@${DEMO_EMAIL_DOMAIN}`,
      role: "resident",
    });

    // The old link stops working; exactly one is live.
    expect(await findUsableInvitation(first.token)).toBeNull();
    expect(await findUsableInvitation(second.token)).not.toBeNull();

    const live = (await listInvitations(program.id)).filter(
      (invitation) =>
        invitation.email === `demo.twice@${DEMO_EMAIL_DOMAIN}` &&
        invitation.status === "pending",
    );
    expect(live).toHaveLength(1);
  });
});

describe("seeding again", () => {
  it("is idempotent and deterministic — same anchor, same program", async () => {
    const before = await query<{ signature: string }>(
      `SELECT u.email || '|' || s.date || '|' || s.start_datetime || '|' || v.name AS signature
         FROM shifts s
         JOIN services v ON v.id = s.service_id
         JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
         JOIN residents r ON r.id = sa.resident_id
         JOIN users u ON u.id = r.user_id
        WHERE s.program_id = $1 ORDER BY signature`,
      [program.id],
    );

    // Re-seeding after a completed switch also proves the reset can get past
    // the ON DELETE RESTRICT from completed_trades.
    const again = await seedDemoProgram({ anchor: ANCHOR });
    expect(again.shifts).toBe(seeded.shifts);
    expect(again.users).toBe(seeded.users);

    const after = await query<{ signature: string }>(
      `SELECT u.email || '|' || s.date || '|' || s.start_datetime || '|' || v.name AS signature
         FROM shifts s
         JOIN services v ON v.id = s.service_id
         JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
         JOIN residents r ON r.id = sa.resident_id
         JOIN users u ON u.id = r.user_id
        WHERE s.program_id = $1 ORDER BY signature`,
      [again.programId],
    );

    // The valid-swap scenario moved two shifts between the two people before
    // the re-seed, so `before` is *not* the pristine plan. The rebuilt program
    // must match the plan, which is the point: re-seeding repairs whatever the
    // demo was left in, rather than layering on top of it.
    expect(after).toHaveLength(again.shifts);
    expect(after.map((row) => row.signature)).toEqual(
      [...after.map((row) => row.signature)].sort(),
    );
    expect(new Set(after.map((row) => row.signature)).size).toBe(after.length);

    const movedBack = after.filter((row) =>
      row.signature.startsWith(`demo.rivera@${DEMO_EMAIL_DOMAIN}|`),
    );
    const movedBackBefore = before.filter((row) =>
      row.signature.startsWith(`demo.rivera@${DEMO_EMAIL_DOMAIN}|`),
    );
    expect(movedBack.map((r) => r.signature)).not.toEqual(
      movedBackBefore.map((r) => r.signature),
    );

    // Exactly one program, one set of users — nothing duplicated.
    const programs = await query<{ id: string }>(
      "SELECT id FROM programs WHERE name = $1",
      [DEMO_PROGRAM_NAME],
    );
    expect(programs).toHaveLength(1);
    const users = await query<{ email: string }>(
      "SELECT email FROM users WHERE program_id = $1",
      [again.programId],
    );
    expect(new Set(users.map((u) => u.email)).size).toBe(users.length);

    program = (await queryOne<ProgramRow>("SELECT * FROM programs WHERE id = $1", [
      again.programId,
    ]))!;
    seeded = again;
  }, 120_000);

  it("removes everything on reset, and says so when there is nothing to remove", async () => {
    expect(await resetDemoProgram()).toBe(true);

    for (const table of [
      "programs",
      "users",
      "shifts",
      "trade_requests",
      "invitations",
    ] as const) {
      const rows = await query<{ id: string }>(`SELECT id FROM ${table}`);
      expect(rows, `${table} should be empty`).toHaveLength(0);
    }

    expect(await resetDemoProgram()).toBe(false);
  }, 120_000);

  it("produces byte-identical data from the same anchor, twice from nothing", async () => {
    const first = await seedDemoProgram({ anchor: ANCHOR });
    const firstRows = await signatures(first.programId);
    await resetDemoProgram();

    const second = await seedDemoProgram({ anchor: ANCHOR });
    const secondRows = await signatures(second.programId);

    expect(secondRows).toEqual(firstRows);
    expect(second.shifts).toBe(first.shifts);
    expect(Object.keys(second.shiftRefs).sort()).toEqual(
      Object.keys(first.shiftRefs).sort(),
    );

    await resetDemoProgram();
  }, 180_000);
});

async function signatures(programId: string): Promise<string[]> {
  const rows = await query<{ signature: string }>(
    `SELECT u.email || '|' || s.date || '|' || s.start_datetime || '|' || s.end_datetime
              || '|' || v.name || '|' || s.shift_type || '|' || s.required_pgy_min
              || '|' || s.required_pgy_max || '|' || s.tradeable AS signature
       FROM shifts s
       JOIN services v ON v.id = s.service_id
       JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
       JOIN residents r ON r.id = sa.resident_id
       JOIN users u ON u.id = r.user_id
      WHERE s.program_id = $1 ORDER BY signature`,
    [programId],
  );
  return rows.map((row) => row.signature);
}
