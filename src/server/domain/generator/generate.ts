import { scoreSchedule } from "@/server/domain/constraints/scoring";
import { validateSchedule } from "@/server/domain/constraints/validator";
import type {
  ScheduleAssignment,
  ScheduleResident,
  ScheduleSnapshot,
} from "@/server/domain/constraints/types";
import { isNightShift, isWeekendLocal, localDateString } from "@/server/domain/time";
import {
  addToLoad,
  dynamicRejection,
  emptyLoad,
  readLimits,
  staticRejection,
  type Limits,
  type ResidentLoad,
} from "./feasibility";
import { explainInfeasibility } from "./infeasible";
import { expandSlots } from "./slots";
import type {
  GenerationOptions,
  GenerationReport,
  GenerationResult,
  Lock,
  Rejection,
  Slot,
  UnfilledSlot,
} from "./types";

/**
 * Building a month.
 *
 * Two phases, and the split matters:
 *
 *   **Construction** fills every slot or fails. It is greedy, ordered
 *   most-constrained-first, and it never places somebody a hard constraint
 *   forbids. If it cannot fill a slot it stops trying to be clever and starts
 *   explaining, because a schedule with a hole in it is not a schedule.
 *
 *   **Improvement** then moves people around, keeping every hard constraint
 *   satisfied, to improve the validator's soft score. This is where fairness,
 *   nights and weekends get evened out. It runs until the time budget expires
 *   and returns the best it found.
 *
 * The output is graded by `validateSchedule` before it is returned. A run whose
 * schedule has hard violations reports infeasibility and emits nothing — the
 * generator does not get to mark its own homework.
 */

/** Mulberry32. Small, fast, and identical on every machine — which is the point. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slotToAssignment(
  slot: Slot,
  residentId: string | null,
  snapshot: ScheduleSnapshot,
): ScheduleAssignment {
  const service = snapshot.services.find((s) => s.id === slot.serviceId);
  return {
    /* Content-addressed, so two runs over the same programme produce the same
       identifiers and a diff between them is meaningful. */
    shiftId: `gen:${slot.id}`,
    residentId,
    serviceId: slot.serviceId,
    serviceName: slot.serviceName,
    siteId: slot.siteId,
    siteName: null,
    rotationId: null,
    rotationName: null,
    shiftType: slot.shiftType,
    start: slot.start,
    end: slot.end,
    location: "",
    requiredPgyMin: service?.pgyMin ?? 1,
    requiredPgyMax: service?.pgyMax ?? 10,
    status: "scheduled",
  };
}

/** Which existing assignments a lock protects. */
function isLocked(
  assignment: ScheduleAssignment,
  locks: Lock[],
  snapshot: ScheduleSnapshot,
): boolean {
  const zone = snapshot.program.timezone;
  const date = localDateString(assignment.start, zone);
  const resident = assignment.residentId
    ? snapshot.residents.find((r) => r.id === assignment.residentId)
    : null;

  return locks.some((lock) => {
    switch (lock.kind) {
      case "assignment":
        return lock.shiftId === assignment.shiftId;
      case "resident":
        return lock.residentId === assignment.residentId;
      case "cohort":
        return resident?.cohortId === lock.cohortId;
      case "service":
        return lock.serviceId === assignment.serviceId;
      case "date":
        return lock.date === date;
      default:
        return false;
    }
  });
}

/** A slot and an existing assignment describe the same place in the schedule. */
function sameSlot(assignment: ScheduleAssignment, slot: Slot): boolean {
  return (
    assignment.serviceId === slot.serviceId &&
    assignment.start.getTime() === slot.start.getTime() &&
    assignment.end.getTime() === slot.end.getTime()
  );
}

interface Placement {
  slot: Slot;
  residentId: string | null;
  locked: boolean;
  /** Locked placements keep the assignment they came from, ids and all. */
  original?: ScheduleAssignment;
}

