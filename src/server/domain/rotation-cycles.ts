import { query, queryOne, type Queryable } from "@/server/db/pool";
import { validationFailed } from "@/server/http/errors";

/**
 * Where somebody is in a rotation cycle on a given day.
 *
 * ## Why a cycle and not a week
 *
 * Because the real schedules are not weekly. Days off rotate: MICU is off
 * Saturday, VA general medicine off Wednesday one week and Saturday the next,
 * nights off Monday and Saturday then Thursday. VA MICU is annotated *q3
 * 24-hour call*, which is a three-day cycle that walks through the week and
 * lines up with it only every three weeks.
 *
 * A weekday/weekend table can express none of that. A cycle can express all of
 * it, including the weekly case: a service that genuinely runs Monday to Friday
 * is a seven-day cycle whose last two states are `off`. Seven is one case, not
 * the model.
 *
 * ## The whole calculation
 *
 * Three inputs — an anchor date, an ordered list of states, and a per-person
 * offset — and one modulo. Everything else in this file is about doing that
 * correctly across daylight saving and about refusing input that would make it
 * meaningless.
 *
 * ## Dates here are calendar dates, deliberately
 *
 * A cycle counts *days*, not 24-hour periods, and those differ twice a year.
 * Working in `YYYY-MM-DD` and counting civil days means the Sunday a clock
 * changes advances the cycle by exactly one, which is what a person means by
 * "tomorrow I'm post-call".
 */

export type RotationState =
  | "on"
  | "pre"
  | "post"
  | "off"
  | "late"
  | "night"
  | "clinic";

export const ROTATION_STATES: readonly RotationState[] = [
  "on",
  "pre",
  "post",
  "off",
  "late",
  "night",
  "clinic",
];

/** How each state reads on a screen. Never the bare enum. */
export const ROTATION_STATE_LABEL: Record<RotationState, string> = {
  on: "On",
  pre: "Pre-call",
  post: "Post-call",
  off: "Off",
  late: "Late",
  night: "Night",
  clinic: "Clinic",
};

/**
 * Every column of `rotation_patterns`, with the one that needs help.
 *
 * `states` is `rotation_state[]` — an array of a *custom enum*, whose type OID
 * `pg` does not know, so it hands back the literal text `{on,post,pre}` rather
 * than an array. Indexing into that returns `"{"`, and the symptom is a
 * resident told they are `{` on a day they are on call.
 *
 * Casting to `text[]` in the query is what makes it an array again. It is
 * spelled out in every read rather than left to `SELECT *`, because the version
 * of this that only appears at run time is the one that shipped.
 */
const PATTERN_COLUMNS = `
  id, program_id, service_id, name, cycle_days,
  states::text[] AS states,
  anchor_date, provenance, confirmed_by, confirmed_at, notes, active,
  created_at, updated_at
`;

export interface RotationPattern {
  id: string;
  program_id: string;
  service_id: string | null;
  name: string;
  cycle_days: number;
  states: RotationState[];
  anchor_date: Date;
  provenance: "stated" | "assumed" | "confirmed";
  notes: string;
  active: boolean;
}

/** Days between two calendar dates, counted as civil days. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

/** `YYYY-MM-DD` for a Date, or a passthrough for a string already in that form. */
export function isoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * The state a person is in on one date.
 *
 * A negative modulo is the bug this would otherwise have: a date before the
 * anchor produces a negative index in every naive implementation, and the
 * symptom is a resident being told they are off on a day they are on call.
 */
export function stateOn(
  pattern: Pick<RotationPattern, "states" | "anchor_date">,
  date: Date | string,
  offsetDays = 0,
): RotationState {
  /* Loud rather than silent. If a query ever forgets the `::text[]` cast,
     `states` arrives as the string "{on,post,pre}" — which has a `.length`, and
     indexes to "{" — and the symptom is a resident told they are off on a day
     they are on call. There is no version of that worth degrading gracefully
     into. */
  if (!Array.isArray(pattern.states)) {
    throw new Error(
      "A rotation pattern's states came back as text rather than an array. The query that read it is missing its ::text[] cast.",
    );
  }
  const length = pattern.states.length;
  if (length === 0) {
    throw validationFailed("That rotation pattern has no days in it.");
  }
  const elapsed = daysBetween(isoDate(pattern.anchor_date), isoDate(date)) + offsetDays;
  const index = ((elapsed % length) + length) % length;
  return pattern.states[index];
}

/** Every date in a range with the state the person is in, in order. */
export function statesOver(
  pattern: Pick<RotationPattern, "states" | "anchor_date">,
  from: Date | string,
  to: Date | string,
  offsetDays = 0,
): Array<{ date: string; state: RotationState }> {
  const start = isoDate(from);
  const total = daysBetween(start, isoDate(to));
  if (total < 0) return [];
  const out: Array<{ date: string; state: RotationState }> = [];
  for (let day = 0; day <= total; day += 1) {
    const date = addDays(start, day);
    out.push({ date, state: stateOn(pattern, date, offsetDays) });
  }
  return out;
}

