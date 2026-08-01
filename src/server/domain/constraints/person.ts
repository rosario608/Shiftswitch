import type { ScheduleResident } from "./types";

/**
 * The shape of `residents.constraints` and `residents.preferences`.
 *
 * Both are jsonb, deliberately: they hold facts about one person that no two
 * programmes would enumerate the same way, and a column per fact would mean a
 * migration every time somebody's circumstances changed. What they are *not* is
 * arbitrary — a value nothing reads is a value that silently does nothing, so
 * the keys the validator honours are named here and nowhere else.
 *
 * `constraints` are HARD. Migration `0008` describes them as "facts about one
 * person" — no VA rotations because there is no parking pass, no Fridays for
 * religious observance, leave already agreed. A schedule that ignores one is
 * wrong, not merely disappointing.
 *
 * `preferences` are SOFT. They are scored and never enforced, which is the
 * whole reason they are a separate column: a resident's wish must not be able
 * to make a schedule invalid, and a resident's accommodation must not be
 * silently traded away as a preference.
 *
 * Every accessor tolerates rubbish. These columns can be written by an import
 * or by a future screen, and a constraint that throws on an unexpected value
 * would take the entire validation down with it — reporting nothing at all
 * about a schedule, which is far worse than ignoring one malformed key.
 */

export interface HardPersonConstraints {
  /** 0–6, Sunday first — "cannot work Fridays". */
  unavailableWeekdays: number[];
  /** ISO dates. Leave, absence, a conference already agreed. */
  unavailableDates: string[];
  /** Services this person may not be assigned to. */
  excludedServiceIds: string[];
  /** Sites this person may not work. Site eligibility is the general case. */
  excludedSiteIds: string[];
}

export interface SoftPersonPreferences {
  preferredServiceIds: string[];
  avoidServiceIds: string[];
  /** ISO dates the resident asked to have off, without it being leave. */
  requestedDaysOff: string[];
  /** "prefers nights" / "prefers days". Anything else is ignored. */
  preferredShiftType: "day" | "night" | null;
}

function stringList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function weekdayList(source: Record<string, unknown>, key: string): number[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is number => Number.isInteger(entry) && entry >= 0 && entry <= 6,
  );
}

export function hardConstraintsOf(resident: ScheduleResident): HardPersonConstraints {
  const source = resident.constraints ?? {};
  return {
    unavailableWeekdays: weekdayList(source, "unavailableWeekdays"),
    unavailableDates: stringList(source, "unavailableDates"),
    excludedServiceIds: stringList(source, "excludedServiceIds"),
    excludedSiteIds: stringList(source, "excludedSiteIds"),
  };
}

export function preferencesOf(resident: ScheduleResident): SoftPersonPreferences {
  const source = resident.preferences ?? {};
  const shiftType = source.preferredShiftType;
  return {
    preferredServiceIds: stringList(source, "preferredServiceIds"),
    avoidServiceIds: stringList(source, "avoidServiceIds"),
    requestedDaysOff: stringList(source, "requestedDaysOff"),
    preferredShiftType:
      shiftType === "day" || shiftType === "night" ? shiftType : null,
  };
}