/**
 * Two slots are the same *place* when they are the same service at the same
 * time: the three MICU places on Tuesday morning.
 *
 * Nobody can hold two of them. That is not a rule a programme configures — it
 * is arithmetic about people — so it is enforced structurally rather than left
 * to `no_overlapping_shifts`, which a programme might not have created. Without
 * it the generator satisfies "three people on the MICU" with one person three
 * times over, which is exactly what it did the first time this was run.
 */
function placeKey(slot: Slot): string {
  return `${slot.serviceId}|${slot.start.getTime()}`;
}

/**
 * How much worse this placement makes the schedule, before the validator has an
 * opinion.
 *
 * A cheap proxy used only to *order* candidates during construction: fewest
 * shifts so far, then fewest of whatever this slot is (nights, weekends), then
 * a stable tie-break on the resident's id. It is not the score — the score is
 * the validator's, and it is what the improvement phase optimises. This exists
 * because construction cannot afford to ask the validator two hundred thousand
 * times, and a greedy pass that ignores load entirely produces a first draft so
 * lopsided that no amount of local search rescues it.
 */
function constructionCost(
  resident: ScheduleResident,
  slot: Slot,
  load: ResidentLoad,
  snapshot: ScheduleSnapshot,
): number {
  const zone = snapshot.program.timezone;
  let cost = load.assignments.length * 100;
  if (isNightShift(slot.start, slot.end, zone)) cost += load.nightDates.length * 60;
  if (isWeekendLocal(slot.start, zone)) cost += load.weekendStarts.length * 60;

  /* Continuity: somebody already on this service in this block is a better
     choice than moving a third person onto it. */
  const block = snapshot.blocks.find(
    (b) => b.startDate <= slot.date && slot.date <= b.endDate,
  );
  if (block) {
    const services = load.servicesByBlock.get(block.id);
    if (services && !services.has(slot.serviceId)) cost += 40;
    if (services?.has(slot.serviceId)) cost -= 25;
  }
  return cost;
}

/** One resident's load, rebuilt from the arrangement. Their list is short. */
function loadFor(
  residentId: string,
  placements: Placement[],
  snapshot: ScheduleSnapshot,
  skip?: Placement,
): ResidentLoad {
  const load = emptyLoad();
  for (const placement of placements) {
    if (placement.residentId !== residentId || placement === skip) continue;
    addToLoad(load, slotToAssignment(placement.slot, residentId, snapshot), snapshot);
  }
  return load;
}

/**
 * One level of "move somebody aside".
 *
 * Greedy construction fills the easy slots first and occasionally paints
 * itself into a corner: the last night of a stretch has nobody left who has
 * not just worked six days, even though a shuffle two days earlier would have
 * left somebody free. Re-ranking every slot after every placement avoids it and
 * costs quadratic time — fifty seconds on a month, all of it taken from the
 * budget the improvement phase never got to spend.
 *
 * So instead: when a slot cannot be filled, look for a resident who *could*
 * take it if one of their existing shifts moved to somebody else, and make that
 * one move. Bounded, one level deep, and every step still checked against the
 * hard constraints. It closes exactly the traps greedy construction creates,
 * which on the demo programme was four slots out of two hundred.
 */
