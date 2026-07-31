import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";

/**
 * The roster as a scheduler needs it: who is available, at what level, in which
 * cohort, at which sites, with what constraints.
 *
 * Distinct from `admin.ts`'s user management, which is about accounts and
 * roles. This is about people as schedulable resources, and the two genuinely
 * are different questions — deactivating an account and marking somebody
 * unavailable for six weeks are not the same act and must not share a switch.
 */

/**
 * Phone numbers are normalised to E.164 where the input allows it.
 *
 * Stored normalised because the alternative is five formats of the same number
 * in one column and no way to tell they match. Ten digits are assumed to be
 * North American, which is where this programme is; anything already carrying a
 * `+` is kept as given, so an international number is not mangled by a
 * well-meaning default.
 *
 * Returns the normalised value, or throws with an explanation. Deliberately not
 * strict about punctuation on input — a scheduler pasting `(919) 555-0142` from
 * a spreadsheet is doing nothing wrong.
 */
export function normalisePhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/[\s().-]/g, "");
    if (!/^\d{8,15}$/.test(digits)) {
      throw validationFailed(
        `"${raw}" is not a phone number. An international number looks like +44 20 7946 0958.`,
      );
    }
    return `+${digits}`;
  }

  const digits = trimmed.replace(/[\s().-]/g, "");
  if (!/^\d+$/.test(digits)) {
    throw validationFailed(
      `"${raw}" contains characters that are not part of a phone number.`,
    );
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw validationFailed(
    `"${raw}" has ${digits.length} digits. A US number has 10; start with + for another country.`,
  );
}

/** "+19195550142" → "(919) 555-0142". Display only. */
export function formatPhone(stored: string): string {
  if (!stored) return "";
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(stored);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : stored;
}

export interface RosterResident {
  id: string;
  user_id: string;
  name: string;
  email: string;
  pgy_level: number;
  graduation_year: number;
  credentials: string[];
  active: boolean;
  schedulable: boolean;
  scheduling_notes: string;
  preferences: Record<string, unknown>;
  constraints: Record<string, unknown>;
  cohort_id: string | null;
  cohort_label: string | null;
  /** Null unless the caller holds `residents.contact_info`. */
  phone: string | null;
  upcoming_shifts: number;
}

/**
 * The roster.
 *
 * `phone` is selected **only** when the caller holds
 * `residents.contact_info`. The guard is in the query rather than in the
 * template that renders it: a screen can forget to hide a field, and a payload
 * that never contained the number cannot leak it to a client that inspects the
 * response.
 */
export async function listRoster(context: AuthedContext): Promise<RosterResident[]> {
  const mayReadPhone = can(context.user.role, "residents.contact_info");
  const phone = mayReadPhone ? "r.phone" : "NULL::text";

  return query<RosterResident>(
    `SELECT r.id, r.user_id, u.full_name AS name, u.email, r.pgy_level,
            r.graduation_year, r.credentials, r.active, r.schedulable,
            r.scheduling_notes, r.preferences, r.constraints,
            ${phone} AS phone,
            c.id AS cohort_id, c.label AS cohort_label,
            (SELECT count(*) FROM shifts s
               JOIN shift_assignments a
                 ON a.shift_id = s.id AND a.assignment_status = 'active'
              WHERE a.resident_id = r.id AND s.schedule_version_id IS NULL
                AND s.end_datetime >= now() AND s.status <> 'cancelled')::int
              AS upcoming_shifts
       FROM residents r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN cohort_members m ON m.resident_id = r.id
       LEFT JOIN cohorts c ON c.id = m.cohort_id AND c.active = true
      WHERE r.program_id = $1
      ORDER BY r.pgy_level, u.full_name`,
    [context.program.id],
  );
}

export interface SiteEligibility {
  site_id: string;
  site_name: string;
  eligible: boolean;
  notes: string;
}

export async function listSiteEligibility(
  programId: string,
  residentId: string,
): Promise<SiteEligibility[]> {
  /* Every site, with the recorded answer where there is one. A site with no row
     is shown as eligible: absence means "nothing recorded", and defaulting to
     ineligible would make a programme that has never opened this screen look
     like nobody can work anywhere. */
  return query<SiteEligibility>(
    `SELECT s.id AS site_id, s.name AS site_name,
            COALESCE(e.eligible, true) AS eligible,
            COALESCE(e.notes, '') AS notes
       FROM sites s
       LEFT JOIN resident_site_eligibility e
         ON e.site_id = s.id AND e.resident_id = $2
      WHERE s.program_id = $1 AND s.active = true
      ORDER BY lower(s.name)`,
    [programId, residentId],
  );
}

export async function setSiteEligibility(
  context: AuthedContext,
  residentId: string,
  siteId: string,
  eligible: boolean,
  notes = "",
): Promise<void> {
  const resident = await queryOne<{ id: string }>(
    "SELECT id FROM residents WHERE id = $1 AND program_id = $2",
    [residentId, context.program.id],
  );
  if (!resident) throw notFound("That resident is not in your program.");

  const site = await queryOne<{ id: string }>(
    "SELECT id FROM sites WHERE id = $1 AND program_id = $2",
    [siteId, context.program.id],
  );
  if (!site) throw notFound("That site no longer exists.");

  await query(
    `INSERT INTO resident_site_eligibility (resident_id, site_id, eligible, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (resident_id, site_id) DO UPDATE
       SET eligible = EXCLUDED.eligible, notes = EXCLUDED.notes`,
    [residentId, siteId, eligible, notes],
  );
}

