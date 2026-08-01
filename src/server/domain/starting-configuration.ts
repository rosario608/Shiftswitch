import { query, queryOne, withTransaction, type Queryable } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { forbidden, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { resolveServiceId } from "./shift-write";
import {
  createRotationPattern,
  q3CallCycle,
  weekdayCycle,
  type RotationState,
} from "./rotation-cycles";

/**
 * The configuration a program starts with, and where every part of it came
 * from.
 *
 * ## Two kinds of claim, and only one of them may generate anything
 *
 * Everything here is labelled:
 *
 *   **STATED** — a programme's own published document says this, in these
 *   words. "VA MICU is q3 twenty-four-hour call" is a quotation, not a guess.
 *
 *   **ASSUMED** — nobody said it and it was inferred, usually because a
 *   position needs *some* hours to be useful and the document gave none.
 *
 * An ASSUMED default is inert. The importer will not fill a blank Start from
 * it; the entry form offers it as a suggestion nobody has checked. It becomes
 * usable when a person with the authority looks at it and confirms it, which
 * takes one tap and is recorded with their name.
 *
 * The reason for the distinction is the specific way this software fails
 * badly. A wrong schedule is a clinical problem, and the wrongest schedule is
 * the confident one: three hundred shifts generated overnight from an hour
 * somebody's software invented, all looking exactly as authoritative as the
 * three hundred that came from the programme's own file. Marking the guess as a
 * guess, and refusing to build on it, is the whole mechanism.
 *
 * ## What is actually here
 *
 * The two programmes' published schedules that this was built against, reduced
 * to the parts that are structural rather than particular. Every service name
 * below appears in one of those documents; every hour that is not in them is
 * marked ASSUMED and generates nothing.
 *
 * ## The academic year is a parameter
 *
 * The two supplied documents disagree about which year they describe. That is
 * not resolved here by picking one — see the Decisions section of
 * docs/AI_PROJECT_STATE.md. `applyStartingConfiguration` takes the year, and a
 * programme applying this in June says which year they mean.
 */

export type Provenance = "stated" | "assumed" | "confirmed";

export interface StartingPosition {
  service: string;
  name: string;
  shortName: string;
  /** Wall-clock in the programme's timezone. Null when the document gives none. */
  defaultStart: string | null;
  defaultMinutes: number | null;
  defaultShiftType: string;
  pgyMin: number;
  pgyMax: number;
  provenance: Provenance;
  /** Why it is marked that way, in the words of whoever reads it next. */
  source: string;
}

export interface StartingCycle {
  service: string;
  name: string;
  states: RotationState[];
  provenance: Provenance;
  source: string;
}

export interface StartingTeam {
  service: string;
  name: string;
  sortOrder: number;
}

export interface StartingConfiguration {
  id: string;
  label: string;
  description: string;
  positions: StartingPosition[];
  cycles: StartingCycle[];
  teams: StartingTeam[];
}

const hours = (count: number) => count * 60;

/**
 * The internal-medicine shape both supplied schedules share.
 *
 * Read it as a claim about *structure* — that these services exist, that MICU
 * has two teams, that VA MICU runs on a three-day cycle — rather than as a
 * claim about hours. The hours are where the documents disagree with each
 * other and with themselves: one emergency-department code appears in a single
 * week as 10a–6p, 3p–11p, 7p–7a and 7a–7p, which is why its position ships
 * with no default at all rather than with an average.
 */
export const INTERNAL_MEDICINE: StartingConfiguration = {
  id: "internal-medicine",
  label: "Internal medicine, inpatient",
  description:
    "Services, teams and coverage cycles common to the two internal-medicine schedules this was built against. Hours are only filled in where a document actually gave them.",

  teams: [
    { service: "MICU", name: "Team A", sortOrder: 1 },
    { service: "MICU", name: "Team B", sortOrder: 2 },
    { service: "CICU", name: "Day", sortOrder: 1 },
    { service: "CICU", name: "Night", sortOrder: 2 },
  ],

  positions: [
    {
      service: "MICU",
      name: "MICU long day",
      shortName: "MICU-L",
      defaultStart: "07:00",
      defaultMinutes: hours(14),
      defaultShiftType: "day",
      pgyMin: 1,
      pgyMax: 3,
      provenance: "stated",
      source: "The block document gives MICU as 0700–2100.",
    },
    {
      service: "MICU",
      name: "MICU short day",
      shortName: "MICU-S",
      defaultStart: "07:00",
      defaultMinutes: hours(7),
      defaultShiftType: "day",
      pgyMin: 1,
      pgyMax: 3,
      provenance: "stated",
      source:
        "The same document gives the alternating short day as 0700–1400.",
    },
    {
      service: "MICU",
      name: "MICU night",
      shortName: "MICU-N",
      defaultStart: "20:00",
      defaultMinutes: hours(14),
      defaultShiftType: "night",
      pgyMin: 1,
      pgyMax: 3,
      provenance: "stated",
      source: "The following week is given as 2000–1000.",
    },
    {
      service: "VA MICU",
      name: "VA MICU call",
      shortName: "VAMICU",
      defaultStart: "07:00",
      defaultMinutes: hours(24),
      defaultShiftType: "call",
      pgyMin: 2,
      pgyMax: 3,
      provenance: "stated",
      source:
        "Annotated q3 twenty-four-hour call. The length is stated; the 0700 start is the one the rest of the document uses.",
    },
    {
      service: "CICU",
      name: "CICU day",
      shortName: "CICU-D",
      defaultStart: null,
      defaultMinutes: null,
      defaultShiftType: "day",
      pgyMin: 2,
      pgyMax: 3,
      provenance: "assumed",
      source:
        "The document says CICU runs every day of the week and splits day from night by level. It never gives the hours.",
    },
    {
      service: "CICU",
      name: "CICU night",
      shortName: "CICU-N",
      defaultStart: null,
      defaultMinutes: null,
      defaultShiftType: "night",
      pgyMin: 2,
      pgyMax: 3,
      provenance: "assumed",
      source: "As above: the split is stated, the hours are not.",
    },
    {
      service: "Emergency Department",
      name: "Emergency Department shift",
      shortName: "ED",
      /* Deliberately empty. In one week this code appears as 10a–6p, 3p–11p,
         7p–7a and 7a–7p. There is no default that is not a lie about three of
         them, and a position with no default asks rather than guesses. */
      defaultStart: null,
      defaultMinutes: null,
      defaultShiftType: "day",
      pgyMin: 1,
      pgyMax: 3,
      provenance: "stated",
      source:
        "Stated to have no fixed hours: one week shows this code as 10a–6p, 3p–11p, 7p–7a and 7a–7p.",
    },
    {
      service: "Wards",
      name: "Ward day",
      shortName: "WARD",
      defaultStart: null,
      defaultMinutes: null,
      defaultShiftType: "day",
      pgyMin: 1,
      pgyMax: 3,
      provenance: "assumed",
      source: "The service is named throughout; no hours are given anywhere.",
    },
    {
      service: "Consults",
      name: "Consults",
      shortName: "CONS",
      defaultStart: null,
      defaultMinutes: null,
      defaultShiftType: "day",
      pgyMin: 2,
      pgyMax: 3,
      provenance: "assumed",
      source:
        "Stated to run every day of the week. The hours are not given.",
    },
    {
      service: "Clinic",
      name: "Continuity clinic",
      shortName: "CLIN",
      defaultStart: null,
      defaultMinutes: null,
      defaultShiftType: "clinic",
      pgyMin: 1,
      pgyMax: 3,
      provenance: "assumed",
      source: "Named as a half-day, without saying which half.",
    },
  ],

  cycles: [
    {
      service: "VA MICU",
      name: "VA MICU q3 call",
      states: q3CallCycle(),
      provenance: "stated",
      source:
        "Annotated q3 twenty-four-hour call: on, post-call, pre-call, repeating. Somebody on it works every day — the cycle says which kind of day.",
    },
    {
      service: "MICU",
      name: "MICU, Saturday off",
      /* Anchored to a Monday when applied, so the sixth position is Saturday. */
      states: ["on", "on", "on", "on", "on", "off", "on"],
      provenance: "stated",
      source: "The document gives MICU as off Saturday.",
    },
    {
      service: "VA General Medicine",
      name: "VA general medicine, rotating day off",
      /* Fourteen days: off Wednesday in the first week, Saturday in the second.
         There is no weekly table that holds this, which is the reason a cycle
         is the model and a week is one case of it. */
      states: [
        "on", "on", "off", "on", "on", "on", "on",
        "on", "on", "on", "on", "on", "off", "on",
      ],
      provenance: "stated",
      source:
        "Off Wednesday one week and Saturday the next — stated, and not expressible as a weekly table.",
    },
    {
      service: "Night Float",
      name: "Night float, two off then one",
      states: [
        "night", "off", "night", "night", "night", "off", "night",
        "night", "night", "off", "night", "night", "night", "night",
      ],
      provenance: "stated",
      source:
        "Off Monday and Saturday one week, then Thursday — as given in the document.",
    },
    {
      service: "CICU",
      name: "CICU, every day",
      states: ["on", "on", "on", "on", "on", "on", "on"],
      provenance: "stated",
      source: "Stated to run every day of the week.",
    },
    {
      service: "Consults",
      name: "Consults, every day",
      states: ["on", "on", "on", "on", "on", "on", "on"],
      provenance: "stated",
      source: "Stated to run every day of the week.",
    },
    {
      service: "Clinic",
      name: "Clinic, weekdays",
      states: weekdayCycle(),
      provenance: "assumed",
      source:
        "Continuity clinic is named without a pattern. Monday to Friday is the ordinary shape and nobody has said so.",
    },
  ],
};

export const STARTING_CONFIGURATIONS: StartingConfiguration[] = [INTERNAL_MEDICINE];

export function findStartingConfiguration(id: string): StartingConfiguration | null {
  return STARTING_CONFIGURATIONS.find((entry) => entry.id === id) ?? null;
}

export interface ApplyResult {
  services: number;
  positions: number;
  teams: number;
  cycles: number;
  /** How many of the above nobody has vouched for, and so cannot generate. */
  assumed: number;
}

/**
 * Writes a starting configuration into a program.
 *
 * The anchor for every cycle is the Monday on or after the year's start, so a
 * seven-day cycle's sixth position really is Saturday. A cycle whose anchor
 * landed on an arbitrary day would put "off Saturday" on a Tuesday, which is
 * the kind of wrong that looks right in a database and wrong on a phone.
 *
 * Idempotent per program: applying it twice does not duplicate anything, and
 * never overwrites a position somebody has already confirmed. Somebody who
 * pressed the button, corrected the CICU hours, and pressed it again expects
 * their correction to survive.
 */
export async function applyStartingConfiguration(
  context: AuthedContext,
  input: { id: string; academicYear: number },
): Promise<ApplyResult> {
  if (!can(context.user.role, "services.manage")) {
    throw forbidden("Setting up a program's services is done by program leadership.");
  }
  const config = findStartingConfiguration(input.id);
  if (!config) throw notFound("There is no starting configuration by that name.");
  if (
    !Number.isInteger(input.academicYear) ||
    input.academicYear < 2000 ||
    input.academicYear > 2100
  ) {
    throw validationFailed(
      "Say which academic year this is, by the calendar year it starts in — 2026 for the 2026–27 year.",
    );
  }

  const anchor = mondayOnOrAfter(`${input.academicYear}-07-01`);

  return withTransaction(async (client) => {
    const result: ApplyResult = {
      services: 0,
      positions: 0,
      teams: 0,
      cycles: 0,
      assumed: 0,
    };
    const serviceIds = new Map<string, string>();

    const serviceNames = new Set([
      ...config.positions.map((entry) => entry.service),
      ...config.cycles.map((entry) => entry.service),
      ...config.teams.map((entry) => entry.service),
    ]);
    for (const name of serviceNames) {
      const resolved = await resolveServiceId(context.program.id, name, client, serviceIds);
      if (resolved.created) result.services += 1;
    }

    const teamIds = new Map<string, string>();
    for (const team of config.teams) {
      const serviceId = serviceIds.get(team.service.toLowerCase())!;
      const row = await queryOne<{ id: string }>(
        `INSERT INTO teams (program_id, service_id, name, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [context.program.id, serviceId, team.name, team.sortOrder],
        client,
      );
      if (row) result.teams += 1;
      teamIds.set(`${team.service}/${team.name}`.toLowerCase(), row?.id ?? "");
    }

    for (const position of config.positions) {
      const serviceId = serviceIds.get(position.service.toLowerCase())!;
      /* Never over a confirmed one. Somebody who has already looked at the CICU
         hours and said yes must not lose that by pressing the button again. */
      const existing = await queryOne<{ id: string; provenance: string }>(
        "SELECT id, provenance FROM positions WHERE service_id = $1 AND lower(name) = $2 AND active",
        [serviceId, position.name.toLowerCase()],
        client,
      );
      if (existing) {
        if (existing.provenance === "assumed") result.assumed += 1;
        continue;
      }
      await query(
        `INSERT INTO positions
           (program_id, service_id, name, short_name, default_start, default_minutes,
            default_shift_type, required_pgy_min, required_pgy_max, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          context.program.id,
          serviceId,
          position.name,
          position.shortName,
          position.defaultStart,
          position.defaultMinutes,
          position.defaultShiftType,
          position.pgyMin,
          position.pgyMax,
          position.provenance,
        ],
        client,
      );
      result.positions += 1;
      if (position.provenance === "assumed") result.assumed += 1;
    }

    for (const cycle of config.cycles) {
      const serviceId = serviceIds.get(cycle.service.toLowerCase())!;
      const existing = await queryOne<{ id: string }>(
        "SELECT id FROM rotation_patterns WHERE service_id = $1 AND name = $2 AND active",
        [serviceId, cycle.name],
        client,
      );
      if (existing) continue;
      await createRotationPattern(
        {
          programId: context.program.id,
          serviceId,
          name: cycle.name,
          states: cycle.states,
          anchorDate: anchor,
          provenance: cycle.provenance === "confirmed" ? "stated" : cycle.provenance,
          notes: cycle.source,
        },
        client,
      );
      result.cycles += 1;
      if (cycle.provenance === "assumed") result.assumed += 1;
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "services.template_applied",
        entityType: "starting_configuration",
        entityId: config.id,
        newState: { ...result, academicYear: input.academicYear, anchor },
      },
      client,
    );

    return result;
  });
}