export function addDays(date: string, days: number): string {
  const at = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * What a q3 call cycle is, since it is the example the programme's own document
 * gives and the one the beta has to reproduce.
 *
 * Three days: on call, post-call, pre-call, repeating. Somebody on it works
 * every day — the cycle says *which kind* of day, not whether they are working
 * — which is exactly why `pre` and `post` are states of their own rather than
 * flavours of `on`.
 */
export function q3CallCycle(): RotationState[] {
  return ["on", "post", "pre"];
}

/** The states a Monday-to-Friday service has, for the case that really is weekly. */
export function weekdayCycle(): RotationState[] {
  return ["on", "on", "on", "on", "on", "off", "off"];
}

export interface CreatePatternInput {
  programId: string;
  serviceId?: string | null;
  name: string;
  states: RotationState[];
  anchorDate: string;
  provenance?: "stated" | "assumed";
  notes?: string;
}

/**
 * Creates a pattern, refusing the shapes that would be silently wrong later.
 *
 * `cycle_days` is stored rather than derived so a reader of the table can see
 * what was meant, but it is *set* from the states rather than accepted from the
 * caller: two sources of truth for the same number is how a nine-day cycle ends
 * up labelled q3.
 */
export async function createRotationPattern(
  input: CreatePatternInput,
  executor?: Queryable,
): Promise<RotationPattern> {
  const name = input.name.trim();
  if (!name) throw validationFailed("A rotation pattern needs a name.");
  if (input.states.length === 0) {
    throw validationFailed(
      "A rotation pattern needs at least one day in its cycle. A q3 call cycle is three: on, post-call, pre-call.",
    );
  }
  if (input.states.length > 366) {
    throw validationFailed("A rotation cycle cannot be longer than a year.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate)) {
    throw validationFailed("The cycle's start date must be a calendar date.");
  }

  const row = await queryOne<RotationPattern>(
    `INSERT INTO rotation_patterns
       (program_id, service_id, name, cycle_days, states, anchor_date, provenance, notes)
     VALUES ($1, $2, $3, $4, $5::rotation_state[], $6, $7, $8)
     RETURNING ${PATTERN_COLUMNS}`,
    [
      input.programId,
      input.serviceId ?? null,
      name,
      input.states.length,
      input.states,
      input.anchorDate,
      input.provenance ?? "assumed",
      input.notes ?? "",
    ],
    executor,
  );
  return row!;
}

export async function listRotationPatterns(
  programId: string,
  executor?: Queryable,
): Promise<RotationPattern[]> {
  return query<RotationPattern>(
    `SELECT ${PATTERN_COLUMNS} FROM rotation_patterns
      WHERE program_id = $1 AND active
      ORDER BY name`,
    [programId],
    executor,
  );
}

/** Puts a resident into a pattern at a given offset. */
export async function setPatternMember(
  patternId: string,
  residentId: string,
  offsetDays: number,
  teamId?: string | null,
  executor?: Queryable,
): Promise<void> {
  if (!Number.isInteger(offsetDays) || offsetDays < 0) {
    throw validationFailed("An offset is a whole number of days, zero or more.");
  }
  await query(
    `INSERT INTO rotation_pattern_members (pattern_id, resident_id, offset_days, team_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pattern_id, resident_id)
     DO UPDATE SET offset_days = EXCLUDED.offset_days, team_id = EXCLUDED.team_id`,
    [patternId, residentId, offsetDays, teamId ?? null],
    executor,
  );
}

export interface PatternException {
  id: string;
  starts_on: Date;
  ends_on: Date;
  replacement_states: RotationState[] | null;
  reason: string;
}

/**
 * The pattern with its exceptions applied over a window.
 *
 * An exception with no replacement states means *nothing applies here* — the
 * winter holiday fortnight, whose roster is entered by hand. Those days come
 * back as `null` rather than as `off`, because "nobody has said" and "this
 * person is off" are different facts and only one of them is safe to schedule
 * against.
 */
export function applyExceptions(
  days: Array<{ date: string; state: RotationState }>,
  exceptions: PatternException[],
): Array<{ date: string; state: RotationState | null; exception?: string }> {
  return days.map((day) => {
    const hit = exceptions.find(
      (exception) =>
        isoDate(exception.starts_on) <= day.date && day.date <= isoDate(exception.ends_on),
    );
    if (!hit) return day;
    if (!hit.replacement_states || hit.replacement_states.length === 0) {
      return { date: day.date, state: null, exception: hit.reason };
    }
    const elapsed = daysBetween(isoDate(hit.starts_on), day.date);
    const states = hit.replacement_states;
    return {
      date: day.date,
      state: states[((elapsed % states.length) + states.length) % states.length],
      exception: hit.reason,
    };
  });
}

export async function listExceptions(
  programId: string,
  from: string,
  to: string,
  executor?: Queryable,
): Promise<PatternException[]> {
  return query<PatternException>(
    `SELECT id, starts_on, ends_on, replacement_states::text[] AS replacement_states, reason
       FROM pattern_exceptions
      WHERE program_id = $1 AND starts_on <= $3 AND ends_on >= $2
      ORDER BY starts_on`,
    [programId, from, to],
    executor,
  );
}

export interface CreateExceptionInput {
  programId: string;
  patternId?: string | null;
  serviceId?: string | null;
  residentId?: string | null;
  startsOn: string;
  endsOn: string;
  /** Null means *nothing applies here* — see `applyExceptions`. */
  replacementStates?: RotationState[] | null;
  reason: string;
}

/**
 * Suspends a pattern over a range, and says why.
 *
 * The worked example is the winter holiday block: a fortnight with its own
 * per-service rosters, entered by hand, replacing the normal cycle. It is
 * stored as an exception rather than by editing the pattern it suspends,
 * because a pattern quietly edited in December is a pattern nobody can explain
 * in March — and because the fortnight ends, and the cycle underneath it has to
 * come back on its own.
 *
 * A reason is mandatory at the database level as well as here. An override
 * without one is a change nobody can account for later, which is the thing this
 * table exists to prevent.
 */
export async function createPatternException(
  input: CreateExceptionInput,
  createdBy: string,
  executor?: Queryable,
): Promise<PatternException> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw validationFailed(
      "Say why this range is different — a holiday block, a conference, a leave cover. Somebody reading the schedule in March needs to know.",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn)) {
    throw validationFailed("Both dates must be calendar dates.");
  }
  if (input.endsOn < input.startsOn) {
    throw validationFailed("The range ends before it starts.");
  }
  if (daysBetween(input.startsOn, input.endsOn) > 366) {
    throw validationFailed("An override cannot be longer than a year.");
  }
  if (!input.patternId && !input.serviceId && !input.residentId) {
    throw validationFailed(
      "An override has to apply to something: a cycle, a service, or one person.",
    );
  }

  const row = await queryOne<PatternException>(
    `INSERT INTO pattern_exceptions
       (program_id, pattern_id, service_id, resident_id, starts_on, ends_on,
        replacement_states, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::rotation_state[], $8, $9)
     RETURNING id, starts_on, ends_on,
               replacement_states::text[] AS replacement_states, reason`,
    [
      input.programId,
      input.patternId ?? null,
      input.serviceId ?? null,
      input.residentId ?? null,
      input.startsOn,
      input.endsOn,
      input.replacementStates && input.replacementStates.length > 0
        ? input.replacementStates
        : null,
      reason,
      createdBy,
    ],
    executor,
  );
  return row!;
}

