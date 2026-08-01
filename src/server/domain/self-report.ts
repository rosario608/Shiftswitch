import { query, queryOne, withTransaction, type Queryable } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { forbidden, notFound, validationFailed } from "@/server/http/errors";
import type { ShiftDetail } from "@/server/db/types";
import { recordAudit } from "./audit";
import { SHIFT_DETAIL_SELECT } from "./schedule";
import { resolveServiceId, placeShift } from "./shift-write";
import { InvalidZonedTimeError, zonedWallTimeToInstant } from "./time";
import { DateTime } from "luxon";
import { fmtDate, fmtRange } from "@/lib/format";

/**
 * A resident entering and correcting their own shifts.
 *
 * ## Why the product needs this at all
 *
 * Because the alternative is waiting. A programme's schedule arrives when it
 * arrives; a resident who signs in before it does, or whose block was uploaded
 * with the wrong hours, has to be able to say what they are actually working —
 * or the product is useless to them for exactly as long as it takes somebody
 * else to act. "Nobody lands on an empty screen" is not a decoration on the
 * import; it is the reason this file exists.
 *
 * ## What it does not do
 *
 * It does not confirm anything. A shift somebody typed in says `self_reported`,
 * for ever, until a person with `shifts.confirm` says otherwise. That
 * distinction is the whole safety property: a resident is telling the product
 * what they believe, and everybody else gets to see that is what happened. A
 * resident who could mark their own hours confirmed would be telling the
 * programme's other forty people that the programme had checked something it
 * had not.
 *
 * ## A week at a time
 *
 * `addOwnShifts` takes a list of dates for one pattern, because the thing a
 * resident actually has is "MICU, 7 to 7, Monday through Friday" and typing
 * that five times on a phone at the end of a shift is how a feature goes
 * unused. Every date is validated against the others and against what they
 * already hold, and a conflict is described in the terms they used —
 * `Mon, Aug 10 MICU, 07:00–19:00`, never a row id and never an ISO string.
 */

export interface SelfShiftInput {
  /** One or more dates the same pattern applies to. */
  dates: string[];
  startTime: string;
  endTime: string;
  endsNextDay?: boolean;
  /** Free text: the resident names their service, and it is created if new. */
  service: string;
  location?: string;
  shiftType?: string;
}

export interface SelfReportResult {
  created: number;
  /** Dates that already had this shift and were left alone. */
  duplicates: string[];
}

function requireOwnSchedule(context: AuthedContext) {
  if (!can(context.user.role, "shifts.self_report")) {
    throw forbidden("Correcting a schedule is for the person who works it.");
  }
  if (!context.resident) {
    throw validationFailed(
      "Your account does not have a schedule attached yet. Ask your program to add you as a resident.",
    );
  }
  return context.resident;
}

/** `HH:MM`, or a clear refusal naming what was typed. */
export function readTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw validationFailed(
      `"${value}" is not a time. Use 24-hour, like 07:00 for 7am or 19:00 for 7pm.`,
    );
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/** The wall-clock `HH:MM` an instant lands on in the program's timezone. */
function wallTime(at: Date, zone: string): string {
  return DateTime.fromJSDate(at).setZone(zone).toFormat("HH:mm");
}

/** The calendar date an instant lands on in the program's timezone. */
function wallDate(at: Date, zone: string): string {
  return DateTime.fromJSDate(at).setZone(zone).toISODate()!;
}

export function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export interface OneShiftSpec {
  date: string;
  /** `HH:MM`, already through `readTime`. */
  startTime: string;
  endTime: string;
  endsNextDay: boolean;
  serviceId: string;
  location?: string;
  shiftType?: string;
}

/**
 * One shift the resident says they are working, written where it goes.
 *
 * Shared by the week-pattern form and by a resident naming a single shift in
 * order to post it (`./ad-hoc.ts`). Both are the same claim — *I work this* —
 * and the checks that make that claim safe (a time that exists on that date,
 * an end after its start, nothing else already in the same hours) must not be
 * two implementations that agree today. The clash message in particular is the
 * one a resident actually reads, and it earns its keep by naming the shift the
 * way the rest of the product names it.
 *
 * Returns the shift either way: an exact repeat is not an error, it is somebody
 * pressing the button twice or their programme having uploaded the block in
 * between, and the caller may well want to act on the shift that is already
 * there.
 */
