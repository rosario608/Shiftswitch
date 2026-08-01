import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { validationFailed } from "@/server/http/errors";
import { recordAudit } from "@/server/domain/audit";
import { loadScheduleSnapshot } from "@/server/domain/constraints/snapshot";
import type { ScheduleAssignment } from "@/server/domain/constraints/types";
import { createScheduleVersion } from "@/server/domain/schedule-versions";
import { zonedWallTimeToInstant } from "@/server/domain/time";
import { assignmentsToRecords } from "./source";
import { generateSchedule } from "./generate";
import type { GenerationResult, Lock } from "./types";

/**
 * Running the generator against a real programme, and keeping what it made.
 *
 * The impure half. Everything decided here is a *policy* decision about the
 * product rather than about scheduling:
 *
 *   - a generated schedule always lands in a **draft**, never in the live
 *     schedule. There is no option to publish directly and there should not be;
 *   - an infeasible run writes nothing at all, not even the version row, so a
 *     failed attempt leaves no half-built draft for somebody to find and
 *     publish;
 *   - the budget is configuration with a default small enough that
 *     `npm run verify` finishes, because a test suite that takes a minute per
 *     generation is a test suite that gets skipped.
 */

/**
 * Two seconds.
 *
 * Long enough for the improvement phase to make a visible difference on a
 * month, short enough that the integration suite runs a dozen generations
 * without anybody noticing. A programme that wants a better schedule and has
 * the patience raises it; nothing in the code assumes this number.
 */
export const DEFAULT_TIME_BUDGET_MS = 2_000;

/** Hard ceiling, so a request cannot pin a worker for an afternoon. */
export const MAX_TIME_BUDGET_MS = 60_000;

export interface GenerateDraftInput {
  name: string;
  periodStart: string;
  periodEnd: string;
  seed?: number;
  timeBudgetMs?: number;
  locks?: Lock[];
  notes?: string;
  /**
   * Regenerate into an existing draft rather than creating one. Its unlocked
   * shifts are replaced; the locked ones survive.
   */
  versionId?: string | null;
}

export interface GenerateDraftResult extends GenerationResult {
  /** Null when the run was infeasible — nothing was written. */
  versionId: string | null;
  versionName: string | null;
}

export async function generateDraftSchedule(
  context: AuthedContext,
  input: GenerateDraftInput,
): Promise<GenerateDraftResult> {
  if (input.periodEnd < input.periodStart) {
    throw validationFailed("The period ends before it starts.");
  }
  const budget = Math.min(
    Math.max(input.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS, 0),
    MAX_TIME_BUDGET_MS,
  );
  const seed = input.seed ?? 1;
  const locks = input.locks ?? [];
  const period = { start: input.periodStart, end: input.periodEnd };

  const program = {
    id: context.program.id,
    name: context.program.name,
    timezone: context.program.timezone,
  };

  /* The snapshot is loaded from the *live* schedule for eligibility, and from
     the draft being regenerated for what already exists. Both matter: a
     resident's leave is a fact about them wherever it was recorded, and a
     locked shift only exists inside the draft. */
  const snapshot = await loadScheduleSnapshot(program, {
    period,
    versionId: input.versionId ?? null,
  });

  const existing: ScheduleAssignment[] = input.versionId ? snapshot.assignments : [];

  const result = generateSchedule(
    /* The generator is handed a snapshot with no assignments: it is building
       the schedule, not editing one. What survives from the draft arrives
       through `existing`, and only if a lock protects it. */
    { ...snapshot, assignments: [] },
    { period, seed, timeBudgetMs: budget, locks, existing },
  );

  if (!result.feasible) {
    return { ...result, versionId: null, versionName: null };
  }

  const version = input.versionId
    ? await requireDraft(context, input.versionId)
    : await createScheduleVersion(context, {
        name: input.name,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        notes: input.notes ?? `Generated with seed ${seed}.`,
      });

  await persist(context, version.id, result.assignments, snapshot);

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "schedule_version.generated",
    entityType: "schedule_version",
    entityId: version.id,
    newState: {
      seed,
      slots: result.report.demand.slots,
      filled: result.report.demand.filled,
      locked: result.report.demand.locked,
      score: result.report.score.score,
      stoppedOnBudget: result.report.stoppedOnBudget,
    },
  });

  return { ...result, versionId: version.id, versionName: version.name };
}