function tryRepair(
  slot: Slot,
  placements: Placement[],
  loads: Map<string, ResidentLoad>,
  heldPlaces: Map<string, Set<string>>,
  residents: ScheduleResident[],
  snapshot: ScheduleSnapshot,
  limits: Limits,
): boolean {
  const here = heldPlaces.get(placeKey(slot));

  for (const blocked of residents) {
    if (here?.has(blocked.id)) continue;
    if (staticRejection(blocked, slot, snapshot, limits)) continue;
    // Only somebody the *dynamic* rules turned away can be freed by a move.
    if (!dynamicRejection(blocked, slot, loads.get(blocked.id)!, snapshot, limits)) continue;

    for (const theirs of placements) {
      if (theirs.residentId !== blocked.id || theirs.locked) continue;

      const without = loadFor(blocked.id, placements, snapshot, theirs);
      if (dynamicRejection(blocked, slot, without, snapshot, limits)) continue;

      /* Freeing that shift would let them take this one. Now: is there
         anybody to hand the freed shift to? */
      const holders = heldPlaces.get(placeKey(theirs.slot));
      for (const taker of residents) {
        if (taker.id === blocked.id) continue;
        if (holders?.has(taker.id)) continue;
        if (staticRejection(taker, theirs.slot, snapshot, limits)) continue;
        if (dynamicRejection(taker, theirs.slot, loads.get(taker.id)!, snapshot, limits)) {
          continue;
        }

        // Apply the move, then the placement.
        holders?.delete(blocked.id);
        theirs.residentId = taker.id;
        const takerPlace = heldPlaces.get(placeKey(theirs.slot)) ?? new Set<string>();
        takerPlace.add(taker.id);
        heldPlaces.set(placeKey(theirs.slot), takerPlace);

        placements.push({ slot, residentId: blocked.id, locked: false });
        const slotPlace = heldPlaces.get(placeKey(slot)) ?? new Set<string>();
        slotPlace.add(blocked.id);
        heldPlaces.set(placeKey(slot), slotPlace);

        loads.set(blocked.id, loadFor(blocked.id, placements, snapshot));
        loads.set(taker.id, loadFor(taker.id, placements, snapshot));
        return true;
      }
    }
  }
  return false;
}