export async function deletePatternException(
  programId: string,
  id: string,
  executor?: Queryable,
): Promise<boolean> {
  const removed = await query<{ id: string }>(
    "DELETE FROM pattern_exceptions WHERE id = $1 AND program_id = $2 RETURNING id",
    [id, programId],
    executor,
  );
  return removed.length > 0;
}

export interface ExceptionView extends PatternException {
  pattern_name: string | null;
  service_name: string | null;
  resident_name: string | null;
}

/** Every override in a program, most recent range first. */
export async function listAllExceptions(
  programId: string,
  executor?: Queryable,
): Promise<ExceptionView[]> {
  return query<ExceptionView>(
    `SELECT e.id, e.starts_on, e.ends_on,
            e.replacement_states::text[] AS replacement_states, e.reason,
            p.name AS pattern_name, s.name AS service_name, u.full_name AS resident_name
       FROM pattern_exceptions e
       LEFT JOIN rotation_patterns p ON p.id = e.pattern_id
       LEFT JOIN services s ON s.id = e.service_id
       LEFT JOIN residents r ON r.id = e.resident_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE e.program_id = $1
      ORDER BY e.starts_on DESC`,
    [programId],
    executor,
  );
}

/**
 * The winter holiday fortnight, as the shape most programmes want.
 *
 * Offered as a starting point because every programme has one and every one of
 * them enters it by hand — and because an override with **no** replacement
 * states is the correct representation of "this roster is decided elsewhere",
 * which is not obvious and is easy to get wrong by writing `off` instead.
 */
export function winterHolidayRange(academicYear: number): {
  startsOn: string;
  endsOn: string;
  reason: string;
} {
  return {
    startsOn: `${academicYear}-12-22`,
    endsOn: `${academicYear + 1}-01-02`,
    reason: "Winter holiday block — roster entered by hand",
  };
}
