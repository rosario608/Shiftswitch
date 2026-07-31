import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import { updateManagedUser } from "@/server/domain/admin";
import { createService, listServices, updateService } from "@/server/domain/services";
import {
  createInvitation,
  findUsableInvitation,
  listInvitations,
  revokeInvitation,
} from "@/server/domain/invitations";
import {
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  resetDatabase,
} from "./helpers";

/**
 * What happens when somebody double-taps, the network retries, or two people
 * act at once.
 *
 * The standard the product is held to: no operation may leave the database in
 * an ambiguous or half-finished state, and repeating a request must never
 * quietly produce two of something.
 */

let program: Awaited<ReturnType<typeof createProgram>>;
let admin: Awaited<ReturnType<typeof createStaff>>;
let pd: Awaited<ReturnType<typeof createStaff>>;
let resident: Awaited<ReturnType<typeof createResident>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  program = await createProgram({ name: "Idempotency" });
  admin = await createStaff(program.program, {
    email: "admin@hospital.org",
    role: "admin",
  });
  pd = await createStaff(program.program, { email: "pd@hospital.org", role: "pd" });
  resident = await createResident(program.program, { email: "resident@hospital.org" });
});

describe("inviting the same person twice", () => {
  it("leaves exactly one live invitation, however fast the second request is", async () => {
    // Two simultaneous creates for the same address: the double-tap.
    const [first, second] = await Promise.all([
      createInvitation(admin.context, { email: "newcomer@hospital.org", role: "resident" }),
      createInvitation(admin.context, { email: "newcomer@hospital.org", role: "resident" }),
    ]);

    const live = (await listInvitations(program.program.id)).filter(
      (invitation) => invitation.status === "pending",
    );
    expect(live, "a partial unique index guarantees at most one live invitation").toHaveLength(
      1,
    );

    // Whichever won, exactly one token works and the other is dead.
    const usable = [first, second].filter(
      async (created) => (await findUsableInvitation(created.token)) !== null,
    );
    expect(usable.length).toBeGreaterThan(0);
    const results = await Promise.all([
      findUsableInvitation(first.token),
      findUsableInvitation(second.token),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("is safe to repeat sequentially, superseding rather than duplicating", async () => {
    const tokens: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const created = await createInvitation(admin.context, {
        email: "retried@hospital.org",
        role: "resident",
      });
      tokens.push(created.token);
    }

    const rows = await query<{ id: string }>(
      "SELECT id FROM invitations WHERE lower(email) = 'retried@hospital.org'",
    );
    expect(rows, "each attempt is recorded, so the history is not lost").toHaveLength(4);

    const live = (await listInvitations(program.program.id)).filter(
      (invitation) =>
        invitation.email === "retried@hospital.org" && invitation.status === "pending",
    );
    expect(live).toHaveLength(1);

    // Only the newest link works.
    const usable = await Promise.all(tokens.map((token) => findUsableInvitation(token)));
    expect(usable.filter(Boolean)).toHaveLength(1);
    expect(await findUsableInvitation(tokens[tokens.length - 1])).not.toBeNull();
  });

  it("refuses an address that already belongs to a member, every time", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        createInvitation(admin.context, {
          email: "resident@hospital.org",
          role: "resident",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    }
    const rows = await query<{ id: string }>("SELECT id FROM invitations");
    expect(rows, "a refused invitation writes nothing").toHaveLength(0);
  });

  it("revoking twice is not an error and does not double-write", async () => {
    const created = await createInvitation(admin.context, {
      email: "cancelled@hospital.org",
      role: "resident",
    });
    await revokeInvitation(admin.context, created.invitation.id);
    await revokeInvitation(admin.context, created.invitation.id);

    const audit = await query<{ id: string }>(
      "SELECT id FROM audit_logs WHERE action = 'invitation.revoked' AND entity_id = $1",
      [created.invitation.id],
    );
    expect(audit, "the second revoke is a no-op, not a second audit entry").toHaveLength(1);
    expect(await findUsableInvitation(created.token)).toBeNull();
  });
});

describe("creating the same service twice", () => {
  it("cannot produce two, even from simultaneous requests", async () => {
    const attempts = await Promise.allSettled([
      createService(admin.context, "service", { name: "Hospitalist" }),
      createService(admin.context, "service", { name: "Hospitalist" }),
      createService(admin.context, "service", { name: "HOSPITALIST" }),
    ]);
    const created = attempts.filter((a) => a.status === "fulfilled");
    expect(created).toHaveLength(1);

    // The losers get a readable conflict naming the service, not a database
    // constraint name leaking through.
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        expect(attempt.reason).toMatchObject({ code: "conflict" });
        expect(String(attempt.reason.message)).toMatch(/already has a service called/i);
      }
    }

    const services = await listServices(program.program.id, "service");
    expect(services.filter((s) => /hospitalist/i.test(s.name))).toHaveLength(1);
  });

  it("survives a double-tap on rename without losing the name", async () => {
    const service = await createService(admin.context, "service", { name: "Wards" });
    const results = await Promise.allSettled([
      updateService(admin.context, "service", service.id, { name: "General Wards" }),
      updateService(admin.context, "service", service.id, { name: "General Wards" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const services = await listServices(program.program.id, "service");
    const renamed = services.filter((s) => s.name === "General Wards");
    expect(renamed).toHaveLength(1);
    expect(renamed[0].id).toBe(service.id);
  });

  it("deactivating twice settles on inactive rather than oscillating", async () => {
    const service = await createService(admin.context, "service", { name: "Retired" });
    await updateService(admin.context, "service", service.id, { active: false });
    await updateService(admin.context, "service", service.id, { active: false });
    const services = await listServices(program.program.id, "service");
    expect(services.find((s) => s.id === service.id)!.active).toBe(false);
  });
});

describe("changing a role twice", () => {
  it("is idempotent and leaves one resident record, not two", async () => {
    await updateManagedUser(admin.context, resident.user.id, { role: "chief" });
    await updateManagedUser(admin.context, resident.user.id, { role: "chief" });

    const records = await query<{ id: string }>(
      "SELECT id FROM residents WHERE user_id = $1",
      [resident.user.id],
    );
    expect(records).toHaveLength(1);

    const row = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = $1", [
      resident.user.id,
    ]);
    expect(row!.role).toBe("chief");
  });

  it("resolves two simultaneous role changes to one of them, not a mixture", async () => {
    await Promise.allSettled([
      updateManagedUser(admin.context, resident.user.id, { role: "chief" }),
      updateManagedUser(pd.context, resident.user.id, { role: "apd" }),
    ]);

    const row = await queryOne<{ role: string }>("SELECT role FROM users WHERE id = $1", [
      resident.user.id,
    ]);
    expect(["chief", "apd"]).toContain(row!.role);

    // Whatever won, the resident record is consistent with it: chief holds a
    // schedule, APD does not require one.
    const records = await query<{ id: string }>(
      "SELECT id FROM residents WHERE user_id = $1",
      [resident.user.id],
    );
    expect(records.length).toBeLessThanOrEqual(1);
  });
});

describe("history survives the people in it", () => {
  it("keeps audit entries after the actor is deactivated", async () => {
    const service = await createService(pd.context, "service", { name: "Legacy" });
    await updateManagedUser(admin.context, pd.user.id, { active: false });

    const audit = await queryOne<{ actor_label: string; actor_user_id: string | null }>(
      "SELECT actor_label, actor_user_id FROM audit_logs WHERE entity_id = $1",
      [service.id],
    );
    // The entry survives, and still names who did it — the label is captured at
    // write time rather than joined at read time, so it cannot be erased by a
    // later change to the account.
    expect(audit).not.toBeNull();
    expect(audit!.actor_label).toBe("pd@hospital.org");
  });

  it("keeps a deactivated resident's shift assignments intact", async () => {
    const { createShift } = await import("@/server/domain/admin");
    const shift = await createShift(admin.context, {
      serviceId: program.services.MICU.id,
      date: "2027-01-15",
      startTime: "07:00",
      endTime: "19:00",
      endsNextDay: false,
      location: "",
      shiftType: "day",
      requiredPgyMin: 1,
      requiredPgyMax: 10,
      tradeable: true,
      approvalRequired: false,
      residentId: resident.resident.id,
    });

    await updateManagedUser(admin.context, resident.user.id, { active: false });

    const assignment = await queryOne<{ resident_id: string; assignment_status: string }>(
      "SELECT resident_id, assignment_status FROM shift_assignments WHERE shift_id = $1",
      [shift.id],
    );
    expect(assignment, "the schedule must not develop a hole").not.toBeNull();
    expect(assignment!.resident_id).toBe(resident.resident.id);
    expect(assignment!.assignment_status).toBe("active");
  });
});