async function requireDraft(context: AuthedContext, versionId: string) {
  const version = await queryOne<{ id: string; name: string; status: string }>(
    `SELECT id, name, status::text AS status FROM schedule_versions
      WHERE id = $1 AND program_id = $2`,
    [versionId, context.program.id],
  );
  if (!version) throw validationFailed("That draft no longer exists.");
  if (version.status !== "draft") {
    throw validationFailed(
      "That schedule has been published and cannot be regenerated. Start a new draft.",
    );
  }
  return version;
}

/**
 * Writes the generated schedule into the draft.
 *
 * Locked shifts already in the draft are left exactly as they are — same rows,
 * same identifiers — and everything else is deleted and replaced. In one
 * transaction, so a draft is never briefly half-generated: somebody looking at
 * the screen mid-run sees the old draft or the new one, never a month with a
 * week missing.
 */
async function persist(
  context: AuthedContext,
  versionId: string,
  assignments: ScheduleAssignment[],
  snapshot: Awaited<ReturnType<typeof loadScheduleSnapshot>>,
): Promise<void> {
  /* Anything the generator created carries a `gen:` identifier; anything it
     kept carries the identifier it already had. That is the whole distinction
     between "insert this" and "leave it alone". */
  const created = assignments.filter((a) => a.shiftId.startsWith("gen:"));
  const kept = assignments
    .filter((a) => !a.shiftId.startsWith("gen:"))
    .map((a) => a.shiftId);

  const records = assignmentsToRecords(created, snapshot);
  const residentByEmail = new Map(
    snapshot.residents.map((r) => [r.email.toLowerCase(), r.id]),
  );
  const serviceByName = new Map(
    snapshot.services.map((s) => [s.name.toLowerCase(), s.id]),
  );

  await withTransaction(async (client) => {
    if (kept.length > 0) {
      await query(
        `DELETE FROM shifts
          WHERE schedule_version_id = $1 AND id <> ALL($2::uuid[])`,
        [versionId, kept],
        client,
      );
    } else {
      await query("DELETE FROM shifts WHERE schedule_version_id = $1", [versionId], client);
    }

    for (const record of records) {
      const residentId = residentByEmail.get(record.Email.toLowerCase());
      const serviceId = serviceByName.get(record.Service.toLowerCase());
      if (!residentId || !serviceId) {
        /* Cannot happen: every record came from a resident and a service in
           this same snapshot. Refused rather than skipped, because a silently
           dropped shift is a hole in a ward. */
        throw validationFailed(
          `The generated schedule referred to somebody or something that is no longer in the programme (${record.Service}). Nothing has been created.`,
        );
      }

      const start = zonedWallTimeToInstant(
        record.Date,
        record["Start time"],
        context.program.timezone,
      );
      const endDate =
        record["Ends next day"] === "yes"
          ? new Date(new Date(`${record.Date}T00:00:00Z`).getTime() + 86_400_000)
              .toISOString()
              .slice(0, 10)
          : record.Date;
      const end = zonedWallTimeToInstant(
        endDate,
        record["End time"],
        context.program.timezone,
      );

      const shift = await queryOne<{ id: string }>(
        `INSERT INTO shifts
           (program_id, service_id, date, start_datetime, end_datetime, location,
            shift_type, schedule_version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          context.program.id,
          serviceId,
          record.Date,
          start,
          end,
          record.Location ?? "",
          record["Shift type"] || "day",
          versionId,
        ],
        client,
      );
      await query(
        "INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)",
        [shift!.id, residentId],
        client,
      );
    }
  });
}