export function generateSchedule(
  snapshot: ScheduleSnapshot,
  options: GenerationOptions,
): GenerationResult {
  const started = Date.now();
  const random = seeded(options.seed);
  const limits = readLimits(snapshot.rules);
  const residents = [...snapshot.residents].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(residents.map((r) => [r.id, r]));

  const slots = expandSlots(snapshot, options.period);

  /* Locked and hand-placed assignments come first: they are facts, and the
     generator works around them rather than over them. */
  const kept = options.existing.filter(
    (a) => a.status !== "cancelled" && isLocked(a, options.locks, snapshot),
  );
  const loads = new Map<string, ResidentLoad>();
  for (const resident of residents) loads.set(resident.id, emptyLoad());
  for (const assignment of kept) {
    if (!assignment.residentId) continue;
    const load = loads.get(assignment.residentId);
    if (load) addToLoad(load, assignment, snapshot);
  }

  /* A slot a locked assignment already fills is not a slot to fill. Consumed
     one for one, so two locked people on a service that needs three leaves one
     hole rather than none. */
  const remaining: Slot[] = [];
  const consumed = new Set<string>();
  for (const slot of slots) {
    const match = kept.find(
      (a) => !consumed.has(a.shiftId) && sameSlot(a, slot),
    );
    if (match) consumed.add(match.shiftId);
    else remaining.push(slot);
  }

  // --- Construction ---------------------------------------------------------

  const placements: Placement[] = kept.map((assignment) => ({
    original: assignment,
    slot: {
      id: `locked:${assignment.shiftId}`,
      serviceId: assignment.serviceId,
      serviceName: assignment.serviceName,
      siteId: assignment.siteId,
      requirementId: "",
      requirementLabel: "",
      date: localDateString(assignment.start, snapshot.program.timezone),
      start: assignment.start,
      end: assignment.end,
      shiftType: assignment.shiftType,
      requiredPgy: null,
      servicePgyMin: null,
      servicePgyMax: null,
    },
    residentId: assignment.residentId,
    locked: true,
  }));

  const unfilled: UnfilledSlot[] = [];
  /** Who already holds one of the places at this service and time. */
  const heldPlaces = new Map<string, Set<string>>();
  for (const placement of placements) {
    if (!placement.residentId) continue;
    const key = placeKey(placement.slot);
    const holders = heldPlaces.get(key) ?? new Set<string>();
    holders.add(placement.residentId);
    heldPlaces.set(key, holders);
  }

  /* Most constrained first: the slot with fewest people who could take it is
     the one most likely to become impossible if left until last.

     Ranked **once**, on static eligibility only, rather than recomputed after
     every placement. Re-ranking is more accurate and is quadratic in the number
     of slots: on the demo programme's two hundred slots it turned a run that
     should take a second into fifty, and every one of those seconds came out of
     the budget the improvement phase never got to spend. Static eligibility is
     the part that actually differs between slots — a Sunday night on a service
     only seniors may cover is hard for reasons that do not change as the month
     fills. */
  const eligibleCount = new Map<string, number>();
  for (const slot of remaining) {
    let count = 0;
    for (const resident of residents) {
      if (!staticRejection(resident, slot, snapshot, limits)) count += 1;
    }
    eligibleCount.set(slot.id, count);
  }

  const ordered = [...remaining].sort((a, b) => {
    const difference = eligibleCount.get(a.id)! - eligibleCount.get(b.id)!;
    /* Ties broken by the slot's own identifier, which is content-addressed —
       so the order does not depend on how the requirements came back. */
    return difference !== 0 ? difference : a.id.localeCompare(b.id);
  });

  for (const slot of ordered) {
    const rejections: Rejection[] = [];
    let chosen: ScheduleResident | null = null;
    let chosenCost = Number.POSITIVE_INFINITY;

    const alreadyHere = heldPlaces.get(placeKey(slot));
    for (const resident of residents) {
      if (alreadyHere?.has(resident.id)) {
        rejections.push({
          residentId: resident.id,
          residentName: resident.name,
          constraintId: "roster-capacity",
          reason: `${resident.name} already holds one of the places on ${slot.serviceName} at that time.`,
        });
        continue;
      }
      const load = loads.get(resident.id)!;
      const stat = staticRejection(resident, slot, snapshot, limits);
      if (stat) {
        rejections.push({ residentId: resident.id, residentName: resident.name, ...stat });
        continue;
      }
      const dyn = dynamicRejection(resident, slot, load, snapshot, limits);
      if (dyn) {
        rejections.push({ residentId: resident.id, residentName: resident.name, ...dyn });
        continue;
      }
      const cost = constructionCost(resident, slot, load, snapshot);
      /* Ties broken by id, not by iteration order, so the result does not
         depend on how the database happened to sort the roster. */
      if (cost < chosenCost || (cost === chosenCost && chosen && resident.id < chosen.id)) {
        chosen = resident;
        chosenCost = cost;
      }
    }

    if (!chosen) {
      if (tryRepair(slot, placements, loads, heldPlaces, residents, snapshot, limits)) {
        continue;
      }
      unfilled.push({ slot, rejections });
      continue;
    }

    const assignment = slotToAssignment(slot, chosen.id, snapshot);
    addToLoad(loads.get(chosen.id)!, assignment, snapshot);
    const holders = heldPlaces.get(placeKey(slot)) ?? new Set<string>();
    holders.add(chosen.id);
    heldPlaces.set(placeKey(slot), holders);
    placements.push({ slot, residentId: chosen.id, locked: false });
  }

  // --- Infeasible: explain, emit nothing ------------------------------------

  if (unfilled.length > 0) {
    return {
      feasible: false,
      assignments: [],
      report: buildReport({
        snapshot,
        options,
        slots,
        placements,
        kept,
        unfilled,
        relaxations: explainInfeasibility(snapshot, unfilled, limits),
        hardViolations: [],
        softViolations: [],
        score: scoreSchedule([]),
        stoppedOnBudget: false,
        started,
        iterations: 0,
      }),
    };
  }

  // --- Improvement ----------------------------------------------------------

  const movable = placements.filter((p) => !p.locked);
  const toAssignments = (list: Placement[]): ScheduleAssignment[] =>
    list.map((p) =>
      p.original
        ? { ...p.original, residentId: p.residentId }
        : slotToAssignment(p.slot, p.residentId, snapshot),
    );

  let current = toAssignments(placements);
  let best = current;
  let bestScore = scoreOf(snapshot, best);
  let iterations = 0;
  let stoppedOnBudget = false;

  if (movable.length >= 2 && options.timeBudgetMs > 0) {
    const working = placements.map((p) => ({ ...p }));
    const movableIndexes = working
      .map((p, index) => ({ p, index }))
      .filter(({ p }) => !p.locked)
      .map(({ index }) => index);

    while (Date.now() - started < options.timeBudgetMs) {
      iterations += 1;

      /* One swap at a time: exchange the two residents on two movable slots.
         A swap keeps every slot filled by construction, so the only question
         is whether it is still legal and whether it scores better. */
      const a = movableIndexes[Math.floor(random() * movableIndexes.length)];
      const b = movableIndexes[Math.floor(random() * movableIndexes.length)];
      if (a === b) continue;

      const first = working[a];
      const second = working[b];
      if (first.residentId === second.residentId) continue;

      const swapped = working.map((p, index) =>
        index === a
          ? { ...p, residentId: second.residentId }
          : index === b
            ? { ...p, residentId: first.residentId }
            : p,
      );

      /* Only the two people who moved can have become illegal, so only they
         are re-checked. Rebuilding every resident's load for every candidate
         swap is what makes a search that evaluates forty swaps in two seconds
         instead of four hundred. */
      if (!legalFor(swapped, [first.residentId, second.residentId], snapshot, limits, byId)) {
        continue;
      }

      const candidate = toAssignments(swapped);
      const score = scoreOf(snapshot, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
        working[a] = swapped[a];
        working[b] = swapped[b];
      }

      if (Date.now() - started >= options.timeBudgetMs) {
        stoppedOnBudget = true;
        break;
      }
    }
    stoppedOnBudget = stoppedOnBudget || Date.now() - started >= options.timeBudgetMs;
    current = best;
  }

  // --- Grade it -------------------------------------------------------------

  const graded = validateSchedule({
    ...snapshot,
    period: options.period,
    assignments: best,
  });
  const hard = graded.violations.filter((v) => v.kind === "hard");

  if (hard.length > 0) {
    /* The fast checker and the validator disagreed. That is a defect, and the
       honest response is to emit nothing and say so — never to publish a month
       the authority says is wrong. */
    return {
      feasible: false,
      assignments: [],
      report: buildReport({
        snapshot,
        options,
        slots,
        placements,
        kept,
        unfilled: [],
        relaxations: [
          {
            constraintIds: [...new Set(hard.map((v) => v.constraintId))],
            message:
              "The generator produced a schedule the validator rejects, so nothing has been created. " +
              "This is a defect in the generator rather than in your configuration — the problems it found are listed.",
            slotsRecovered: 0,
          },
        ],
        hardViolations: hard,
        softViolations: graded.violations.filter((v) => v.kind === "soft"),
        score: graded.score,
        stoppedOnBudget,
        started,
        iterations,
      }),
    };
  }

  return {
    feasible: true,
    assignments: best,
    report: buildReport({
      snapshot,
      options,
      slots,
      placements,
      kept,
      unfilled: [],
      relaxations: [],
      hardViolations: [],
      softViolations: graded.violations.filter((v) => v.kind === "soft"),
      score: graded.score,
      stoppedOnBudget,
      started,
      iterations,
    }),
  };
}

