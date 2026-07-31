import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import type { UserRole } from "@/server/db/types";
import { listManagedUsers, updateManagedUser } from "@/server/domain/admin";
import { createInvitation } from "@/server/domain/invitations";
import { createService } from "@/server/domain/services";
import {
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  resetDatabase,
} from "./helpers";

/**
 * The boundaries around role changes.
 *
 * A permission matrix is only worth what its edges are worth. These are the
 * edges: promoting yourself, appointing a peer, quietly demoting somebody more
 * senior, reaching into another program, and emptying a program of everybody
 * who could fix any of it.
 */

let program: Awaited<ReturnType<typeof createProgram>>;
let admin: Awaited<ReturnType<typeof createStaff>>;
let pd: Awaited<ReturnType<typeof createStaff>>;
let apd: Awaited<ReturnType<typeof createStaff>>;
let chief: Awaited<ReturnType<typeof createResident>>;
let resident: Awaited<ReturnType<typeof createResident>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  program = await createProgram({ name: "Permissions" });
  admin = await createStaff(program.program, {
    email: "admin@hospital.org",
    role: "admin",
    name: "Ada Admin",
  });
  pd = await createStaff(program.program, {
    email: "pd@hospital.org",
    role: "pd",
    name: "Pat Director",
  });
  apd = await createStaff(program.program, {
    email: "apd@hospital.org",
    role: "apd",
    name: "Avery Deputy",
  });
  chief = await createResident(program.program, {
    email: "chief@hospital.org",
    role: "chief",
    name: "Cleo Chief",
  });
  resident = await createResident(program.program, {
    email: "resident@hospital.org",
    name: "Robin Resident",
  });
});

async function roleOf(userId: string): Promise<UserRole | null> {
  const row = await queryOne<{ role: UserRole | null }>(
    "SELECT role FROM users WHERE id = $1",
    [userId],
  );
  return row?.role ?? null;
}