export async function placeSelfReportedShift(
  context: AuthedContext,
  residentId: string,
  spec: OneShiftSpec,
  client: Queryable,
): Promise<{ outcome: "created" | "duplicate"; shiftId: string }> {
  const zone = context.program.timezone;
  let start: Date;
  let end: Date;
  try {
    start = zonedWallTimeToInstant(spec.date, spec.startTime, zone);
    end = zonedWallTimeToInstant(
      spec.endsNextDay ? nextDay(spec.date) : spec.date,
      spec.endTime,
      zone,
    );
  } catch (error) {
    throw validationFailed(
      error instanceof InvalidZonedTimeError
        ? error.message
        : `That time does not exist on ${fmtDate(`${spec.date}T12:00:00Z`, zone)} — the clocks change that night.`,
    );
  }
  if (end <= start) {
    throw validationFailed(
      "That shift ends before it starts. If it runs overnight, tick “ends the next morning”.",
    );
  }

  /* Anything they already hold that overlaps. Described the way they would
     describe it, because the useful version of this message is the one that
     makes them realise they typed the wrong week. */
  const clash = await queryOne<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE sa.resident_id = $1
        AND sa.assignment_status = 'active'
        AND s.status <> 'cancelled'
        AND s.start_datetime < $3
        AND s.end_datetime > $2
      LIMIT 1`,
    [residentId, start, end],
    client,
  );
  if (clash) {
    /* Exactly the same shift is not a clash — it is somebody pressing the
       button twice, or their programme having uploaded it in between. */
    if (
      clash.start_datetime.getTime() === start.getTime() &&
      clash.end_datetime.getTime() === end.getTime() &&
      clash.service_id === spec.serviceId
    ) {
      return { outcome: "duplicate", shiftId: clash.id };
    }
    throw validationFailed(
      `You already have ${clash.service_name} on ${fmtDate(clash.start_datetime, zone)}, ` +
        `${fmtRange(clash.start_datetime, clash.end_datetime, zone)}. ` +
        "Two shifts at once is usually the wrong date — check the day, or correct the one you have.",
    );
  }

  return placeShift(
    {
      programId: context.program.id,
      serviceId: spec.serviceId,
      residentId,
      date: spec.date,
      start,
      end,
      location: spec.location ?? "",
      shiftType: spec.shiftType || (spec.endsNextDay ? "night" : "day"),
      provenance: "self_reported",
    },
    client,
  );
}

/**
 * Adds shifts the resident says they are working.
 *
 * Everything happens in one transaction and nothing is written unless every
 * date works. A resident entering their week and being told the third day
 * failed — with the first two already saved and no way to tell which — is worse
 * than being told to fix one field and press it again.
 */
export async function addOwnShifts(
  context: AuthedContext,
  input: SelfShiftInput,
): Promise<SelfReportResult> {
  const resident = requireOwnSchedule(context);

  if (input.dates.length === 0) {
    throw validationFailed("Pick at least one day.");
  }
  if (input.dates.length > 62) {
    throw validationFailed(
      "That is more than two months at once. Enter a block at a time — it is easier to check, and easier to fix.",
    );
  }
  const service = input.service.trim();
  if (!service) {
    throw validationFailed("Say which service this is, for example MICU or Wards.");
  }

  const startTime = readTime(input.startTime);
  const endTime = readTime(input.endTime);
  const endsNextDay = input.endsNextDay ?? endTime <= startTime;

  const dates = [...new Set(input.dates)].sort();
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw validationFailed(`"${date}" is not a date.`);
    }
  }

  return withTransaction(async (client) => {
    const resolved = await resolveServiceId(context.program.id, service, client);
    const created: string[] = [];
    const duplicates: string[] = [];

    for (const date of dates) {
      const placed = await placeSelfReportedShift(
        context,
        resident.id,
        {
          date,
          startTime,
          endTime,
          endsNextDay,
          serviceId: resolved.id,
          location: input.location,
          shiftType: input.shiftType,
        },
        client,
      );
      if (placed.outcome === "duplicate") duplicates.push(date);
      else created.push(date);
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "shift.self_reported",
        entityType: "resident",
        entityId: resident.id,
        newState: {
          service,
          startTime,
          endTime,
          created: created.length,
          duplicates: duplicates.length,
        },
      },
      client,
    );

    return { created: created.length, duplicates };
  });
}

export interface CorrectionInput {
  startTime?: string;
  endTime?: string;
  endsNextDay?: boolean;
  location?: string;
}

/**
 * A resident fixing the hours on a shift they hold.
 *
 * The imported file said 07:00 and the block actually starts at 06:00 — the
 * single most common thing wrong with a schedule that came from a spreadsheet.
 * The corrected shift becomes `self_reported`: the resident's version is the
 * one everybody sees, and everybody can see that it is the resident's version.
 */
export async function correctOwnShift(
  context: AuthedContext,
  shiftId: string,
  input: CorrectionInput,
): Promise<ShiftDetail> {
  const resident = requireOwnSchedule(context);
  const zone = context.program.timezone;

  return withTransaction(async (client) => {
    const shift = await queryOne<ShiftDetail>(
      `${SHIFT_DETAIL_SELECT}
        WHERE s.id = $1 AND s.program_id = $2
        FOR UPDATE OF s`,
      [shiftId, context.program.id],
      client,
    );
    if (!shift) throw notFound("That shift is not on your schedule.");
    if (shift.resident_id !== resident.id) {
      /* Same message as a missing shift. Somebody probing ids should not learn
         which of them exist. */
      throw notFound("That shift is not on your schedule.");
    }

    /* A shift somebody has already been offered is not a shift to quietly
       change the hours of: the person who offered on it did so against what it
       said at the time. */
    const posted = await queryOne<{ id: string }>(
      `SELECT id FROM trade_requests
        WHERE source_shift_id = $1 AND status IN ('open', 'pending_approval')`,
      [shiftId],
      client,
    );
    if (posted) {
      throw validationFailed(
        "This shift is posted for a switch, so its hours cannot change while people are deciding on it. Take the post down first, then correct it.",
      );
    }

    if (!input.startTime && !input.endTime && input.location === undefined) {
      throw validationFailed("Nothing was changed.");
    }

    /* The day the shift *starts* in the programme's timezone, derived from the
       instant rather than read off `shifts.date` — the two agree today, and
       relying on that agreement is how a correction made after a clock change
       moves a shift by an hour that nobody asked for. */
    const date = wallDate(shift.start_datetime, zone);
    const startTime = input.startTime
      ? readTime(input.startTime)
      : wallTime(shift.start_datetime, zone);
    const endTime = input.endTime
      ? readTime(input.endTime)
      : wallTime(shift.end_datetime, zone);

    /* Overnight is what they said, or what the times imply, or — when only one
       field changed — what the shift already was. */
    const wasOvernight = wallDate(shift.end_datetime, zone) !== date;
    const overnight = input.endsNextDay ?? (input.endTime ? endTime <= startTime : wasOvernight);

    const start = zonedWallTimeToInstant(date, startTime, zone);
    const end = zonedWallTimeToInstant(overnight ? nextDay(date) : date, endTime, zone);
    if (end <= start) {
      throw validationFailed(
        "That shift would end before it starts. If it runs overnight, tick “ends the next morning”.",
      );
    }

    const updated = await queryOne<{ id: string }>(
      `UPDATE shifts
          SET start_datetime = $2,
              end_datetime = $3,
              location = COALESCE($4, location),
              provenance = 'self_reported',
              confirmed_by = NULL,
              confirmed_at = NULL,
              updated_at = now()
        WHERE id = $1
      RETURNING id`,
      [shiftId, start, end, input.location ?? null],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "shift.self_reported",
        entityType: "shift",
        entityId: updated!.id,
        previousState: {
          start: shift.start_datetime,
          end: shift.end_datetime,
          provenance: shift.provenance,
        },
        newState: { start, end, provenance: "self_reported" },
        reason: "Corrected by the resident who works it",
      },
      client,
    );

    const after = await queryOne<ShiftDetail>(
      `${SHIFT_DETAIL_SELECT} WHERE s.id = $1`,
      [shiftId],
      client,
    );
    return after!;
  });
}

/**
 * Somebody with the authority vouching for a shift.
 *
 * The counterpart to the two above, and deliberately in the same file: the
 * thing that makes self-reporting safe is that confirming is a different act
 * with a different capability, and keeping them apart in the codebase is how
 * they stay apart in the product.
 */
export async function confirmShift(
  context: AuthedContext,
  shiftId: string,
): Promise<ShiftDetail> {
  if (!can(context.user.role, "shifts.confirm")) {
    throw forbidden(
      "Marking a shift confirmed says the program has checked it, which is for chief residents and program leadership.",
    );
  }
  const row = await queryOne<{ id: string }>(
    `UPDATE shifts
        SET provenance = 'confirmed', confirmed_by = $3, confirmed_at = now()
      WHERE id = $1 AND program_id = $2
    RETURNING id`,
    [shiftId, context.program.id, context.user.id],
  );
  if (!row) throw notFound("That shift is not in your program.");

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "shift.confirmed",
    entityType: "shift",
    entityId: shiftId,
    newState: { provenance: "confirmed" },
  });

  const after = await queryOne<ShiftDetail>(`${SHIFT_DETAIL_SELECT} WHERE s.id = $1`, [
    shiftId,
  ]);
  return after!;
}

/* The labels live in `@/lib/views`, next to the projection that carries them:
   a client component renders them and must not pull the database pool into the
   browser to find out what a word means. Re-exported here so a reader of this
   file — where provenance is actually decided — can find them. */
export { PROVENANCE_LABEL, PROVENANCE_LABEL_OWN } from "@/lib/views";

export async function listConfirmableShifts(
  programId: string,
  limit = 100,
  executor?: Queryable,
): Promise<ShiftDetail[]> {
  return query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE s.program_id = $1
        AND s.provenance = 'self_reported'
        AND s.status <> 'cancelled'
        AND s.end_datetime >= now()
      ORDER BY s.start_datetime
      LIMIT $2`,
    [programId, limit],
    executor,
  );
}
