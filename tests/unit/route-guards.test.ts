import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, can, type Capability } from "@/server/auth/roles";
import { ROLE_ORDER } from "@/server/auth/roles";
import type { UserRole } from "@/server/db/types";

/**
 * Server-side authorization, asserted as a table rather than trusted.
 *
 * Every route handler is a door. `requireCapability` in the body of each one is
 * the only thing standing between a signed-in resident and the whole
 * programme's schedule, and nothing else in the codebase can tell you whether a
 * door was left open — a missing guard is a line that isn't there, which no
 * type checks and no test of the happy path notices.
 *
 * So this reads the routes off disk and asserts three things:
 *
 *  1. every route that mutates names a guard, with a written exemption list;
 *  2. the capability each route names is exactly the one below, so widening a
 *     route is a deliberate edit to a table and not an invisible consequence of
 *     copying a neighbouring file;
 *  3. the capability a route requires is one that the people who use that
 *     screen actually hold — which is the check that caught the real defect
 *     this file was written for: coverage requirements, the generator's primary
 *     input, were guarded by `services.manage`, a capability the chief resident
 *     who builds the schedule deliberately does not have.
 *
 * A static read rather than an HTTP call because the property is about the
 * source: "no route lacks a guard" is a statement about all 77 files, and a
 * request-based test can only ever assert it about the ones somebody
 * remembered to write a case for.
 */

const API_ROOT = join(process.cwd(), "src", "app", "api");

interface Route {
  /** Path relative to `src/app/api`, POSIX-separated, e.g. `admin/coverage`. */
  id: string;
  verbs: string[];
  capabilities: Capability[];
  /** Non-capability guards: `requireUser`, `requireResident`, … */
  guards: string[];
  source: string;
}

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full));
    else if (entry === "route.ts") found.push(full);
  }
  return found.sort();
}

