"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ApiError, apiFetch } from "@/lib/api-client";
import { dayLabel, fmtRange, isoDate } from "@/lib/format";

/**
 * Editing the shifts in a draft.
 *
 * Assignment is an inline select rather than a sheet, because building a
 * schedule means doing this a hundred times in a sitting and a dialog per
 * change would make that unbearable. Removal is the one destructive action, so
 * it asks — but only for the row it is on, and only once.
 *
 * Everything here is safe by construction: a draft shift is invisible to
 * residents, cannot be traded, and disappears entirely if the draft is
 * discarded. That is the point of drafts, and it is why this screen does not
 * behave like the live schedule editor.
 */

export interface EditableShift {
  id: string;
  serviceName: string;
  start: string;
  end: string;
  residentId: string | null;
  residentName: string | null;
}

export interface AssignableResident {
  id: string;
  name: string;
  pgyLevel: number;
}

export function DraftShiftEditor({
  versionId,
  shifts: incoming,
  residents,
  timezone,
  truncated,
}: {
  versionId: string;
  shifts: EditableShift[];
  residents: AssignableResident[];
  timezone: string;
  truncated: boolean;
}) {
  const router = useRouter();
  const [shifts, setShifts] = React.useState(incoming);
  const [error, setError] = React.useState<string | null>(null);
  /* What the last edit did, in one sentence. Cleared on the next edit so it is
     never ambiguous which change it describes. */
  const [impact, setImpact] = React.useState<
    { safe: boolean; summary: string } | null
  >(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = React.useState<string | null>(null);
  const [onlyUnstaffed, setOnlyUnstaffed] = React.useState(false);

  /* The page refetches after every change so the diff above stays true. When
     it comes back, adopt it — the server is the authority, and our optimistic
     row will already agree with it. Adjusted during render rather than in an
     effect so the list never paints one frame of stale rows. */
  const [seen, setSeen] = React.useState(incoming);
  if (seen !== incoming) {
    setSeen(incoming);
    setShifts(incoming);
  }

  const unstaffed = shifts.filter((shift) => !shift.residentId);
  const shown = onlyUnstaffed ? unstaffed : shifts;

  async function mutate(
    shiftId: string,
    run: () => Promise<{ impact?: { safe: boolean; summary: string } | null }>,
  ) {
    setBusyId(shiftId);
    setError(null);
    setImpact(null);
    try {
      const response = await run();
      if (response?.impact) setImpact(response.impact);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Something went wrong. Please try again.",
      );
      // Put the row back the way the server still has it.
      setShifts(incoming);
    } finally {
      setBusyId(null);
    }
  }

  function assign(shift: EditableShift, residentId: string | null) {
    const resident = residents.find((candidate) => candidate.id === residentId) ?? null;
    setShifts((current) =>
      current.map((row) =>
        row.id === shift.id
          ? { ...row, residentId, residentName: resident?.name ?? null }
          : row,
      ),
    );
    void mutate(shift.id, () =>
      apiFetch<{ impact: { safe: boolean; summary: string } | null }>(
        `/api/admin/schedule-versions/${versionId}/shifts/${shift.id}`,
        { method: "PATCH", body: JSON.stringify({ residentId }) },
      ),
    );
  }

  function remove(shift: EditableShift) {
    setConfirmingRemoval(null);
    setShifts((current) => current.filter((row) => row.id !== shift.id));
    void mutate(shift.id, () =>
      apiFetch<{ impact: null }>(
        `/api/admin/schedule-versions/${versionId}/shifts/${shift.id}`,
        { method: "DELETE" },
      ),
    );
  }

  if (shifts.length === 0) {
    return (
      <EmptyState
        title="This draft has no shifts"
        description="A draft copied from the live schedule starts with everything already in it. An empty one is usually a draft started from scratch — import a schedule, or discard it below."
      />
    );
  }

  const days = groupByDay(shown, timezone);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-sm text-ink-muted">
          {unstaffed.length === 0 ? (
            <>
              All {shifts.length} shift{shifts.length === 1 ? " has" : "s have"}{" "}
              somebody on {shifts.length === 1 ? "it" : "them"}.
            </>
          ) : (
            <>
              <span className="font-semibold text-caution">{unstaffed.length}</span>{" "}
              of {shifts.length} shifts have nobody on them.
            </>
          )}
        </p>
        {unstaffed.length > 0 ? (
          <Button
            size="sm"
            variant={onlyUnstaffed ? "primary" : "secondary"}
            aria-pressed={onlyUnstaffed}
            onClick={() => setOnlyUnstaffed(!onlyUnstaffed)}
          >
            Unstaffed only
          </Button>
        ) : null}
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {/* Checked immediately, and only the difference this edit made — a
          scheduler moving one person should not be handed the month's whole
          problem list. */}
      {impact ? (
        <Alert tone={impact.safe ? "info" : "error"} live>
          {impact.summary}
        </Alert>
      ) : null}

      {days.map(([label, rows]) => (
        <div key={label}>
          <h3 className="mb-1 px-1 text-sm font-semibold text-ink">{label}</h3>
          <Card>
            <ul className="divide-y divide-border-base">
              {rows.map((shift) => (
                <li key={shift.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-medium text-ink">{shift.serviceName}</span>
                    <span className="text-sm text-ink-muted">
                      {fmtRange(shift.start, shift.end, timezone)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="sr-only">
                        Who is working {shift.serviceName} on {label}
                      </span>
                      <select
                        className="input"
                        value={shift.residentId ?? ""}
                        disabled={busyId === shift.id}
                        onChange={(event) =>
                          assign(shift, event.target.value || null)
                        }
                      >
                        <option value="">Nobody yet</option>
                        {/* Somebody already on the shift who is no longer
                            schedulable still has to appear, or the select would
                            silently show the wrong person. */}
                        {shift.residentId &&
                        !residents.some((r) => r.id === shift.residentId) ? (
                          <option value={shift.residentId}>
                            {shift.residentName ?? "Currently assigned"}
                          </option>
                        ) : null}
                        {residents.map((resident) => (
                          <option key={resident.id} value={resident.id}>
                            {resident.name} · PGY-{resident.pgyLevel}
                          </option>
                        ))}
                      </select>
                    </label>
                    {confirmingRemoval === shift.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => remove(shift)}
                        >
                          Remove
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setConfirmingRemoval(null)}
                        >
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === shift.id}
                        onClick={() => setConfirmingRemoval(shift.id)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ))}

      {shown.length === 0 ? (
        <EmptyState
          title="Every shift has somebody"
          description="Nothing in this draft is unstaffed."
        />
      ) : null}

      {truncated ? (
        <p className="px-1 text-sm text-ink-subtle">
          Showing the first {shifts.length} shifts of this draft, earliest first.
          Publish or narrow the draft&rsquo;s period to work through the rest.
        </p>
      ) : null}
    </div>
  );
}

/* Grouped on the calendar date, labelled with the product's own wording. The
   key is the date and not the label because "Mon, Aug 10" repeats every few
   years, and a draft spanning a year boundary would otherwise merge two days
   into one heading. */
function groupByDay(
  shifts: EditableShift[],
  timezone: string,
): Array<[string, EditableShift[]]> {
  const days = new Map<string, { label: string; rows: EditableShift[] }>();
  for (const shift of shifts) {
    const key = isoDate(shift.start, timezone);
    const existing = days.get(key);
    if (existing) existing.rows.push(shift);
    else days.set(key, { label: dayLabel(shift.start, timezone), rows: [shift] });
  }
  return [...days.values()].map((day) => [day.label, day.rows]);
}
