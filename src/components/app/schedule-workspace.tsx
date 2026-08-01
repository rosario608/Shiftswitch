"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Lock, Sparkles, Undo2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label, Select } from "@/components/ui/field";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Where a schedule is actually built.
 *
 * ## The shape of the screen
 *
 * A scheduler arrives with one of two questions — *is anything uncovered* or
 * *where do I put this person* — so the grid is what loads: services down the
 * side, days across the top, every cell tinted by whether it is short, met or
 * over. That is the table they already keep in a spreadsheet, and showing it
 * directly is the difference between a tool somebody uses and one they export.
 *
 * One tap away: the unfilled queue (worst gap first), the coverage report, and
 * the other two views. Deliberately buried, behind a disclosure: the change
 * history and the list of locks. Both matter and neither is what somebody came
 * for.
 *
 * ## Selection is the interaction
 *
 * Everything bulk works the same way: tap cells to select, then act on the
 * selection. No modes, no drag, no right-click — this is used on a phone
 * between rounds as often as on a laptop, and a gesture that needs a mouse is a
 * gesture half the programme cannot make.
 *
 * ## Undo
 *
 * Every bulk operation returns what it replaced, so undo is the same call with
 * the inverse payload. That is why it is offered here and nowhere near publish:
 * a draft edit is invertible, and telling forty people their schedule changed
 * is not.
 */

export type CellState = "under" | "met" | "over" | "empty";

export interface WorkspaceCell {
  serviceId: string;
  serviceName: string;
  date: string;
  requirementLabel: string;
  required: number;
  present: number;
  cap: number | null;
  state: CellState;
}

export interface WorkspaceShift {
  id: string;
  serviceId: string;
  serviceName: string;
  siteId: string | null;
  siteName: string | null;
  date: string;
  start: string;
  end: string;
  shiftType: string;
  residentId: string | null;
  residentName: string | null;
  pgyLevel: number | null;
  cohortId: string | null;
  cohortLabel: string | null;
  locked: boolean;
  lockReason: string;
  problems: Array<{ kind: "hard" | "soft"; message: string }>;
}

export interface WorkspaceData {
  versionId: string | null;
  editable: boolean;
  period: { start: string; end: string };
  dates: string[];
  shifts: WorkspaceShift[];
  cells: WorkspaceCell[];
  services: Array<{ id: string; name: string; siteId: string | null; siteName: string | null }>;
  residents: Array<{
    id: string;
    name: string;
    pgyLevel: number;
    cohortId: string | null;
    cohortLabel: string | null;
    schedulable: boolean;
    shifts: number;
  }>;
  sites: Array<{ id: string; name: string }>;
  cohorts: Array<{ id: string; label: string }>;
  locks: Array<{
    id: string;
    kind: string;
    target_label: string | null;
    target_date: string | null;
    reason: string;
  }>;
  unfilled: WorkspaceCell[];
  report: {
    underCovered: WorkspaceCell[];
    overCovered: WorkspaceCell[];
    uncoveredDates: string[];
    missingPgy: Array<{ message: string }>;
    excessiveWorkload: Array<{ message: string }>;
    problematicAssignments: Array<{ message: string }>;
    score: number;
    hardCount: number;
    softCount: number;
  };
  history: Array<{ at: string; actor: string; action: string; detail: string }>;
}

/** What the generator says would let it finish. Mirrors `Relaxation` on the
 *  server; declared here so the client bundle does not import the domain. */
interface Relaxation {
  message: string;
  slotsRecovered: number;
}

/** Why the last run produced what it did, beyond what the grid already shows. */
interface RunNotes {
  seed: number;
  elapsedMs: number;
  stoppedOnBudget: boolean;
  needsReview: string[];
}

type View = "grid" | "calendar" | "list";

interface Filters {
  pgy: string;
  cohortId: string;
  serviceId: string;
  siteId: string;
  residentId: string;
  search: string;
  problemsOnly: boolean;
}

const NO_FILTER = "";

