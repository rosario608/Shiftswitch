import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query, queryOne } from "@/server/db/pool";
import { createService, listServices, updateService } from "@/server/domain/services";
import { createShift } from "@/server/domain/admin";
import { commitImport, validateImport } from "@/server/domain/import";
import {
  NY,
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  resetDatabase,
} from "./helpers";

/**
 * Managing services and rotations — the entities the importer used to create as
 * a side effect and nobody could then look at, rename or retire.
 */

let program: Awaited<ReturnType<typeof createProgram>>;
let pd: Awaited<ReturnType<typeof createStaff>>;
let chief: Awaited<ReturnType<typeof createResident>>;
let alice: Awaited<ReturnType<typeof createResident>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  program = await createProgram({ name: "Service Admin" });
  pd = await createStaff(program.program, { email: "pd@hospital.org", role: "pd" });
  chief = await createResident(program.program, {
    email: "chief@hospital.org",
    role: "chief",
  });
  alice = await createResident(program.program, {
    email: "alice@hospital.org",
    name: "Alice Adeyemi",
  });
});

describe("creating a service", () => {
  it("creates it with a name, a short name and a swappable flag", async () => {
    const created = await createService(pd.context, "service", {
      name: "  Cardiology   Consults ",
      abbreviation: "CARDS",
      tradeable: false,
    });
    // Whitespace is tidied rather than preserved: " MICU " and "MICU" are the
    // same service to everybody except a string comparison.
    expect(created.name).toBe("Cardiology Consults");
    expect(created.abbreviation).toBe("CARDS");
    expect(created.tradeable).toBe(false);
    expect(created.active).toBe(true);
    expect(created.shift_count).toBe(0);
  });

  it("refuses a second service whose name differs only in case", async () => {
    await createService(pd.context, "service", { name: "Neurology" });
    await expect(
      createService(pd.context, "service", { name: "NEUROLOGY" }),
    ).rejects.toMatchObject({ code: "conflict" });

    // And the message names the one that already exists, so the person can find it.
    await expect(
      createService(pd.context, "service", { name: "neurology" }),
    ).rejects.toThrowError(/Neurology/);
  });

  it("points at the inactive one rather than letting a duplicate be created", async () => {
    const created = await createService(pd.context, "service", { name: "Nights" });
    await updateService(pd.context, "service", created.id, { active: false });
    await expect(
      createService(pd.context, "service", { name: "Nights" }),
    ).rejects.toThrowError(/Reactivate it/i);
  });

  it("refuses an empty name", async () => {
    await expect(
      createService(pd.context, "service", { name: "   " }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("keeps services and rotations in separate namespaces", async () => {
    // A program can legitimately have a service and a rotation with the same
    // name — "Ambulatory" is both a place you work and a block you are on.
    await createService(pd.context, "service", { name: "Ambulatory" });
    const rotation = await createService(pd.context, "rotation", { name: "Ambulatory" });
    expect(rotation.name).toBe("Ambulatory");

    const services = await listServices(program.program.id, "service");
    const rotations = await listServices(program.program.id, "rotation");
    expect(services.map((s) => s.name)).toContain("Ambulatory");
    expect(rotations.map((r) => r.name)).toContain("Ambulatory");
  });

  it("records who created it", async () => {
    const created = await createService(pd.context, "service", { name: "Toxicology" });
    const audit = await queryOne<{ action: string; actor_label: string }>(
      "SELECT action, actor_label FROM audit_logs WHERE entity_id = $1",
      [created.id],
    );
    expect(audit?.action).toBe("service.created");
    expect(audit?.actor_label).toBe("pd@hospital.org");
  });
});

describe("editing a service", () => {
  it("renames without moving any shift", async () => {
    const service = await createService(pd.context, "service", { name: "Wards" });
    await createShift(chief.context, {
      serviceId: service.id,
      date: DateTime.now().setZone(NY).plus({ days: 20 }).toISODate() as string,
      startTime: "07:00",
      endTime: "19:00",
      endsNextDay: false,
      location: "",
      shiftType: "day",
      requiredPgyMin: 1,
      requiredPgyMax: 10,
      tradeable: true,
      approvalRequired: false,
      residentId: alice.resident.id,
    });

    const renamed = await updateService(pd.context, "service", service.id, {
      name: "General Wards",
    });
    expect(renamed.name).toBe("General Wards");
    expect(renamed.shift_count).toBe(1);

    const shifts = await query<{ service_id: string }>("SELECT service_id FROM shifts");
    expect(shifts).toHaveLength(1);
    expect(shifts[0].service_id).toBe(service.id);
  });

  it("refuses a rename that collides with another service", async () => {
    await createService(pd.context, "service", { name: "Cardiology" });
    const other = await createService(pd.context, "service", { name: "Neurology" });
    await expect(
      updateService(pd.context, "service", other.id, { name: "cardiology" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a new service that collides with one the fixture already has", async () => {
    // `createProgram` seeds MICU. Case-insensitive means case-insensitive.
    await expect(
      createService(pd.context, "service", { name: "micu" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows a rename that only changes the capitalisation of itself", async () => {
    const service = await createService(pd.context, "service", { name: "toxicology" });
    const fixed = await updateService(pd.context, "service", service.id, {
      name: "Toxicology",
    });
    expect(fixed.name).toBe("Toxicology");
  });

  it("refuses to deactivate a service with upcoming shifts, and says how many", async () => {
    const service = await createService(pd.context, "service", { name: "Consults" });
    await createShift(chief.context, {
      serviceId: service.id,
      date: DateTime.now().setZone(NY).plus({ days: 10 }).toISODate() as string,
      startTime: "07:00",
      endTime: "19:00",
      endsNextDay: false,
      location: "",
      shiftType: "day",
      requiredPgyMin: 1,
      requiredPgyMax: 10,
      tradeable: true,
      approvalRequired: false,
      residentId: alice.resident.id,
    });

    await expect(
      updateService(pd.context, "service", service.id, { active: false }),
    ).rejects.toThrowError(/1 upcoming shift/);
  });

  it("deactivates a service whose shifts are all in the past, and can bring it back", async () => {
    const service = await createService(pd.context, "service", { name: "Retired" });
    await query(
      `INSERT INTO shifts (program_id, service_id, date, start_datetime, end_datetime)
       VALUES ($1, $2, now() - interval '30 days', now() - interval '30 days',
               now() - interval '30 days' + interval '12 hours')`,
      [program.program.id, service.id],
    );

    const off = await updateService(pd.context, "service", service.id, {
      active: false,
    });
    expect(off.active).toBe(false);
    expect(off.shift_count).toBe(1);

    const on = await updateService(pd.context, "service", service.id, { active: true });
    expect(on.active).toBe(true);
  });

  it("does not reach another program's services", async () => {
    const other = await createProgram({ name: "Elsewhere" });
    const otherPd = await createStaff(other.program, {
      email: "other.pd@hospital.org",
      role: "pd",
    });
    const mine = await createService(pd.context, "service", { name: "Mine" });

    await expect(
      updateService(otherPd.context, "service", mine.id, { name: "Theirs" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("services and the rest of the product", () => {
  it("shows a newly created service to the import immediately", async () => {
    await createService(pd.context, "service", { name: "Hospitalist" });

    const preview = await validateImport(chief.context, [
      {
        Email: "alice@hospital.org",
        Date: DateTime.now().setZone(NY).plus({ days: 30 }).toISODate() as string,
        "Start time": "07:00",
        "End time": "19:00",
        Service: "hospitalist",
      },
    ]);
    // Matched case-insensitively against the service that already exists, so
    // the import does not create a second one.
    expect(preview.issues).toHaveLength(0);
    expect(preview.summary.newServices).toHaveLength(0);

    const result = await commitImport(chief.context, preview.rows);
    expect(result.createdServices).toBe(0);
    expect(result.createdShifts).toBe(1);

    const services = await listServices(program.program.id, "service");
    expect(services.filter((s) => /hospitalist/i.test(s.name))).toHaveLength(1);
  });

  it("counts the shifts on a service that the import created", async () => {
    await validateImport(chief.context, []);
    const preview = await validateImport(chief.context, [
      {
        Email: "alice@hospital.org",
        Date: DateTime.now().setZone(NY).plus({ days: 31 }).toISODate() as string,
        "Start time": "07:00",
        "End time": "19:00",
        Service: "Brand New",
      },
    ]);
    await commitImport(chief.context, preview.rows);

    const services = await listServices(program.program.id, "service");
    const created = services.find((s) => s.name === "Brand New");
    expect(created).toBeDefined();
    expect(created!.shift_count).toBe(1);
    expect(created!.upcoming_shift_count).toBe(1);
  });
});