export interface SchedulingPatch {
  phone?: string;
  pgyLevel?: number;
  schedulable?: boolean;
  schedulingNotes?: string;
  preferences?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
}

export async function updateSchedulingData(
  context: AuthedContext,
  residentId: string,
  patch: SchedulingPatch,
): Promise<RosterResident> {
  return withTransaction(async (client) => {
    const existing = await queryOne<{ id: string; pgy_level: number; name: string }>(
      `SELECT r.id, r.pgy_level, u.full_name AS name
         FROM residents r JOIN users u ON u.id = r.user_id
        WHERE r.id = $1 AND r.program_id = $2 FOR UPDATE`,
      [residentId, context.program.id],
      client,
    );
    if (!existing) throw notFound("That resident is not in your program.");

    const phone = patch.phone === undefined ? undefined : normalisePhone(patch.phone);

    if (patch.pgyLevel !== undefined) {
      if (!Number.isInteger(patch.pgyLevel) || patch.pgyLevel < 1 || patch.pgyLevel > 10) {
        throw validationFailed("Choose a PGY level between 1 and 10.");
      }
      /* Changing PGY while in a cohort of a different level would leave the
         cohort holding somebody it should not. Refused with the fix named,
         rather than silently removing them from the cohort. */
      if (patch.pgyLevel !== existing.pgy_level) {
        const cohort = await queryOne<{ label: string; pgy_level: number }>(
          `SELECT c.label, c.pgy_level FROM cohort_members m
             JOIN cohorts c ON c.id = m.cohort_id
            WHERE m.resident_id = $1 AND c.active = true`,
          [residentId],
          client,
        );
        if (cohort && cohort.pgy_level !== patch.pgyLevel) {
          throw validationFailed(
            `${existing.name} is in "${cohort.label}", a PGY-${cohort.pgy_level} cohort. ` +
              "Remove them from it before changing their training level.",
          );
        }
      }
    }

    await query(
      `UPDATE residents
          SET phone = COALESCE($2, phone),
              pgy_level = COALESCE($3, pgy_level),
              schedulable = COALESCE($4, schedulable),
              scheduling_notes = COALESCE($5, scheduling_notes),
              preferences = COALESCE($6::jsonb, preferences),
              constraints = COALESCE($7::jsonb, constraints)
        WHERE id = $1`,
      [
        residentId,
        phone ?? null,
        patch.pgyLevel ?? null,
        patch.schedulable ?? null,
        patch.schedulingNotes ?? null,
        patch.preferences ? JSON.stringify(patch.preferences) : null,
        patch.constraints ? JSON.stringify(patch.constraints) : null,
      ],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "resident.scheduling_updated",
        entityType: "resident",
        entityId: residentId,
        /* The number itself is never written to the audit log — recording who
           changed it is the point, and copying it here would put it somewhere
           the capability check does not reach. */
        newState: {
          resident: existing.name,
          phoneChanged: phone !== undefined,
          schedulable: patch.schedulable,
          pgyLevel: patch.pgyLevel,
        },
      },
      client,
    );

    const updated = await queryOne<RosterResident>(
      `SELECT r.id, r.user_id, u.full_name AS name, u.email, r.pgy_level,
              r.graduation_year, r.credentials, r.active, r.schedulable,
              r.scheduling_notes, r.preferences, r.constraints,
              ${can(context.user.role, "residents.contact_info") ? "r.phone" : "NULL::text"} AS phone,
              c.id AS cohort_id, c.label AS cohort_label, 0 AS upcoming_shifts
         FROM residents r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN cohort_members m ON m.resident_id = r.id
         LEFT JOIN cohorts c ON c.id = m.cohort_id AND c.active = true
        WHERE r.id = $1`,
      [residentId],
      client,
    );
    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export interface Site {
  id: string;
  program_id: string;
  name: string;
  abbreviation: string;
  timezone: string | null;
  address: string;
  notes: string;
  active: boolean;
  service_count: number;
}

export async function listSites(programId: string): Promise<Site[]> {
  return query<Site>(
    `SELECT s.*, (SELECT count(*) FROM services v WHERE v.site_id = s.id)::int
              AS service_count
       FROM sites s WHERE s.program_id = $1
      ORDER BY s.active DESC, lower(s.name)`,
    [programId],
  );
}

export async function createSite(
  context: AuthedContext,
  input: { name: string; abbreviation?: string; address?: string; notes?: string },
): Promise<Site> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw validationFailed("Give the site a name.");

  return withTransaction(async (client) => {
    await query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`site:${context.program.id}:${name.toLowerCase()}`],
      client,
    );
    const clash = await queryOne<{ name: string }>(
      "SELECT name FROM sites WHERE program_id = $1 AND lower(name) = lower($2)",
      [context.program.id, name],
      client,
    );
    if (clash) throw validationFailed(`Your program already has a site called "${clash.name}".`);

    const created = (await queryOne<{ id: string }>(
      `INSERT INTO sites (program_id, name, abbreviation, address, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        context.program.id,
        name,
        input.abbreviation ?? "",
        input.address ?? "",
        input.notes ?? "",
      ],
      client,
    ))!;

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "site.created",
        entityType: "site",
        entityId: created.id,
        newState: { name },
      },
      client,
    );

    return (await queryOne<Site>(
      `SELECT s.*, 0 AS service_count FROM sites s WHERE s.id = $1`,
      [created.id],
      client,
    ))!;
  });
}