const ROUTES: Route[] = routeFiles(API_ROOT).map((file) => {
  const source = readFileSync(file, "utf8");
  const id = relative(API_ROOT, file).split(sep).slice(0, -1).join("/");
  return {
    id,
    verbs: [...source.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gm)]
      .map((match) => match[1])
      .sort(),
    capabilities: [
      ...new Set(
        [...source.matchAll(/require(?:Any)?Capability\(\s*\[?\s*"([a-z._]+)"/g)].map(
          (match) => match[1] as Capability,
        ),
      ),
    ].sort(),
    guards: [
      ...new Set(
        [...source.matchAll(/\b(requireUser|requireResident|getSessionContext)\(/g)].map(
          (match) => match[1],
        ),
      ),
    ].sort(),
    source,
  };
});

/**
 * Routes that deliberately authorise nothing, and why. Every entry here is a
 * decision somebody has to defend; the list existing is what makes a *new*
 * unguarded route a test failure rather than a silent addition.
 */
const NO_GUARD: Record<string, string> = {
  "auth/google/callback": "Sign-in. Establishes the session; there is nothing to guard yet.",
  "auth/google/start": "Sign-in. Redirects to Google.",
  "auth/native/exchange":
    "Sign-in for the native client. Trades a one-time code for a bearer token; the code is the credential.",
  "auth/test-login": "Refuses outright outside a local test environment.",
  "dev/accept-invitation":
    "The development invitation sandbox. Refuses outright outside a development environment.",
  "well-known/apple-app-site-association": "A public static document, by Apple's spec.",
  "well-known/assetlinks": "A public static document, by Google's spec.",
};

/**
 * What each route requires. The point of writing it out is that a reader can
 * check it against `docs/ROLES.md` without opening 77 files, and a widening
 * shows up as a diff on this table.
 *
 * `"session"` means any signed-in account, including one not yet configured
 * with a role — the two places that is correct are noted where they appear.
 */
const EXPECTED: Record<string, Capability | "session" | "resident"> = {
  "account/delete": "session",
  "account/identities": "session",
  "admin/analytics": "analytics.view",
  "admin/audit": "audit.view",
  "admin/blocks": "scheduling.plan",
  "admin/blocks/[structureId]": "scheduling.plan",
  "admin/cohorts": "scheduling.plan",
  "admin/cohorts/[cohortId]": "scheduling.plan",
  "admin/contacts": "contacts.manage",
  "admin/contacts/[contactId]": "contacts.manage",
  "admin/corrections": "schedule.manage",
  /* Coverage is the generator's input, so it belongs to whoever builds the
     schedule — `scheduling.plan` — and not to `services.manage`, which is
     about what a service is. See the note on the route itself. */
  "admin/coverage": "scheduling.plan",
  "admin/coverage/[coverageId]": "scheduling.plan",
  "admin/export": "session",
  "admin/import": "schedule.manage",
  "admin/import/template": "schedule.manage",
  "admin/invitations": "invitations.manage",
  "admin/invitations/[invitationId]": "invitations.manage",
  "admin/maintenance": "maintenance.run",
  "admin/program": "program.manage",
  "admin/roster": "scheduling.plan",
  "admin/roster/[residentId]": "scheduling.plan",
  "admin/rules": "rules.manage",
  "admin/rules/[ruleId]": "rules.manage",
  "admin/schedule-generation": "scheduling.plan",
  "admin/schedule-validation": "scheduling.plan",
  "admin/schedule-versions": "scheduling.plan",
  "admin/schedule-versions/[versionId]": "scheduling.plan",
  "admin/schedule-versions/[versionId]/bulk": "scheduling.plan",
  "admin/schedule-versions/[versionId]/locks": "scheduling.plan",
  "admin/schedule-versions/[versionId]/shifts": "scheduling.plan",
  "admin/schedule-versions/[versionId]/shifts/[shiftId]": "scheduling.plan",
  "admin/schedule-workspace": "scheduling.plan",
  "admin/service-templates": "services.manage",
  "admin/services": "services.manage",
  "admin/services/[serviceId]": "services.manage",
  "admin/shifts": "schedule.manage",
  "admin/shifts/[shiftId]": "schedule.manage",
  "admin/sites": "services.manage",
  "admin/users": "users.manage",
  "admin/users/[userId]": "users.manage",
  "approvals": "approvals.decide",
  "approvals/[tradeId]/approve": "approvals.decide",
  "approvals/[tradeId]/reject": "approvals.decide",
  "approvals/[tradeId]/request-changes": "approvals.decide",
  "auth/signout": "session",
  "availability": "session",
  "availability/[id]": "session",
  "calendar/subscription": "resident",
  "dashboard": "session",
  /* Any signed-in account, deliberately including one with no role yet: a
     person waiting to be configured still needs to be told when they are. */
  "devices": "session",
  "emails/[emailId]": "session",
  "emails/[emailId]/status": "session",
  "notifications": "session",
  "notifications/preferences": "session",
  "notifications/read": "session",
  "offers/[offerId]/accept": "resident",
  "offers/[offerId]/reject": "resident",
  "offers/[offerId]/withdraw": "resident",
  "schedule": "session",
  /* Reports who you are, including "signed in but not configured yet", which
     is exactly the state the pending screen needs to read. */
  "session": "session",
  "shifts/[shiftId]": "session",
  "switches/[tradeId]": "session",
  "switches/[tradeId]/email": "session",
  "trades": "resident",
  "trades/[tradeId]": "session",
  "trades/[tradeId]/cancel": "session",
  "trades/[tradeId]/candidates": "resident",
  "trades/[tradeId]/offers": "resident",
};

/**
 * Routes that require a second, narrower capability for one of their verbs.
 * Listing them separately keeps `EXPECTED` readable — the first entry is what
 * the route is *for*, this is the extra thing one verb on it needs.
 */
const ADDITIONAL: Record<string, Capability[]> = {
  /* Approving and publishing a draft is a different authority from building
     one, so a programme can hand a senior resident the schedule without the
     power to make it live. */
  "admin/schedule-versions/[versionId]": ["schedule.publish"],
  /* Reading a resident's phone number, which the roster editor does not need. */
  "admin/roster/[residentId]": ["residents.contact_info"],
  /* Confirming somebody else's absence, as opposed to recording your own. */
  "availability/[id]": ["scheduling.plan"],
};

describe("every route is guarded", () => {
  it("finds the whole API surface", () => {
    // A sanity floor: if the walk silently returned nothing, everything below
    // would pass vacuously.
    expect(ROUTES.length).toBeGreaterThan(60);
  });

  it("has an expectation recorded for every route, and no stale ones", () => {
    const found = ROUTES.map((route) => route.id).sort();
    const declared = [...Object.keys(EXPECTED), ...Object.keys(NO_GUARD)].sort();
    expect(declared).toEqual(found);
  });

  it("never lets a route mutate without authorising the caller", () => {
    for (const route of ROUTES) {
      const mutates = route.verbs.some((verb) => verb !== "GET");
      if (!mutates) continue;
      if (route.id in NO_GUARD) continue;
      expect(
        route.capabilities.length + route.guards.length,
        `${route.id} mutates (${route.verbs.join(", ")}) with no guard`,
      ).toBeGreaterThan(0);
    }
  });

  it("requires exactly the capability the table says", () => {
    for (const route of ROUTES) {
      if (route.id in NO_GUARD) continue;
      const expected = EXPECTED[route.id];
      const extra = ADDITIONAL[route.id] ?? [];

      if (expected === "session" || expected === "resident") {
        expect(route.capabilities.sort(), `${route.id} capabilities`).toEqual(
          [...extra].sort(),
        );
        continue;
      }
      expect(route.capabilities.sort(), `${route.id} capabilities`).toEqual(
        [expected, ...extra].sort(),
      );
    }
  });

  it("names only capabilities that exist", () => {
    for (const route of ROUTES) {
      for (const capability of route.capabilities) {
        expect(CAPABILITIES, `${route.id} requires "${capability}"`).toContain(capability);
      }
    }
  });
});

/**
 * The check that catches an authorisation/product mismatch rather than a
 * missing guard: a screen whose door one role opens, whose API another role's
 * capability closes. Both halves are true individually and the pair is a bug —
 * the person lands on a working page where every button returns 403.
 *
 * Expressed as "which roles can use this workflow end to end", because that is
 * the question a programme asks, and because a role list is what makes the
 * failure legible: `expected chief to be able to set coverage` says what is
 * wrong without anybody having to know which capability is which.
 */
describe("a workflow's screen and its API agree", () => {
  const WORKFLOWS: Array<{
    what: string;
    /** The page guard, or guards where any one opens it. */
    page: Capability[];
    /** The capability the API behind that page requires. */
    api: Capability;
  }> = [
    {
      what: "setting how many people a service needs",
      page: ["services.manage", "scheduling.plan"],
      api: "scheduling.plan",
    },
    { what: "building a draft schedule", page: ["scheduling.plan"], api: "scheduling.plan" },
    {
      what: "bulk-editing a draft",
      page: ["scheduling.plan"],
      api: "scheduling.plan",
    },
    {
      what: "recording who is away",
      page: ["scheduling.plan"],
      api: "scheduling.plan",
    },
    {
      what: "correcting a published shift",
      page: ["schedule.manage"],
      api: "schedule.manage",
    },
    { what: "deciding a switch", page: ["approvals.decide"], api: "approvals.decide" },
    { what: "changing a role", page: ["users.manage"], api: "users.manage" },
  ];

  it("lets anybody who can open the screen use it", () => {
    for (const workflow of WORKFLOWS) {
      for (const role of ROLE_ORDER as UserRole[]) {
        const opens = workflow.page.some((capability) => can(role, capability));
        if (!opens) continue;
        /* Reaching the screen does not have to mean editing every half of it —
           a chief reads a service's identity without changing it. What it must
           mean is that at least one role-appropriate thing on the page works,
           and that the *primary* action of the workflow is not refused to
           everybody the door lets in. Coverage is the primary action of the
           first entry, so `scheduling.plan` holders must have it. */
        if (workflow.page.length === 1) {
          expect(
            can(role, workflow.api),
            `${role} can open "${workflow.what}" but the API refuses them`,
          ).toBe(true);
        }
      }
      // Whoever the API is for must be able to reach a screen that calls it.
      for (const role of ROLE_ORDER as UserRole[]) {
        if (!can(role, workflow.api)) continue;
        expect(
          workflow.page.some((capability) => can(role, capability)),
          `${role} may call the API for "${workflow.what}" but cannot reach a screen for it`,
        ).toBe(true);
      }
    }
  });

  it("lets a chief resident set the coverage the generator reads", () => {
    /* Named on its own because it is the defect this file was written for, and
       because it is the one a reader of docs/ROLES.md would assume rather than
       check: coverage planning is listed under `scheduling.plan` there, in the
       capability's own comment, and in the refusal message a chief would see. */
    expect(can("chief", "scheduling.plan")).toBe(true);
    expect(EXPECTED["admin/coverage"]).toBe("scheduling.plan");
    expect(EXPECTED["admin/coverage/[coverageId]"]).toBe("scheduling.plan");
    expect(can("chief", "services.manage")).toBe(false);
  });
});
