"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label, Select, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Alert } from "@/components/ui/alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * When somebody cannot work.
 *
 * The same component serves a resident recording their own leave and a
 * scheduler recording the programme's, because the thing being recorded is
 * identical and only the reach differs. What the scheduler gets that the
 * resident does not is the person picker and the **Confirmed** switch — a
 * resident asks, the programme agrees, and only the agreed kind can make a
 * schedule invalid.
 *
 * Ranges rather than dates. Two weeks of leave is one row here and was fourteen
 * strings in a jsonb column before, which is the whole reason nobody used it.
 */

export interface AbsenceView {
  id: string;
  residentId: string;
  residentName: string;
  kind: string;
  kindLabel: string;
  startDate: string;
  endDate: string;
  hard: boolean;
  notes: string;
  createdByName: string | null;
}

interface KindOption {
  value: string;
  label: string;
  description: string;
  defaultHard: boolean;
}

interface PersonOption {
  id: string;
  name: string;
}

export function AvailabilityManager({
  absences,
  kinds,
  residents,
  manages,
  selfResidentId,
}: {
  absences: AbsenceView[];
  kinds: KindOption[];
  /** Empty for a resident: there is nobody else they may record. */
  residents: PersonOption[];
  manages: boolean;
  selfResidentId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const create = useAction(
    async (body: unknown) =>
      apiFetch("/api/availability", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    {
      onSuccess: () => {
        setOpen(false);
        router.refresh();
      },
    },
  );

  const remove = useAction(
    async (id: unknown) =>
      apiFetch(`/api/availability/${id as string}`, { method: "DELETE" }),
    { onSuccess: () => router.refresh() },
  );

  const confirm = useAction(
    async (id: unknown, hard: unknown) =>
      apiFetch(`/api/availability/${id as string}`, {
        method: "PATCH",
        body: JSON.stringify({ hard: hard as boolean }),
      }),
    { onSuccess: () => router.refresh() },
  );

  /* Grouped by person only when there is more than one person to group by.
     A resident looking at their own five rows does not need headings. */
  const grouped = React.useMemo(() => {
    const byPerson = new Map<string, AbsenceView[]>();
    for (const absence of absences) {
      const list = byPerson.get(absence.residentId) ?? [];
      list.push(absence);
      byPerson.set(absence.residentId, list);
    }
    return [...byPerson.entries()].sort((a, b) =>
      (a[1][0]?.residentName ?? "").localeCompare(b[1][0]?.residentName ?? ""),
    );
  }, [absences]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">
          {manages
            ? "Leave, conferences, electives and restrictions across the program. Confirmed entries stop the scheduler assigning over them."
            : "Tell your program when you are away. A chief confirms it, and once confirmed the schedule will not put you on a shift."}
        </p>
        <Button onClick={() => setOpen(true)}>Add</Button>
      </div>

      {remove.error ? <Alert tone="error">{remove.error}</Alert> : null}
      {confirm.error ? <Alert tone="error">{confirm.error}</Alert> : null}

      {absences.length === 0 ? (
        <EmptyState
          title="Nothing recorded"
          description={
            manages
              ? "Nobody has recorded leave for this period."
              : "You have no leave, conferences or unavailable dates recorded."
          }
        />
      ) : (
        <div className="space-y-4">
          {grouped.map(([residentId, rows]) => (
            <Card key={residentId} className="p-4">
              {grouped.length > 1 ? (
                <h3 className="mb-2 text-sm font-semibold text-ink">
                  {rows[0].residentName}
                </h3>
              ) : null}
              <ul className="divide-y divide-border">
                {rows.map((absence) => (
                  <li
                    key={absence.id}
                    className="flex flex-wrap items-start justify-between gap-2 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">
                        {absence.kindLabel}
                        <span className="ml-2 font-normal text-ink-muted">
                          {formatRange(absence.startDate, absence.endDate)}
                        </span>
                      </p>
                      {absence.notes ? (
                        <p className="mt-0.5 text-sm text-ink-muted">{absence.notes}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={absence.hard ? "critical" : "neutral"}>
                        {absence.hard ? "Confirmed" : "Requested"}
                      </Badge>
                      {manages ? (
                        <Button
                          variant="ghost"
                          onClick={() => confirm.run(absence.id, !absence.hard)}
                          disabled={confirm.pending}
                        >
                          {absence.hard ? "Unconfirm" : "Confirm"}
                        </Button>
                      ) : null}
                      {manages || !absence.hard ? (
                        <Button
                          variant="ghost"
                          onClick={() => remove.run(absence.id)}
                          disabled={remove.pending}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      <AbsenceSheet
        open={open}
        onClose={() => setOpen(false)}
        kinds={kinds}
        residents={residents}
        manages={manages}
        selfResidentId={selfResidentId}
        pending={create.pending}
        error={create.error}
        onSubmit={(body) => create.run(body)}
      />
    </div>
  );
}

function AbsenceSheet({
  open,
  onClose,
  kinds,
  residents,
  manages,
  selfResidentId,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  kinds: KindOption[];
  residents: PersonOption[];
  manages: boolean;
  selfResidentId: string | null;
  pending: boolean;
  error: string | null;
  onSubmit: (body: unknown) => void;
}) {
  const [residentId, setResidentId] = React.useState(
    selfResidentId ?? residents[0]?.id ?? "",
  );
  const [kind, setKind] = React.useState(kinds[0]?.value ?? "vacation");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [hard, setHard] = React.useState(kinds[0]?.defaultHard ?? true);

  const chosen = kinds.find((option) => option.value === kind);

  /* One date is the common case, and asking for it twice is the fastest way to
     make somebody give up. Filling the end from the start keeps a single day to
     one field without inventing a "one day / range" toggle. */
  function pickStart(value: string) {
    setStartDate(value);
    if (!endDate || endDate < value) setEndDate(value);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    onSubmit({
      residentId: manages ? residentId : undefined,
      kind,
      startDate,
      endDate: endDate || startDate,
      hard: manages ? hard : undefined,
      notes,
    });
  }

  return (
    <Sheet open={open} onClose={onClose} title="Record time away">
      <form onSubmit={submit} className="space-y-4">
        {error ? <Alert tone="error">{error}</Alert> : null}

        {manages && residents.length > 0 ? (
          <div>
            <Label htmlFor="absence-resident">Who</Label>
            <Select
              id="absence-resident"
              value={residentId}
              onChange={(event) => setResidentId(event.target.value)}
            >
              {residents.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        <div>
          <Label htmlFor="absence-kind">What</Label>
          <Select
            id="absence-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              const next = kinds.find((option) => option.value === event.target.value);
              if (next) setHard(next.defaultHard);
            }}
          >
            {kinds.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {chosen ? (
            <p className="mt-1 text-sm text-ink-muted">{chosen.description}</p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="absence-start">First day</Label>
            <Input
              id="absence-start"
              type="date"
              required
              value={startDate}
              onChange={(event) => pickStart(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="absence-end">Last day</Label>
            <Input
              id="absence-end"
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="absence-notes">Notes</Label>
          <Textarea
            id="absence-notes"
            rows={2}
            value={notes}
            maxLength={500}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={manages ? "Only the scheduler sees this." : "Optional."}
          />
        </div>

        {manages ? (
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-1"
              checked={hard}
              onChange={(event) => setHard(event.target.checked)}
            />
            <span>
              Confirmed — the schedule must not assign over this.
              <span className="block text-ink-muted">
                Leave this off for a request that has not been agreed yet. The
                generator will try to honour it and the schedule stays valid
                either way.
              </span>
            </span>
          </label>
        ) : (
          <p className="text-sm text-ink-muted">
            A chief confirms this before it affects the schedule.
          </p>
        )}

        <Button type="submit" disabled={pending || !startDate} className="w-full">
          {pending ? "Saving…" : "Record"}
        </Button>
      </form>
    </Sheet>
  );
}

/** "Mon, Aug 10" or "Mon, Aug 10 – Fri, Aug 21", the way the rest names days. */
function formatRange(start: string, end: string): string {
  return start === end ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`;
}

function formatDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
