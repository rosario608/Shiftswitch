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
import { allowsWhilePending } from "@/server/auth/guards";
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
    resident: ["trade.participate", "shifts.self_report"],
    chief: [
      "trade.participate",
      "shifts.self_report",
      "approvals.decide",
      "schedule.manage",
      "schedule.export_program",
      "analytics.view",
      "audit.view",
      "scheduling.plan",
      "schedule.publish",
      "shifts.confirm",
      "residents.contact_info",
    ],
    apd: [
      "trade.participate",
      "shifts.self_report",
      "approvals.decide",
      "schedule.manage",
      "scheduling.plan",
      "schedule.publish",
      "shifts.confirm",
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
      "shifts.self_report",
      "approvals.decide",
      "schedule.manage",
      "scheduling.plan",
      "schedule.publish",
      "shifts.confirm",
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
      // Their own schedule is their own business, admitted or not.
      if (capability === "shifts.self_report") continue;
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

/**
 * The second axis of permission: not what role somebody has, but whether the
 * program has confirmed they belong.
 *
 * Somebody who joined by an enrollment link with an address the program had not
 * listed is a resident in every respect except that nobody has vouched for
 * them. They hold their own schedule; they see nothing about anybody else. The
 * rule is one function so that a new screen cannot forget it, and it is tested
 * here rather than through the guard because the guard needs a cookie, a
 * session and a database — and a rule reachable only through three of those is
 * a rule nobody tests.
 */
describe("an account waiting to be confirmed", () => {
  it("can hold and correct its own schedule", () => {
    expect(allowsWhilePending("pending", "shifts.self_report")).toBe(true);
  });

  it("cannot reach anything involving another resident", () => {
    /* The board is the important one: it is the screen a pending account would
       most plausibly be shown by accident, and it is everybody's shifts. */
    expect(allowsWhilePending("pending", "trade.participate")).toBe(false);
    expect(allowsWhilePending("pending", "residents.contact_info")).toBe(false);
    expect(allowsWhilePending("pending", "schedule.manage")).toBe(false);
    expect(allowsWhilePending("pending", "approvals.decide")).toBe(false);
  });

  it("cannot vouch for a shift, which is the point of not being vouched for", () => {
    expect(allowsWhilePending("pending", "shifts.confirm")).toBe(false);
  });

  it("closes every capability but the one, so a new one is closed by default", () => {
    for (const capability of CAPABILITIES) {
      if (capability === "shifts.self_report") continue;
      expect(allowsWhilePending("pending", capability), capability).toBe(false);
    }
  });

  it("stops mattering the moment somebody is confirmed", () => {
    for (const capability of CAPABILITIES) {
      expect(allowsWhilePending("confirmed", capability), capability).toBe(true);
    }
  });
});