/** The validator's score for a candidate schedule. */
function scoreOf(snapshot: ScheduleSnapshot, assignments: ScheduleAssignment[]): number {
  return validateSchedule({ ...snapshot, assignments }).score.score;
}

/**
 * Whether these people are still legally placed, after a swap moved them.
 *
 * Everybody else's arrangement is unchanged, so re-checking them would be
 * arithmetic with a known answer. The one thing that is *not* local is two
 * people ending up in the same place at the same time, so that is checked for
 * the affected pair explicitly.
 */
function legalFor(
  placements: Placement[],
  affected: Array<string | null>,
  snapshot: ScheduleSnapshot,
  limits: Limits,
  byId: Map<string, ScheduleResident>,
): boolean {
  const people = affected.filter((id): id is string => Boolean(id));

  for (const residentId of people) {
    const resident = byId.get(residentId);
    if (!resident) return false;

    const theirs = placements.filter((p) => p.residentId === residentId);
    const seenPlaces = new Set<string>();
    const load = emptyLoad();

    for (const placement of theirs) {
      const key = placeKey(placement.slot);
      if (seenPlaces.has(key)) return false; // Two places, one moment.
      seenPlaces.add(key);

      if (staticRejection(resident, placement.slot, snapshot, limits)) return false;
      if (dynamicRejection(resident, placement.slot, load, snapshot, limits)) return false;
      addToLoad(load, slotToAssignment(placement.slot, residentId, snapshot), snapshot);
    }
  }
  return true;
}