/** The first Monday on or after a date, as `YYYY-MM-DD`. */
export function mondayOnOrAfter(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  const day = at.getUTCDay(); // 0 = Sunday
  const forward = (8 - day) % 7;
  at.setUTCDate(at.getUTCDate() + forward);
  return at.toISOString().slice(0, 10);
}

export interface UnconfirmedDefault {
  kind: "position" | "cycle";
  id: string;
  service_name: string;
  name: string;
  summary: string;
  notes: string;
}

/**
 * Everything shipped as a guess that nobody has looked at.
 *
 * This is the list the product owes a programme before it generates anything: a
 * default nobody has checked is a default that must not turn into a month of
 * somebody's life.
 */
export async function listUnconfirmedDefaults(
  programId: string,
  executor?: Queryable,
): Promise<UnconfirmedDefault[]> {
  const positions = await query<UnconfirmedDefault>(
    `SELECT 'position'::text AS kind, p.id, s.name AS service_name, p.name,
            CASE
              WHEN p.default_start IS NULL THEN 'No hours yet'
              ELSE to_char(p.default_start, 'HH24:MI') || ' for ' ||
                   round(p.default_minutes / 60.0, 1)::text || ' hours'
            END AS summary,
            ''::text AS notes
       FROM positions p JOIN services s ON s.id = p.service_id
      WHERE p.program_id = $1 AND p.active AND p.provenance = 'assumed'
      ORDER BY s.name, p.name`,
    [programId],
    executor,
  );
  const cycles = await query<UnconfirmedDefault>(
    `SELECT 'cycle'::text AS kind, r.id, coalesce(s.name, '') AS service_name, r.name,
            r.cycle_days::text || '-day cycle' AS summary,
            r.notes
       FROM rotation_patterns r LEFT JOIN services s ON s.id = r.service_id
      WHERE r.program_id = $1 AND r.active AND r.provenance = 'assumed'
      ORDER BY s.name, r.name`,
    [programId],
    executor,
  );
  return [...positions, ...cycles];
}

