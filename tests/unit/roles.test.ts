import { describe, expect, it } from "vitest";
import {
  assignableRoles,
  can,
  canAssignRole,
  capabilitiesOf,
  CAPABILITIES,
  expectsResidentRecord,
  isProgramLeadership,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  ROLE_ORDER,
  ROLE_SHORT_LABEL,
} from "@/server/auth/roles";
import type { UserRole } from "@/server/db/types";

/**
 * The permission matrix, asserted as policy rather than as implementation.
 *
 * These read like the table in docs/ROLES.md on purpose: if somebody widens a
 * role by accident, the failure should name the role and the capability, not a
 * boolean that changed.
 */

describe("the five roles", () => {
  it("are exactly the roles a residency program has, in seniority order", () => {
    expect(ROLE_ORDER).toEqual(["resident", "chief", "apd", "pd", "admin"]);
  });

  it("all have a label, a short label and a description", () => {
    for (const role of ROLE_ORDER) {
      expect(ROLE_LABEL[role], role).toBeTruthy();
      expect(ROLE_SHORT_LABEL[role], role).toBeTruthy();
      expect(ROLE_DESCRIPTION[role], role).toBeTruthy();
    }
    // The terminology the product uses, not generic tiers.
    expect(ROLE_LABEL.pd).toBe("Program Director");
    expect(ROLE_LABEL.apd).toBe("Associate Program Director");
    expect(ROLE_SHORT_LABEL.pd).toBe("PD");
    expect(ROLE_SHORT_LABEL.apd).toBe("APD");
  });
});

describe("what each role may do", () => {
  const EXPECTED: Record<UserRole, string[]> = {
    resident: ["trade.participate"],
    chief: [
      "trade.participate",
      "approvals.decide",
      "schedule.manage",
      "schedule.export_program",
      "analytics.view",
      "audit.view",
      "scheduling.plan",
      "schedule.publish",
      "residents.contact_info",
    ],
    apd: [
      "trade.participate",
      "approvals.decide",
      "schedule.manage",
      "scheduling.plan",
      "schedule.publish",
      "residents.contact_info",
      "schedule.export_program",
      "analytics.view",
      "audit.view",
      "services.manage",
      "invitations.manage",
      "users.manage",
      "rules.manage",
      "contacts.manage",
    ],
    pd: [
      "trade.participate",
      "approvals.decide",
      "schedule.manage",
      "scheduling.plan",
      "schedule.publish",
      "residents.contact_info",
      "schedule.export_program",
      "analytics.view",
      "audit.view",
      "services.manage",
      "invitations.manage",
      "users.manage",
      "rules.manage",
      "contacts.manage",
      "program.manage",
    ],
    admin: [...CAPABILITIES],
  };

  for (const role of ROLE_ORDER) {
    it(`${role} has exactly the documented capabilities`, () => {
      expect(capabilitiesOf(role).sort()).toEqual([...EXPECTED[role]].sort());
    });
  }

  it("gives a resident no administrative reach at all", () => {
    for (const capability of CAPABILITIES) {
      if (capability === "trade.participate") continue;
      expect(can("resident", capability), capability).toBe(false);
    }
  });

  it("keeps a chief out of user management, which is the point of the role", () => {
    expect(can("chief", "users.manage")).toBe(false);
    expect(can("chief", "invitations.manage")).toBe(false);
    expect(can("chief", "services.manage")).toBe(false);
    expect(can("chief", "program.manage")).toBe(false);
    // …but a chief runs the schedule and the approvals queue.
    expect(can("chief", "approvals.decide")).toBe(true);
    expect(can("chief", "schedule.manage")).toBe(true);
  });

  it("keeps an APD out of the program's own settings", () => {
    expect(can("apd", "users.manage")).toBe(true);
    expect(can("apd", "program.manage")).toBe(false);
    expect(can("pd", "program.manage")).toBe(true);
  });

  it("reserves maintenance for the administrator", () => {
    for (const role of ROLE_ORDER) {
      expect(can(role, "maintenance.run"), role).toBe(role === "admin");
    }
  });

  it("is monotonic — nobody senior can do less than somebody junior", () => {
    for (let i = 1; i < ROLE_ORDER.length; i += 1) {
      const junior = ROLE_ORDER[i - 1];
      const senior = ROLE_ORDER[i];
      for (const capability of capabilitiesOf(junior)) {
        expect(
          can(senior, capability),
          `${senior} should be able to do everything ${junior} can (${capability})`,
        ).toBe(true);
      }
    }
  });
});

describe("who may assign which role", () => {
  it("lets each role assign only roles junior to their own", () => {
    expect(assignableRoles("resident")).toEqual([]);
    expect(assignableRoles("chief")).toEqual(["resident"]);
    expect(assignableRoles("apd")).toEqual(["resident", "chief"]);
    expect(assignableRoles("pd")).toEqual(["resident", "chief", "apd"]);
    expect(assignableRoles("admin")).toEqual(["resident", "chief", "apd", "pd"]);
  });

  it("stops anybody appointing a peer or promoting themselves", () => {
    for (const role of ROLE_ORDER) {
      expect(canAssignRole(role, role), `${role} assigning ${role}`).toBe(false);
    }
    expect(canAssignRole("apd", "pd")).toBe(false);
    expect(canAssignRole("pd", "admin")).toBe(false);
    // Only an administrator can create another administrator.
    for (const role of ROLE_ORDER) {
      expect(canAssignRole(role, "admin"), role).toBe(false);
    }
  });
});

describe("supporting predicates", () => {
  it("expects a resident record only from the roles that hold a schedule", () => {
    expect(expectsResidentRecord("resident")).toBe(true);
    expect(expectsResidentRecord("chief")).toBe(true);
    expect(expectsResidentRecord("apd")).toBe(false);
    expect(expectsResidentRecord("pd")).toBe(false);
    expect(expectsResidentRecord("admin")).toBe(false);
  });

  it("counts leadership as anybody who can manage people", () => {
    expect(ROLE_ORDER.filter(isProgramLeadership)).toEqual(["apd", "pd", "admin"]);
  });
});
