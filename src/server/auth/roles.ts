import type { UserRole } from "@/server/db/types";

/**
 * Who can do what.
 *
 * The five roles are the ones a residency programme actually has, not generic
 * software tiers:
 *
 *   resident  a resident, working their own schedule
 *   chief     a chief resident: still a resident, plus the coordination work
 *   apd       Associate/Assistant Program Director
 *   pd        Program Director
 *   admin     Program administrator — full control, including the software
 *
 * Permissions are an explicit matrix rather than a numeric rank, because the
 * roles genuinely are not a straight line of "more of the same". A chief
 * resident approves switches and runs the schedule but has no business changing
 * anybody's role; an APD manages people and services but not the program's own
 * identity; only an administrator runs maintenance. Writing that as
 * `rank >= 2` hides the actual policy in arithmetic and makes every future
 * change a guess.
 *
 * The rank below still exists, but it means one thing only: **seniority**, used
 * to decide who may assign whom. It is never used to decide what a role can do.
 */

export const ROLE_ORDER: UserRole[] = ["resident", "chief", "apd", "pd", "admin"];

export const ROLE_LABEL: Record<UserRole, string> = {
  resident: "Resident",
  chief: "Chief resident",
  apd: "Associate Program Director",
  pd: "Program Director",
  admin: "Administrator",
};

/** The short form used where space is tight, e.g. a table cell or a badge. */
export const ROLE_SHORT_LABEL: Record<UserRole, string> = {
  resident: "Resident",
  chief: "Chief",
  apd: "APD",
  pd: "PD",
  admin: "Admin",
};

export const ROLE_DESCRIPTION: Record<UserRole, string> = {
  resident: "Sees their own schedule, posts shifts for switching, and offers on others.",
  chief:
    "Everything a resident does, plus the approvals queue, the schedule, and the import.",
  apd: "Program leadership: people, invitations, services, rules and contacts.",
  pd: "Everything an APD does, plus the program's own settings.",
  admin: "Full control of the program, including maintenance and appointing leadership.",
};

/** Seniority. Only used for deciding who may assign which role. */
const ROLE_RANK: Record<UserRole, number> = {
  resident: 1,
  chief: 2,
  apd: 3,
  pd: 4,
  admin: 5,
};

export function roleRank(role: UserRole): number {
  return ROLE_RANK[role];
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Every capability corresponds to something the product actually does. Nothing
 * here exists for symmetry — if no route or screen checks it, it is not here.
 */
export const CAPABILITIES = [
  /** Work one's own schedule: post a shift, offer on one, accept an offer. */
  "trade.participate",
  /** Decide on switches that need chief approval. */
  "approvals.decide",
  /** Create, edit, move, reassign and delete shifts; import a block. */
  "schedule.manage",
  /** Export the whole program's schedule, not just one's own. */
  "schedule.export_program",
  /** The program-wide analytics view. */
  "analytics.view",
  /** The audit log. */
  "audit.view",
  /** Create and edit services and rotations. */
  "services.manage",
  /** Invite people, resend and revoke invitations. */
  "invitations.manage",
  /** Change roles, activate and deactivate accounts. */
  "users.manage",
  /** Configure the rules engine. */
  "rules.manage",
  /** Program notification contacts. */
  "contacts.manage",
  /** The program's own identity: name, institution, timezone, approved domains. */
  "program.manage",
  /** Housekeeping: expire stale posts, prune, recompute. */
  "maintenance.run",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The permission matrix. Documented in `docs/ROLES.md`; this is the source of
 * truth and that document describes it.
 */
const ROLE_CAPABILITIES: Record<UserRole, ReadonlySet<Capability>> = {
  resident: new Set<Capability>(["trade.participate"]),

  chief: new Set<Capability>([
    "trade.participate",
    "approvals.decide",
    "schedule.manage",
    "schedule.export_program",
    "analytics.view",
    "audit.view",
  ]),

  apd: new Set<Capability>([
    "trade.participate",
    "approvals.decide",
    "schedule.manage",
    "schedule.export_program",
    "analytics.view",
    "audit.view",
    "services.manage",
    "invitations.manage",
    "users.manage",
    "rules.manage",
    "contacts.manage",
  ]),

  pd: new Set<Capability>([
    "trade.participate",
    "approvals.decide",
    "schedule.manage",
    "schedule.export_program",
    "analytics.view",
    "audit.view",
    "services.manage",
    "invitations.manage",
    "users.manage",
    "rules.manage",
    "contacts.manage",
    "program.manage",
  ]),

  admin: new Set<Capability>(CAPABILITIES),
};

export function can(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function capabilitiesOf(role: UserRole): Capability[] {
  return CAPABILITIES.filter((capability) => can(role, capability));
}

/**
 * Every role that holds a capability — the inverse of `capabilitiesOf`.
 *
 * For the places that need a *list* of roles rather than a yes/no on one:
 * notification routing, `role = ANY(...)` in SQL, "who can I escalate to".
 * Those are exactly the places a hand-written list rots. `listProgramApprovers`
 * asked for `role IN ('chief', 'admin')` and was written before APD and PD
 * existed, so from the moment they did, a program run by a PD generated
 * approval requests that notified nobody — the queue filled up silently and the
 * only symptom was switches that sat there.
 */
export function rolesWith(capability: Capability): UserRole[] {
  return ROLE_ORDER.filter((role) => can(role, capability));
}

/**
 * The roles a given role may assign to somebody else.
 *
 * Strictly junior to your own, which gives three properties for free:
 * nobody can promote themselves, nobody can appoint a peer who could then
 * demote them, and the only way a new administrator appears is that an existing
 * one creates them.
 */
export function assignableRoles(actor: UserRole): UserRole[] {
  return ROLE_ORDER.filter((role) => ROLE_RANK[role] < ROLE_RANK[actor]);
}

export function canAssignRole(actor: UserRole, target: UserRole): boolean {
  return assignableRoles(actor).includes(target);
}

/**
 * Roles that hold a schedule and can therefore trade.
 *
 * A chief resident is a resident. Program leadership generally is not — but an
 * APD or PD who also works clinically is common enough that the product does
 * not forbid it: they get a resident record only if somebody gives them one,
 * and `trade.participate` then applies to it.
 */
export function expectsResidentRecord(role: UserRole): boolean {
  return role === "resident" || role === "chief";
}

/**
 * Whether a role can still administer the program on its own. Used to refuse
 * the change that would leave a program with nobody able to manage its people.
 */
export function isProgramLeadership(role: UserRole): boolean {
  return can(role, "users.manage");
}