/**
 * Somebody with the authority saying a guessed default is right.
 *
 * The only thing that turns an ASSUMED default into one the importer will fill
 * a blank from. Recorded with their name, because "who said the CICU starts at
 * seven" is a question that gets asked in October.
 */
export async function confirmDefault(
  context: AuthedContext,
  kind: "position" | "cycle",
  id: string,
  overrides: { defaultStart?: string; defaultMinutes?: number } = {},
): Promise<void> {
  if (!can(context.user.role, "services.manage")) {
    throw forbidden("Confirming a program's defaults is done by program leadership.");
  }

  if (kind === "position") {
    if (overrides.defaultStart && !/^\d{2}:\d{2}$/.test(overrides.defaultStart)) {
      throw validationFailed("Use 24-hour, like 07:00.");
    }
    const row = await queryOne<{ id: string; default_start: string | null }>(
      `UPDATE positions
          SET default_start = COALESCE($3::time, default_start),
              default_minutes = COALESCE($4::int, default_minutes),
              provenance = 'confirmed',
              confirmed_by = $5,
              confirmed_at = now(),
              updated_at = now()
        WHERE id = $1 AND program_id = $2
      RETURNING id, to_char(default_start, 'HH24:MI') AS default_start`,
      [
        id,
        context.program.id,
        overrides.defaultStart ?? null,
        overrides.defaultMinutes ?? null,
        context.user.id,
      ],
    );
    if (!row) throw notFound("That position is not in your program.");
    /* Confirming nothing is not confirming. A position with no hours that
       somebody ticked would then be usable and still have nothing to give. */
    if (!row.default_start) {
      await query(
        `UPDATE positions SET provenance = 'assumed', confirmed_by = NULL, confirmed_at = NULL
          WHERE id = $1`,
        [id],
      );
      throw validationFailed(
        "This position has no hours yet, so there is nothing to confirm. Put its start time and length in first.",
      );
    }
  } else {
    const row = await queryOne<{ id: string }>(
      `UPDATE rotation_patterns
          SET provenance = 'confirmed', confirmed_by = $3, confirmed_at = now(),
              updated_at = now()
        WHERE id = $1 AND program_id = $2
      RETURNING id`,
      [id, context.program.id, context.user.id],
    );
    if (!row) throw notFound("That cycle is not in your program.");
  }

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "service.updated",
    entityType: kind,
    entityId: id,
    newState: { provenance: "confirmed", ...overrides },
  });
}