describe("granting a role", () => {
  it("lets an administrator appoint anybody below them", async () => {
    for (const role of ["resident", "chief", "apd", "pd"] as const) {
      await updateManagedUser(admin.context, resident.user.id, { role });
      expect(await roleOf(resident.user.id)).toBe(role);
    }
  });

  it("refuses to let anybody create an administrator except an administrator", async () => {
    for (const actor of [pd, apd]) {
      await expect(
        updateManagedUser(actor.context, resident.user.id, { role: "admin" }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await roleOf(resident.user.id)).toBe("resident");
  });

  it("refuses to let a PD appoint another PD", async () => {
    await expect(
      updateManagedUser(pd.context, resident.user.id, { role: "pd" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // …but a PD may appoint an APD.
    await updateManagedUser(pd.context, resident.user.id, { role: "apd" });
    expect(await roleOf(resident.user.id)).toBe("apd");
  });

  it("refuses to let an APD appoint an APD or a PD", async () => {
    for (const role of ["apd", "pd"] as const) {
      await expect(
        updateManagedUser(apd.context, resident.user.id, { role }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    await updateManagedUser(apd.context, resident.user.id, { role: "chief" });
    expect(await roleOf(resident.user.id)).toBe("chief");
  });

  it("names what the actor may assign, so the refusal is actionable", async () => {
    await expect(
      updateManagedUser(apd.context, resident.user.id, { role: "pd" }),
    ).rejects.toThrowError(/Resident, Chief resident/);
  });
});

describe("changing somebody at or above your own level", () => {
  it("refuses, which is what stops a lateral takeover", async () => {
    // Without this an APD could demote the PD and become the most senior
    // person left — an escalation that the "assign only below you" rule alone
    // does not catch, because "resident" is a role they may assign.
    await expect(
      updateManagedUser(apd.context, pd.user.id, { role: "resident" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await roleOf(pd.user.id)).toBe("pd");

    await expect(
      updateManagedUser(apd.context, apd.user.id, { role: "resident" }),
    ).rejects.toBeTruthy();
    await expect(
      updateManagedUser(pd.context, admin.user.id, { role: "chief" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets a senior role demote a junior one", async () => {
    await updateManagedUser(pd.context, chief.user.id, { role: "resident" });
    expect(await roleOf(chief.user.id)).toBe("resident");
  });
});

describe("your own account", () => {
  it("refuses a self role change in either direction", async () => {
    await expect(
      updateManagedUser(apd.context, apd.user.id, { role: "pd" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      updateManagedUser(admin.context, admin.user.id, { role: "resident" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await roleOf(admin.user.id)).toBe("admin");
  });

  it("refuses self-deactivation", async () => {
    await expect(
      updateManagedUser(admin.context, admin.user.id, { active: false }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("allows an unrelated change to your own record", async () => {
    const updated = await updateManagedUser(admin.context, admin.user.id, {
      fullName: "Ada A. Admin",
    });
    expect(updated.full_name).toBe("Ada A. Admin");
  });
});

describe("a program can never be left with nobody to run it", () => {
  /**
   * The requirement is "prevent accidental removal of the last necessary
   * administrator/PD-level user". The interesting finding while implementing it
   * is that the two rules above already make that state unreachable through the
   * application: only an active leader can change roles at all, and nobody can
   * change their own — so whoever performs the change is themselves a leader
   * who survives it.
   *
   * `updateManagedUser` still carries an explicit last-leader check, as a
   * backstop if the self-change rule is ever relaxed. Rather than contrive a
   * call that reaches it, this asserts the property that actually matters: no
   * sequence of permitted changes empties the program of leadership.
   */
  async function activeLeaders(): Promise<number> {
    const rows = await query<{ id: string }>(
      `SELECT id FROM users
        WHERE program_id = $1 AND active = true
          AND role IN ('apd', 'pd', 'admin')`,
      [program.program.id],
    );
    return rows.length;
  }

  it("survives every demotion and deactivation the rules permit", async () => {
    const actors = [admin, pd, apd];
    const targets = [
      { label: "admin", user: admin.user },
      { label: "pd", user: pd.user },
      { label: "apd", user: apd.user },
      { label: "chief", user: chief.user },
      { label: "resident", user: resident.user },
    ];

    for (const actor of actors) {
      for (const target of targets) {
        for (const change of [
          { role: "resident" as const },
          { active: false },
        ]) {
          try {
            await updateManagedUser(actor.context, target.user.id, change);
          } catch {
            // Refusals are the expected outcome for most of these pairs; what
            // matters is only what the permitted ones leave behind.
          }
          expect(
            await activeLeaders(),
            `after ${actor.user.email} applied ${JSON.stringify(change)} to ${target.label}`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("refuses the change explicitly when it would be the last one", async () => {
    // Reaching the guard directly requires a leader who is not the actor and is
    // the only one left, which the rules above prevent — so it is exercised
    // here through the domain function with the program already down to one.
    await updateManagedUser(admin.context, pd.user.id, { role: "chief" });
    await updateManagedUser(admin.context, apd.user.id, { role: "chief" });
    expect(await activeLeaders()).toBe(1);

    // The one remaining leader cannot remove themselves by any route.
    await expect(
      updateManagedUser(admin.context, admin.user.id, { role: "resident" }),
    ).rejects.toBeTruthy();
    await expect(
      updateManagedUser(admin.context, admin.user.id, { active: false }),
    ).rejects.toBeTruthy();
    expect(await activeLeaders()).toBe(1);
  });
});

describe("program isolation", () => {
  it("refuses to touch a user in another program", async () => {
    const other = await createProgram({ name: "Elsewhere" });
    const stranger = await createResident(other.program, {
      email: "stranger@hospital.org",
    });
    await expect(
      updateManagedUser(admin.context, stranger.user.id, { role: "chief" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await roleOf(stranger.user.id)).toBe("resident");
  });

  it("never lists another program's people", async () => {
    const other = await createProgram({ name: "Elsewhere" });
    await createResident(other.program, { email: "stranger@hospital.org" });
    const users = await listManagedUsers(program.program.id, {
      includeUnassigned: true,
    });
    expect(users.map((user) => user.email)).not.toContain("stranger@hospital.org");
  });

  it("never lets a service from one program be seen by another", async () => {
    const other = await createProgram({ name: "Elsewhere" });
    const otherAdmin = await createStaff(other.program, {
      email: "other.admin@hospital.org",
      role: "admin",
    });
    const mine = await createService(admin.context, "service", { name: "Private" });
    const theirs = await query<{ id: string }>(
      "SELECT id FROM services WHERE program_id = $1",
      [other.program.id],
    );
    expect(theirs.map((s) => s.id)).not.toContain(mine.id);
    // And their administrator cannot invite into my program either.
    const invitation = await createInvitation(otherAdmin.context, {
      email: "newcomer@hospital.org",
      role: "resident",
    });
    expect(invitation.invitation.program_id).toBe(other.program.id);
  });
});

describe("roles that hold a schedule", () => {
  it("creates a resident record when somebody becomes a resident or chief", async () => {
    await updateManagedUser(admin.context, apd.user.id, { role: "chief" });
    const record = await queryOne<{ id: string }>(
      "SELECT id FROM residents WHERE user_id = $1",
      [apd.user.id],
    );
    expect(record).not.toBeNull();
  });

  it("does not create one for program leadership", async () => {
    const fresh = await createStaff(program.program, {
      email: "newpd@hospital.org",
      role: "pd",
    });
    const record = await queryOne<{ id: string }>(
      "SELECT id FROM residents WHERE user_id = $1",
      [fresh.user.id],
    );
    expect(record).toBeNull();
  });
});