export function ScheduleWorkspace({ initial }: { initial: WorkspaceData }) {
  const router = useRouter();
  const [data, setData] = React.useState(initial);
  const [view, setView] = React.useState<View>("grid");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = React.useState<
    Array<{ shiftId: string; residentId: string | null }>
  >([]);
  const [filters, setFilters] = React.useState<Filters>({
    pgy: NO_FILTER,
    cohortId: NO_FILTER,
    serviceId: NO_FILTER,
    siteId: NO_FILTER,
    residentId: NO_FILTER,
    search: "",
    problemsOnly: false,
  });

  /* The server payload is the source of truth. When the parent re-renders with
     a newer one — after a regeneration, say — adopt it rather than holding a
     stale grid, and do it at render time rather than in an effect. */
  const [seen, setSeen] = React.useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setData(initial);
    setSelected(new Set());
    setUndoStack([]);
  }

  async function reload() {
    const response = await apiFetch<{ workspace: WorkspaceData }>(
      "/api/admin/schedule-workspace",
      {
        method: "POST",
        body: JSON.stringify({ versionId: data.versionId }),
      },
    );
    setData(response.workspace);
    setSelected(new Set());
  }

  const assign = useAction(
    async (residentId: unknown) => {
      const changes = [...selected].map((shiftId) => ({
        shiftId,
        residentId: (residentId as string) || null,
      }));
      const result = await apiFetch<{
        changed: number;
        undo: Array<{ shiftId: string; residentId: string | null }>;
        skipped: Array<{ shiftId: string; reason: string }>;
      }>(`/api/admin/schedule-versions/${data.versionId}/bulk`, {
        method: "POST",
        body: JSON.stringify({ action: "assign", changes }),
      });
      setUndoStack(result.undo);
      await reload();
      router.refresh();
      return result;
    },
  );

  const undo = useAction(async () => {
    const result = await apiFetch<{ changed: number }>(
      `/api/admin/schedule-versions/${data.versionId}/bulk`,
      {
        method: "POST",
        body: JSON.stringify({ action: "assign", changes: undoStack }),
      },
    );
    setUndoStack([]);
    await reload();
    router.refresh();
    return result;
  });

  const lock = useAction(async () => {
    /* Locks are per resident here rather than per shift: a scheduler who has
       settled somebody's month means "leave this person alone", and locking
       forty shifts one at a time is not the same instruction. */
    const residentIds = [
      ...new Set(
        [...selected]
          .map((id) => data.shifts.find((shift) => shift.id === id)?.residentId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    for (const residentId of residentIds) {
      await apiFetch(`/api/admin/schedule-versions/${data.versionId}/locks`, {
        method: "POST",
        body: JSON.stringify({ kind: "resident", targetId: residentId }),
      });
    }
    await reload();
    router.refresh();
  });

  /* Unlocking is done from the list of locks rather than from the grid,
     because that is where somebody can see *what* they are unlocking. Undoing
     it from a selection would mean guessing which of the five kinds put the
     padlock on a cell. */
  const unlock = useAction(async (lockId: unknown) => {
    await apiFetch(`/api/admin/schedule-versions/${data.versionId}/locks`, {
      method: "DELETE",
      body: JSON.stringify({ lockId: lockId as string }),
    });
    await reload();
    router.refresh();
  });

  const visible = React.useMemo(() => filterShifts(data.shifts, filters), [data.shifts, filters]);
  const visibleIds = React.useMemo(() => new Set(visible.map((s) => s.id)), [visible]);

  function toggle(shiftId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(shiftId)) next.delete(shiftId);
      else next.add(shiftId);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <Summary report={data.report} unfilled={data.unfilled.length} />

      <FilterBar
        data={data}
        filters={filters}
        onChange={setFilters}
        showing={visible.length}
        total={data.shifts.length}
      />

      <div className="flex flex-wrap items-center gap-2">
        {(["grid", "calendar", "list"] as View[]).map((option) => (
          <Button
            key={option}
            size="sm"
            variant={view === option ? "primary" : "secondary"}
            onClick={() => setView(option)}
          >
            {option === "grid" ? "Grid" : option === "calendar" ? "Calendar" : "List"}
          </Button>
        ))}
        {selected.size > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection ({selected.size})
          </Button>
        ) : null}
        {undoStack.length > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            loading={undo.pending}
            onClick={() => undo.run()}
          >
            <Undo2 className="mr-1 h-4 w-4" aria-hidden="true" />
            Undo last change ({undoStack.length})
          </Button>
        ) : null}
      </div>

      <ActionAlert action={assign} />
      <ActionAlert action={lock} />
      <ActionAlert action={unlock} />
      <ActionAlert action={undo} />

      {selected.size > 0 && data.editable ? (
        <SelectionBar
          count={selected.size}
          residents={data.residents}
          pending={assign.pending || lock.pending}
          onAssign={(residentId) => assign.run(residentId)}
          onLock={() => lock.run()}
        />
      ) : null}

      {data.editable ? (
        <div className="space-y-3">
          <RepeatPattern
            versionId={data.versionId!}
            onDone={async () => {
              await reload();
              router.refresh();
            }}
          />
          <Regenerate
            versionId={data.versionId!}
            period={data.period}
            locks={data.locks.length}
            onDone={async () => {
              setSelected(new Set());
              setUndoStack([]);
              await reload();
              router.refresh();
            }}
          />
        </div>
      ) : null}

      {view === "grid" ? (
        <GridView
          data={data}
          visibleIds={visibleIds}
          selected={selected}
          onToggle={toggle}
        />
      ) : view === "calendar" ? (
        <CalendarView shifts={visible} selected={selected} onToggle={toggle} />
      ) : (
        <ListView shifts={visible} selected={selected} onToggle={toggle} />
      )}

      <UnfilledQueue cells={data.unfilled} />
      <CoverageReport report={data.report} />
      <Details title={`Locks (${data.locks.length})`}>
        {data.locks.length === 0 ? (
          <p className="p-4 text-sm text-ink-muted">
            Nothing is locked. Locking keeps a placement through the next
            regeneration.
          </p>
        ) : (
          <ul className="divide-y divide-border-base">
            {data.locks.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-2 px-4 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <span className="font-medium text-ink">
                    {/* An empty label means the target is gone. Said, not
                        hidden: a lock that quietly stopped applying is how a
                        scheduler loses the placement they were most careful
                        about. */}
                    {entry.target_label || entry.target_date || "No longer exists"}
                  </span>{" "}
                  <span className="text-ink-muted">({entry.kind})</span>
                  {entry.reason ? (
                    <span className="mt-0.5 block text-ink-muted">{entry.reason}</span>
                  ) : null}
                </div>
                {data.editable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={unlock.pending}
                    onClick={() => unlock.run(entry.id)}
                  >
                    Unlock
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Details>
      <Details title={`Change history (${data.history.length})`}>
        {data.history.length === 0 ? (
          <p className="p-4 text-sm text-ink-muted">Nothing has happened to this schedule yet.</p>
        ) : (
          <ul className="divide-y divide-border-base">
            {data.history.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="px-4 py-2.5 text-sm">
                <span className="font-medium text-ink">{entry.action}</span>{" "}
                <span className="text-ink-muted">by {entry.actor}</span>
                {entry.detail ? (
                  <span className="mt-0.5 block text-ink-subtle">{entry.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Details>
    </div>
  );
}

function filterShifts(shifts: WorkspaceShift[], filters: Filters): WorkspaceShift[] {
  const needle = filters.search.trim().toLowerCase();
  return shifts.filter((shift) => {
    if (filters.pgy && String(shift.pgyLevel ?? "") !== filters.pgy) return false;
    if (filters.cohortId && shift.cohortId !== filters.cohortId) return false;
    if (filters.serviceId && shift.serviceId !== filters.serviceId) return false;
    if (filters.siteId && shift.siteId !== filters.siteId) return false;
    if (filters.residentId && shift.residentId !== filters.residentId) return false;
    if (filters.problemsOnly && shift.problems.length === 0) return false;
    if (needle) {
      const haystack = [
        shift.residentName ?? "",
        shift.serviceName,
        shift.siteName ?? "",
        shift.cohortLabel ?? "",
        shift.date,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function Summary({
  report,
  unfilled,
}: {
  report: WorkspaceData["report"];
  unfilled: number;
}) {
  return (
    <Card className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
      <Stat
        label="Must be fixed"
        value={report.hardCount}
        tone={report.hardCount > 0 ? "critical" : "positive"}
      />
      <Stat label="Worth looking at" value={report.softCount} tone="neutral" />
      <Stat
        label="Gaps to fill"
        value={unfilled}
        tone={unfilled > 0 ? "caution" : "positive"}
      />
      <Stat label="Quality score" value={Math.round(report.score)} tone="neutral" />
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "critical" | "caution" | "positive" | "neutral";
}) {
  const colour =
    tone === "critical"
      ? "text-critical"
      : tone === "caution"
        ? "text-caution"
        : tone === "positive"
          ? "text-positive"
          : "text-ink";
  return (
    <div>
      <p className={`text-2xl font-semibold ${colour}`}>{value}</p>
      <p className="text-sm text-ink-muted">{label}</p>
    </div>
  );
}

function FilterBar({
  data,
  filters,
  onChange,
  showing,
  total,
}: {
  data: WorkspaceData;
  filters: Filters;
  onChange: (next: Filters) => void;
  showing: number;
  total: number;
}) {
  const pgyLevels = [...new Set(data.residents.map((r) => r.pgyLevel))].sort();
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  return (
    <Card className="space-y-3 p-4">
      <div>
        <Label htmlFor="workspace-search">Search</Label>
        <Input
          id="workspace-search"
          value={filters.search}
          placeholder="A name, a service, a site, a date"
          onChange={(event) => set({ search: event.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Picker
          id="filter-pgy"
          label="PGY"
          value={filters.pgy}
          onChange={(value) => set({ pgy: value })}
          options={pgyLevels.map((level) => ({
            value: String(level),
            label: `PGY-${level}`,
          }))}
        />
        <Picker
          id="filter-cohort"
          label="Cohort"
          value={filters.cohortId}
          onChange={(value) => set({ cohortId: value })}
          options={data.cohorts.map((c) => ({ value: c.id, label: c.label }))}
        />
        <Picker
          id="filter-service"
          label="Service"
          value={filters.serviceId}
          onChange={(value) => set({ serviceId: value })}
          options={data.services.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Picker
          id="filter-site"
          label="Site"
          value={filters.siteId}
          onChange={(value) => set({ siteId: value })}
          options={data.sites.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Picker
          id="filter-resident"
          label="Resident"
          value={filters.residentId}
          onChange={(value) => set({ residentId: value })}
          options={data.residents.map((r) => ({ value: r.id, label: r.name }))}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={filters.problemsOnly}
            onChange={(event) => set({ problemsOnly: event.target.checked })}
          />
          Only shifts with something wrong
        </label>
        <p className="text-sm text-ink-subtle">
          Showing {showing} of {total}
        </p>
      </div>
    </Card>
  );
}

function Picker({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

function SelectionBar({
  count,
  residents,
  pending,
  onAssign,
  onLock,
}: {
  count: number;
  residents: WorkspaceData["residents"];
  pending: boolean;
  onAssign: (residentId: string) => void;
  onLock: () => void;
}) {
  const [residentId, setResidentId] = React.useState("");
  return (
    <Card className="space-y-2 border-brand p-4">
      <p className="text-sm font-medium text-ink">
        {count} shift{count === 1 ? "" : "s"} selected
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <Label htmlFor="bulk-resident">Put them all on</Label>
          <Select
            id="bulk-resident"
            value={residentId}
            onChange={(event) => setResidentId(event.target.value)}
          >
            <option value="">Nobody</option>
            {residents
              .filter((resident) => resident.schedulable)
              .map((resident) => (
                <option key={resident.id} value={resident.id}>
                  {resident.name} · PGY-{resident.pgyLevel} · {resident.shifts} shifts
                </option>
              ))}
          </Select>
        </div>
        <Button disabled={pending} onClick={() => onAssign(residentId)}>
          {pending ? "Saving…" : "Apply"}
        </Button>
        <Button variant="secondary" disabled={pending} onClick={onLock}>
          <Lock className="mr-1 h-4 w-4" aria-hidden="true" />
          Lock these people
        </Button>
      </div>
    </Card>
  );
}

/**
 * Copy a week onto another week.
 *
 * The single most common thing a scheduler does by hand, and the one where a
 * mistyped date does the most damage — so the control says, before it is used,
 * exactly what the operation will and will not do. It writes only where the
 * destination already has a shift on the same service at the same time of day;
 * it never creates one and never deletes one.
 */
/**
 * Build the rest of the draft again, keeping whatever is locked.
 *
 * This is the other half of the padlock. Locking a resident's month says "leave
 * this alone through the next generation" — and until this control existed
 * there was no next generation to survive: the only route to the generator
 * created a *new* draft, so a scheduler could lock forty placements, see them
 * listed, and never find the button the locks were for. A control whose promise
 * cannot be redeemed is worse than one that is missing.
 *
 * The seed is offered rather than hidden because it is the honest answer to
 * "why did it do that": the same seed, the same inputs and the same locks give
 * the same schedule, and changing it is how a scheduler asks for a different
 * arrangement of the same constraints rather than a different set of rules.
 */
function Regenerate({
  versionId,
  period,
  locks,
  onDone,
}: {
  versionId: string;
  period: { start: string; end: string };
  locks: number;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [seed, setSeed] = React.useState(() => Math.floor(Math.random() * 100_000));
  const [result, setResult] = React.useState<string | null>(null);
  const [blocked, setBlocked] = React.useState<Relaxation[]>([]);
  const [why, setWhy] = React.useState<RunNotes | null>(null);

  const regenerate = useAction(async () => {
    setBlocked([]);
    setWhy(null);
    const response = await apiFetch<{
      feasible: boolean;
      versionId: string | null;
      report: {
        demand: { slots: number; filled: number; locked: number };
        relaxations: Relaxation[];
        needsReview: Array<{ reason: string }>;
        score: { score: number };
        stoppedOnBudget: boolean;
        seed: number;
        elapsedMs: number;
      };
    }>("/api/admin/schedule-generation", {
      method: "POST",
      body: JSON.stringify({
        periodStart: period.start,
        periodEnd: period.end,
        seed,
        versionId,
      }),
    });
    if (!response.feasible) {
      /* An infeasible run writes nothing, so the draft on screen is untouched.
         The generator already worked out the smallest change that would let it
         finish — that is the answer to "why did it do that", and dropping it
         leaves a chief with a refusal and no next move. */
      setBlocked(response.report.relaxations ?? []);
      throw new Error(
        "Nothing could be built that satisfies every rule, so the draft is unchanged.",
      );
    }
    const report = response.report;
    const demand = report.demand;
    setResult(
      `Filled ${demand.filled} of ${demand.slots} slot${demand.slots === 1 ? "" : "s"}` +
        (demand.locked > 0 ? `, keeping ${demand.locked} locked` : "") +
        `. Quality score ${report.score.score} out of 100.`,
    );
    /* The parts the grid below cannot show: whether the search finished or ran
       out of time, and the placements the generator itself is unsure about. A
       schedule that is merely the best found in two seconds and one that is the
       best there is look identical on a grid. */
    setWhy({
      seed: report.seed,
      elapsedMs: report.elapsedMs,
      stoppedOnBudget: report.stoppedOnBudget,
      needsReview: report.needsReview.map((entry) => entry.reason),
    });
    await onDone();
    return response;
  });

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Sparkles className="mr-1 h-4 w-4" aria-hidden="true" />
        Build the rest again
      </Button>
    );
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="font-semibold text-ink">Build the rest again</h3>
        <p className="mt-0.5 text-sm text-ink-muted">
          Runs the generator over this draft again.{" "}
          {locks > 0
            ? `The ${locks} lock${locks === 1 ? "" : "s"} below ${locks === 1 ? "is" : "are"} kept exactly as ${locks === 1 ? "it is" : "they are"}; everything else is rebuilt.`
            : "Nothing is locked, so the whole draft is rebuilt. Lock what you have already settled first if you want to keep it."}
        </p>
      </div>

      <ActionAlert action={regenerate} />
      {result ? <Alert tone="success">{result}</Alert> : null}

      {why ? (
        <div className="space-y-1.5 text-sm">
          {why.needsReview.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-ink-subtle uppercase">
                Worth a look before you publish
              </p>
              <ul className="mt-1 space-y-0.5 text-ink-muted">
                {why.needsReview.slice(0, 5).map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
                {why.needsReview.length > 5 ? (
                  <li className="text-ink-subtle">
                    …and {why.needsReview.length - 5} more, marked on the grid.
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-ink-subtle">
            Seed {why.seed} · {(why.elapsedMs / 1000).toFixed(1)}s
            {why.stoppedOnBudget
              ? " · stopped at the time limit, so this is the best it found rather than the best there is"
              : ""}
          </p>
        </div>
      ) : null}

      {blocked.length > 0 ? (
        <div className="rounded-xl border border-border-base p-3">
          <p className="text-sm font-semibold text-ink">
            The smallest changes that would let it finish
          </p>
          <ul className="mt-1 space-y-1.5 text-sm text-ink-muted">
            {blocked.map((relaxation, index) => (
              <li key={index}>
                {relaxation.message}{" "}
                <span className="text-ink-subtle">
                  (would fill {relaxation.slotsRecovered} more slot
                  {relaxation.slotsRecovered === 1 ? "" : "s"})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="max-w-[12rem]">
        <Label htmlFor="regen-seed">Seed</Label>
        <Input
          id="regen-seed"
          type="number"
          min={0}
          value={seed}
          onChange={(event) => setSeed(Number(event.target.value) || 0)}
        />
        <p className="mt-1 text-xs text-ink-subtle">
          The same seed and the same inputs give the same schedule, as long as
          the run finishes — it says below if it stopped at the time limit.
          Change the seed to see a different arrangement of the same
          constraints.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          loading={regenerate.pending}
          loadingLabel="Building…"
          onClick={() => regenerate.run()}
        >
          Build it
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setResult(null);
          }}
        >
          Close
        </Button>
      </div>
    </Card>
  );
}

function RepeatPattern({
  versionId,
  onDone,
}: {
  versionId: string;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [from, setFrom] = React.useState("");
  const [onto, setOnto] = React.useState("");
  const [days, setDays] = React.useState(7);
  const [result, setResult] = React.useState<string | null>(null);

  const repeat = useAction(
    async () => {
      const response = await apiFetch<{ changed: number }>(
        `/api/admin/schedule-versions/${versionId}/bulk`,
        {
          method: "POST",
          body: JSON.stringify({
            action: "repeat",
            sourceStart: from,
            targetStart: onto,
            days,
          }),
        },
      );
      setResult(
        `Copied onto ${response.changed} shift${response.changed === 1 ? "" : "s"}.`,
      );
      await onDone();
      return response;
    },
  );

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Repeat a week
      </Button>
    );
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="font-semibold text-ink">Repeat a week</h3>
        <p className="mt-0.5 text-sm text-ink-muted">
          Copies who is on what from one stretch of days onto another. It writes
          only where the destination already has a shift on the same service at
          the same time — it never creates a shift and never deletes one.
        </p>
      </div>

      <ActionAlert action={repeat} />
      {result ? <Alert tone="success">{result}</Alert> : null}

      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label htmlFor="repeat-from">Copy from</Label>
          <Input
            id="repeat-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="repeat-onto">Onto</Label>
          <Input
            id="repeat-onto"
            type="date"
            value={onto}
            onChange={(event) => setOnto(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="repeat-days">Days</Label>
          <Input
            id="repeat-days"
            type="number"
            min={1}
            max={31}
            value={days}
            onChange={(event) => setDays(Number(event.target.value) || 7)}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={repeat.pending || !from || !onto} onClick={() => repeat.run()}>
          {repeat.pending ? "Copying…" : "Copy"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </Card>
  );
}

const CELL_TONE: Record<CellState, string> = {
  /* Deliberately not red/amber/green alone: colour is the fast signal and the
     number underneath is the actual answer, so somebody who cannot distinguish
     the tints loses nothing. */
  empty: "bg-critical-soft text-critical",
  under: "bg-caution-soft text-caution",
  met: "bg-positive-soft text-positive",
  over: "bg-brand-soft text-brand-ink",
};

function GridView({
  data,
  visibleIds,
  selected,
  onToggle,
}: {
  data: WorkspaceData;
  visibleIds: Set<string>;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const cellByKey = new Map(data.cells.map((cell) => [`${cell.serviceId}|${cell.date}`, cell]));
  const shiftsByKey = new Map<string, WorkspaceShift[]>();
  for (const shift of data.shifts) {
    const key = `${shift.serviceId}|${shift.date}`;
    const list = shiftsByKey.get(key) ?? [];
    list.push(shift);
    shiftsByKey.set(key, list);
  }

  const services = data.services.filter((service) =>
    data.dates.some((date) => shiftsByKey.has(`${service.id}|${date}`) || cellByKey.has(`${service.id}|${date}`)),
  );

  if (data.dates.length === 0 || services.length === 0) {
    return (
      <EmptyState
        title="Nothing to show"
        description="This period has no shifts and no coverage requirements yet."
      />
    );
  }

  /* A filter that hides everything has to say so here too. The grid dims what
     is filtered out rather than removing it — the coverage numbers stay honest
     that way — but a whole grid of dimmed cells reads as a broken page, and
     the other two views already answer this. */
  if (data.shifts.length > 0 && visibleIds.size === 0) {
    return <EmptyState title="Nothing matches" description="No shifts match these filters." />;
  }

  return (
    /* The grid is the one thing on the page allowed to scroll sideways. The
       page itself never does — a body that scrolls horizontally on a phone is
       a page nobody can read. */
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-1 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-surface px-2 py-1 text-left text-ink-muted">
              Service
            </th>
            {data.dates.map((date) => (
              <th key={date} className="px-2 py-1 text-center font-medium text-ink-muted">
                {shortDay(date)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {services.map((service) => (
            <tr key={service.id}>
              <th className="sticky left-0 z-10 bg-surface px-2 py-1 text-left font-medium text-ink">
                {service.name}
                {service.siteName ? (
                  <span className="block text-xs font-normal text-ink-subtle">
                    {service.siteName}
                  </span>
                ) : null}
              </th>
              {data.dates.map((date) => {
                const key = `${service.id}|${date}`;
                const cell = cellByKey.get(key);
                const shifts = shiftsByKey.get(key) ?? [];
                return (
                  <td
                    key={key}
                    className={`min-w-[7rem] rounded-lg p-1 align-top ${
                      cell ? CELL_TONE[cell.state] : "bg-surface-muted"
                    }`}
                  >
                    {cell ? (
                      <p className="px-1 text-xs font-semibold">
                        {cell.present}/{cell.required}
                      </p>
                    ) : null}
                    {shifts.map((shift) => (
                      <ShiftChip
                        key={shift.id}
                        shift={shift}
                        dimmed={!visibleIds.has(shift.id)}
                        selected={selected.has(shift.id)}
                        onToggle={onToggle}
                      />
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShiftChip({
  shift,
  dimmed,
  selected,
  onToggle,
}: {
  shift: WorkspaceShift;
  dimmed: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const worst = shift.problems.find((problem) => problem.kind === "hard")
    ? "hard"
    : shift.problems.length > 0
      ? "soft"
      : null;

  return (
    <button
      type="button"
      onClick={() => onToggle(shift.id)}
      title={shift.problems.map((p) => p.message).join("\n") || undefined}
      className={[
        "mt-1 flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs",
        selected ? "bg-brand text-white" : "bg-surface text-ink",
        dimmed ? "opacity-40" : "",
        worst === "hard" ? "ring-1 ring-critical" : worst === "soft" ? "ring-1 ring-caution" : "",
      ].join(" ")}
    >
      {shift.locked ? (
        <Lock className="h-3 w-3 shrink-0" aria-label="Locked" />
      ) : null}
      {worst === "hard" ? (
        <AlertTriangle className="h-3 w-3 shrink-0" aria-label="Has a problem" />
      ) : null}
      <span className="truncate">{shift.residentName ?? "Nobody"}</span>
    </button>
  );
}

function CalendarView({
  shifts,
  selected,
  onToggle,
}: {
  shifts: WorkspaceShift[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const byDate = new Map<string, WorkspaceShift[]>();
  for (const shift of shifts) {
    const list = byDate.get(shift.date) ?? [];
    list.push(shift);
    byDate.set(shift.date, list);
  }
  const dates = [...byDate.keys()].sort();

  if (dates.length === 0) {
    return <EmptyState title="Nothing matches" description="No shifts match these filters." />;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {dates.map((date) => (
        <Card key={date} className="p-3">
          <p className="mb-2 text-sm font-semibold text-ink">{longDay(date)}</p>
          <ul className="space-y-1">
            {byDate.get(date)!.map((shift) => (
              <li key={shift.id}>
                <button
                  type="button"
                  onClick={() => onToggle(shift.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                    selected.has(shift.id) ? "bg-brand text-white" : "bg-surface-muted text-ink"
                  }`}
                >
                  {shift.locked ? <Lock className="h-3.5 w-3.5" aria-label="Locked" /> : null}
                  <span className="min-w-0 flex-1 truncate">
                    {shift.serviceName} · {shift.residentName ?? "Nobody"}
                  </span>
                  {shift.problems.length > 0 ? (
                    <AlertTriangle
                      className="h-3.5 w-3.5 shrink-0 text-critical"
                      aria-label="Has a problem"
                    />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function ListView({
  shifts,
  selected,
  onToggle,
}: {
  shifts: WorkspaceShift[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (shifts.length === 0) {
    return <EmptyState title="Nothing matches" description="No shifts match these filters." />;
  }
  return (
    <Card className="divide-y divide-border-base">
      {shifts.map((shift) => (
        <button
          key={shift.id}
          type="button"
          onClick={() => onToggle(shift.id)}
          className={`flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left ${
            selected.has(shift.id) ? "bg-brand-soft" : ""
          }`}
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              {shift.residentName ?? "Nobody assigned"}
            </p>
            <p className="text-sm text-ink-muted">
              {shift.serviceName} · {longDay(shift.date)}
              {shift.siteName ? ` · ${shift.siteName}` : ""}
            </p>
            {shift.problems.map((problem, index) => (
              <p
                key={index}
                className={`mt-0.5 text-sm ${
                  problem.kind === "hard" ? "text-critical" : "text-caution"
                }`}
              >
                {problem.message}
              </p>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {shift.pgyLevel ? <Badge tone="neutral">PGY-{shift.pgyLevel}</Badge> : null}
            {shift.locked ? (
              <Badge tone="brand" title={shift.lockReason}>
                Locked
              </Badge>
            ) : null}
          </div>
        </button>
      ))}
    </Card>
  );
}

function UnfilledQueue({ cells }: { cells: WorkspaceCell[] }) {
  if (cells.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase">
        Positions still to fill ({cells.length})
      </h2>
      <Card className="divide-y divide-border-base">
        {cells.slice(0, 40).map((cell) => (
          <div key={`${cell.serviceId}|${cell.date}|${cell.requirementLabel}`} className="px-4 py-2.5 text-sm">
            <span className="font-medium text-ink">{cell.serviceName}</span>{" "}
            <span className="text-ink-muted">{longDay(cell.date)}</span>
            <span className="mt-0.5 block text-ink-muted">
              {cell.present} of {cell.required} needed
              {cell.requirementLabel ? ` · ${cell.requirementLabel}` : ""}
            </span>
          </div>
        ))}
        {cells.length > 40 ? (
          <p className="px-4 py-2.5 text-sm text-ink-subtle">
            …and {cells.length - 40} more.
          </p>
        ) : null}
      </Card>
    </section>
  );
}

function CoverageReport({ report }: { report: WorkspaceData["report"] }) {
  type Section = { title: string; items: string[]; tone: "critical" | "caution" };
  const sections: Section[] = ([
    {
      title: "Days with nobody on anything",
      tone: "critical" as const,
      items: report.uncoveredDates.map((date) => longDay(date)),
    },
    {
      title: "Somebody scheduled who should not be",
      tone: "critical" as const,
      items: report.problematicAssignments.map((item) => item.message),
    },
    {
      title: "Training levels not met",
      tone: "critical" as const,
      items: report.missingPgy.map((item) => item.message),
    },
    {
      title: "Too much work",
      tone: "caution" as const,
      items: report.excessiveWorkload.map((item) => item.message),
    },
    {
      title: "More people than the service can take",
      tone: "caution" as const,
      items: report.overCovered.map(
        (cell) =>
          `${cell.serviceName} on ${longDay(cell.date)} has ${cell.present}, and takes at most ${cell.cap}.`,
      ),
    },
  ] satisfies Section[]).filter((section) => section.items.length > 0);

  if (sections.length === 0) {
    return (
      <Alert tone="success" title="Coverage is sound">
        Nothing is under-staffed, over-staffed, or worked by somebody who cannot
        work it.
      </Alert>
    );
  }

  return (
    <section>
      <h2 className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase">
        Coverage
      </h2>
      <div className="space-y-3">
        {sections.map((section) => (
          <Card key={section.title} className="p-4">
            <div className="mb-1.5 flex items-center gap-2">
              <Badge tone={section.tone}>{section.items.length}</Badge>
              <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
            </div>
            <ul className="space-y-1">
              {section.items.slice(0, 20).map((item, index) => (
                <li key={index} className="text-sm text-ink-muted">
                  {item}
                </li>
              ))}
              {section.items.length > 20 ? (
                <li className="text-sm text-ink-subtle">
                  …and {section.items.length - 20} more.
                </li>
              ) : null}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}

function Details({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-xl border border-border-base">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">
        {title}
      </summary>
      <div className="border-t border-border-base">{children}</div>
    </details>
  );
}

/* Dates arrive as ISO labels the server already resolved in the programme's
   timezone. Formatting them in UTC keeps them the day the server meant; going
   back through a local timezone would shift every label by one. */
function shortDay(iso: string): string {
  return formatIso(iso, { weekday: "short", day: "numeric" });
}

function longDay(iso: string): string {
  return formatIso(iso, { weekday: "short", month: "short", day: "numeric" });
}

function formatIso(iso: string, options: Intl.DateTimeFormatOptions): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    ...options,
    timeZone: "UTC",
  });
}