function buildReport(input: {
  snapshot: ScheduleSnapshot;
  options: GenerationOptions;
  slots: Slot[];
  placements: Placement[];
  kept: ScheduleAssignment[];
  unfilled: UnfilledSlot[];
  relaxations: GenerationReport["relaxations"];
  hardViolations: GenerationReport["hardViolations"];
  softViolations: GenerationReport["softViolations"];
  score: GenerationReport["score"];
  stoppedOnBudget: boolean;
  started: number;
  iterations: number;
}): GenerationReport {
  const { snapshot, options, slots, placements, kept, unfilled } = input;
  const zone = snapshot.program.timezone;

  const perService = new Map<string, { name: string; required: number; filled: number }>();
  for (const slot of slots) {
    const row = perService.get(slot.serviceId) ?? {
      name: slot.serviceName,
      required: 0,
      filled: 0,
    };
    row.required += 1;
    perService.set(slot.serviceId, row);
  }
  for (const placement of placements) {
    if (placement.locked || !placement.residentId) continue;
    const row = perService.get(placement.slot.serviceId);
    if (row) row.filled += 1;
  }

  const byLevel = new Map<
    number,
    Array<{ residentId: string; name: string; shifts: number; nights: number; weekends: number }>
  >();
  for (const resident of snapshot.residents) {
    if (!resident.active || !resident.schedulable) continue;
    const theirs = placements.filter((p) => p.residentId === resident.id);
    const row = {
      residentId: resident.id,
      name: resident.name,
      shifts: theirs.length,
      nights: theirs.filter((p) => isNightShift(p.slot.start, p.slot.end, zone)).length,
      weekends: theirs.filter((p) => isWeekendLocal(p.slot.start, zone)).length,
    };
    const list = byLevel.get(resident.pgyLevel) ?? [];
    list.push(row);
    byLevel.set(resident.pgyLevel, list);
  }

  /* What a human should look at. Not "everything the score dislikes" — the
     things a chief would want to have decided themselves. */
  const needsReview: GenerationReport["needsReview"] = [];
  for (const violation of input.softViolations) {
    if (violation.topic !== "preference" && violation.topic !== "fairness") continue;
    needsReview.push({
      shiftId: violation.shiftIds[0] ?? "",
      residentId: violation.residentIds[0] ?? null,
      reason: violation.message,
    });
  }

  return {
    demand: {
      slots: slots.length,
      filled: placements.filter((p) => !p.locked && p.residentId).length,
      locked: kept.length,
    },
    coverage: [...perService.entries()]
      .map(([serviceId, row]) => ({
        serviceId,
        serviceName: row.name,
        required: row.required,
        filled: row.filled,
      }))
      .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    unfilled,
    relaxations: input.relaxations,
    hardViolations: input.hardViolations,
    softViolations: input.softViolations,
    score: input.score,
    fairness: [...byLevel.entries()]
      .map(([pgyLevel, list]) => ({
        pgyLevel,
        residents: list.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.pgyLevel - b.pgyLevel),
    needsReview,
    stoppedOnBudget: input.stoppedOnBudget,
    seed: options.seed,
    elapsedMs: Date.now() - input.started,
    iterations: input.iterations,
  };
}
