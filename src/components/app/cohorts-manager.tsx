"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Cohorts, the block year, and the grid that connects them.
 *
 * The grid is the point. A scheduler thinks in a table — cohorts down the side,
 * blocks across the top, a service in each cell — and every programme currently
 * keeps that table in a spreadsheet. Showing it directly, with each cell
 * editable, is the difference between a tool a chief uses and one they export
 * to Excel and abandon.
 */

interface Cohort {
  id: string;
  label: string;
  pgyLevel: number;
  pairedCohortId: string | null;
  pairedCohortLabel: string | null;
  memberCount: number;
  active: boolean;
  notes: string;
}

interface Structure {
  id: string;
  name: string;
  academicYear: number;
  blockCount: number;
}

interface Block {
  id: string;
  sequence: number;
  label: string;
  kind: string;
  startDate: string;
  endDate: string;
}

interface Assignment {
  cohortId: string;
  blockId: string;
  serviceId: string | null;
  serviceName: string | null;
  label: string;
}

interface Resident {
  id: string;
  name: string;
  pgyLevel: number;
  cohortId: string | null;
  schedulable: boolean;
}

export function CohortsManager({
  cohorts,
  structures,
  currentStructureId,
  blocks,
  assignments,
  residents,
  services,
}: {
  cohorts: Cohort[];
  structures: Structure[];
  currentStructureId: string | null;
  blocks: Block[];
  assignments: Assignment[];
  residents: Resident[];
  services: Array<{ id: string; name: string }>;
}) {
  const [editing, setEditing] = React.useState<Cohort | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [buildingYear, setBuildingYear] = React.useState(false);
  const [members, setMembers] = React.useState<Cohort | null>(null);
  const [cell, setCell] = React.useState<{ cohort: Cohort; block: Block } | null>(null);

  const assignmentFor = React.useCallback(
    (cohortId: string, blockId: string) =>
      assignments.find((a) => a.cohortId === cohortId && a.blockId === blockId) ?? null,
    [assignments],
  );

  const activeCohorts = cohorts.filter((cohort) => cohort.active);

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">
            Cohorts
          </h2>
          <Button size="sm" onClick={() => setCreating(true)}>
            New cohort
          </Button>
        </div>

        {cohorts.length === 0 ? (
          <EmptyState
            title="No cohorts yet"
            description="A cohort is a group within a PGY class that rotates together — often two per class, alternating between inpatient and clinic."
            action={<Button onClick={() => setCreating(true)}>Create the first cohort</Button>}
          />
        ) : (
          <ul className="space-y-2">
            {cohorts.map((cohort) => (
              <li key={cohort.id}>
                <Card className="px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">
                        {cohort.label}{" "}
                        <span className="font-normal text-ink-muted">
                          · PGY-{cohort.pgyLevel}
                        </span>
                      </p>
                      <p className="mt-0.5 text-sm text-ink-muted">
                        {cohort.memberCount} member
                        {cohort.memberCount === 1 ? "" : "s"}
                        {cohort.pairedCohortLabel
                          ? ` · alternates with ${cohort.pairedCohortLabel}`
                          : " · not paired"}
                      </p>
                      {cohort.notes ? (
                        <p className="mt-1 text-sm text-ink-subtle">{cohort.notes}</p>
                      ) : null}
                    </div>
                    {!cohort.active ? <Badge tone="neutral">Inactive</Badge> : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-border-base pt-3">
                    <Button size="sm" variant="secondary" onClick={() => setMembers(cohort)}>
                      Members
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(cohort)}>
                      Edit
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">
            The block year
          </h2>
          <Button size="sm" variant="secondary" onClick={() => setBuildingYear(true)}>
            {structures.length === 0 ? "Build a year" : "New structure"}
          </Button>
        </div>

        {structures.length === 0 ? (
          <EmptyState
            title="No block structure yet"
            description="Blocks are the spans your year divides into. Any length works — four weeks, two weeks, thirteen blocks — and they can alternate between kinds, which is how a 4+4 year is described."
            action={<Button onClick={() => setBuildingYear(true)}>Build a year</Button>}
          />
        ) : blocks.length === 0 ? (
          <EmptyState
            title="This structure has no blocks"
            description="Create a new structure to generate them."
          />
        ) : (
          <>
            <p className="mb-2 px-1 text-sm text-ink-muted">
              Tap a cell to say what that cohort is doing in that block.
            </p>
            {/* The grid scrolls inside itself rather than making the page scroll
                sideways — a year is thirteen columns and a phone is not. */}
            <div className="overflow-x-auto rounded-xl border border-border-base">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                  Cohort assignments by block
                </caption>
                <thead>
                  <tr className="bg-surface-muted">
                    <th
                      scope="col"
                      className="sticky left-0 z-10 bg-surface-muted px-3 py-2 text-left font-semibold text-ink"
                    >
                      Cohort
                    </th>
                    {blocks.map((block) => (
                      <th
                        key={block.id}
                        scope="col"
                        className="min-w-[7rem] px-3 py-2 text-left font-semibold text-ink"
                      >
                        <span className="block">{block.label}</span>
                        <span className="block text-xs font-normal text-ink-subtle">
                          {block.startDate.slice(5)} – {block.endDate.slice(5)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeCohorts.map((cohort) => (
                    <tr key={cohort.id} className="border-t border-border-base">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium text-ink"
                      >
                        <span className="block">{cohort.label}</span>
                        <span className="block text-xs font-normal text-ink-subtle">
                          PGY-{cohort.pgyLevel}
                        </span>
                      </th>
                      {blocks.map((block) => {
                        const assignment = assignmentFor(cohort.id, block.id);
                        return (
                          <td key={block.id} className="px-1 py-1">
                            <button
                              type="button"
                              onClick={() => setCell({ cohort, block })}
                              className={`min-h-[2.5rem] w-full rounded-lg px-2 py-1.5 text-left ${
                                assignment
                                  ? "bg-brand-soft/40 text-ink"
                                  : "text-ink-subtle hover:bg-surface-muted"
                              }`}
                            >
                              {assignment?.serviceName ?? assignment?.label ?? "—"}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {activeCohorts.length === 0 ? (
              <p className="mt-2 px-1 text-sm text-ink-muted">
                Create a cohort to fill this grid in.
              </p>
            ) : null}
          </>
        )}
      </section>

      {creating || editing ? (
        <CohortSheet
          cohort={editing}
          cohorts={cohorts}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      ) : null}

      {members ? (
        <MembersSheet
          cohort={members}
          residents={residents}
          onClose={() => setMembers(null)}
        />
      ) : null}

      {buildingYear ? <YearSheet onClose={() => setBuildingYear(false)} /> : null}

      {cell && currentStructureId ? (
        <CellSheet
          cohort={cell.cohort}
          block={cell.block}
          structureId={currentStructureId}
          services={services}
          current={assignmentFor(cell.cohort.id, cell.block.id)}
          onClose={() => setCell(null)}
        />
      ) : null}
    </div>
  );
}

function CohortSheet({
  cohort,
  cohorts,
  onClose,
}: {
  cohort: Cohort | null;
  cohorts: Cohort[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [label, setLabel] = React.useState(cohort?.label ?? "");
  const [pgyLevel, setPgyLevel] = React.useState(cohort?.pgyLevel ?? 1);
  const [pairedCohortId, setPairedCohortId] = React.useState(cohort?.pairedCohortId ?? "");
  const [notes, setNotes] = React.useState(cohort?.notes ?? "");
  const [active, setActive] = React.useState(cohort?.active ?? true);

  const save = useAction(
    async () => {
      const trimmed = label.trim();
      if (!trimmed) throw new Error("Give the cohort a label.");
      const body = JSON.stringify({
        label: trimmed,
        pgyLevel,
        pairedCohortId: pairedCohortId || null,
        notes,
        ...(cohort ? { active } : {}),
      });
      return cohort
        ? apiFetch(`/api/admin/cohorts/${cohort.id}`, { method: "PATCH", body })
        : apiFetch("/api/admin/cohorts", { method: "POST", body });
    },
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  // Only same-level cohorts can sensibly alternate, and never itself.
  const pairable = cohorts.filter(
    (candidate) =>
      candidate.id !== cohort?.id &&
      candidate.pgyLevel === pgyLevel &&
      candidate.active &&
      (!candidate.pairedCohortId || candidate.pairedCohortId === cohort?.id),
  );

  return (
    <Sheet open title={cohort ? "Edit cohort" : "New cohort"} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Label">
          <input
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="PGY-2 Cohort A"
            autoFocus
          />
        </Field>

        <Field label="Training level">
          <select
            className="input"
            value={pgyLevel}
            onChange={(event) => setPgyLevel(Number(event.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 7].map((level) => (
              <option key={level} value={level}>
                PGY-{level}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Alternates with"
          hint="Paired cohorts swap places each block — while one is on wards, the other is in clinic."
        >
          <select
            className="input"
            value={pairedCohortId}
            onChange={(event) => setPairedCohortId(event.target.value)}
          >
            <option value="">Not paired</option>
            {pairable.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Notes">
          <textarea
            className="input min-h-[4rem]"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>

        {cohort ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
            />
            Active
          </label>
        ) : null}

        {save.error ? (
          <p role="alert" className="text-sm text-critical">
            {save.error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button loading={save.pending} loadingLabel="Saving…" onClick={() => save.run()}>
            {cohort ? "Save" : "Create cohort"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function MembersSheet({
  cohort,
  residents,
  onClose,
}: {
  cohort: Cohort;
  residents: Resident[];
  onClose: () => void;
}) {
  const router = useRouter();
  const inCohort = residents.filter((resident) => resident.cohortId === cohort.id);
  const available = residents.filter(
    (resident) => !resident.cohortId && resident.pgyLevel === cohort.pgyLevel,
  );

  const change = useAction(
    async (body: string) =>
      apiFetch(`/api/admin/cohorts/${cohort.id}`, { method: "PATCH", body }),
    { onSuccess: () => router.refresh() },
  );

  return (
    <Sheet open title={`${cohort.label} · members`} onClose={onClose}>
      <div className="space-y-4">
        {change.error ? (
          <p role="alert" className="text-sm text-critical">
            {change.error}
          </p>
        ) : null}

        <section>
          <h3 className="mb-1.5 text-sm font-semibold text-ink">In this cohort</h3>
          {inCohort.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nobody yet. An empty cohort assigned to a block leaves that block
              uncovered.
            </p>
          ) : (
            <ul className="space-y-1">
              {inCohort.map((resident) => (
                <li
                  key={resident.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="text-ink">
                    {resident.name}
                    {!resident.schedulable ? (
                      <span className="ml-1 text-ink-subtle">(not schedulable)</span>
                    ) : null}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      change.run(JSON.stringify({ removeResidentId: resident.id }))
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border-t border-border-base pt-3">
          <h3 className="mb-1.5 text-sm font-semibold text-ink">
            Add a PGY-{cohort.pgyLevel} resident
          </h3>
          {available.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Every PGY-{cohort.pgyLevel} resident is already in a cohort.
            </p>
          ) : (
            <ul className="space-y-1">
              {available.map((resident) => (
                <li
                  key={resident.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="text-ink">{resident.name}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      change.run(JSON.stringify({ addResidentId: resident.id }))
                    }
                  >
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Sheet>
  );
}

/**
 * Building a year.
 *
 * Deliberately expressed as "how long is a block" and "how many", with an
 * optional list of kinds to alternate between. 4+4 is `weeks: 4` with two
 * kinds; a two-week programme is `weeks: 2`; a thirteen-block year is
 * `count: 13` with no kinds at all. The form has no notion of any of them.
 */
function YearSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const thisYear = new Date().getFullYear();
  const [name, setName] = React.useState(`${thisYear}–${String(thisYear + 1).slice(2)}`);
  const [academicYear, setAcademicYear] = React.useState(thisYear);
  const [startDate, setStartDate] = React.useState(`${thisYear}-07-01`);
  const [weeks, setWeeks] = React.useState(4);
  const [count, setCount] = React.useState(13);
  const [kinds, setKinds] = React.useState("Inpatient, Ambulatory");

  const save = useAction(
    async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Give the block structure a name.");
      return apiFetch("/api/admin/blocks", {
        method: "POST",
        body: JSON.stringify({
          name: trimmed,
          academicYear,
          generate: {
            startDate,
            weeks,
            count,
            kinds: kinds
              .split(",")
              .map((kind) => kind.trim())
              .filter(Boolean),
          },
        }),
      });
    },
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  const weeksCovered = weeks * count;

  return (
    <Sheet open title="Build a block year" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Academic year starts">
            <input
              type="number"
              className="input"
              value={academicYear}
              onChange={(event) => setAcademicYear(Number(event.target.value))}
            />
          </Field>
          <Field label="First block starts">
            <input
              type="date"
              className="input"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Weeks per block">
            <input
              type="number"
              min={1}
              max={52}
              className="input"
              value={weeks}
              onChange={(event) => setWeeks(Number(event.target.value))}
            />
          </Field>
          <Field label="Number of blocks">
            <input
              type="number"
              min={1}
              max={60}
              className="input"
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
            />
          </Field>
        </div>

        <Field
          label="Alternating kinds"
          hint="Comma separated, and optional. Two kinds gives the 4+4 pattern; leave it empty for a plain block year."
        >
          <input
            className="input"
            value={kinds}
            onChange={(event) => setKinds(event.target.value)}
            placeholder="Inpatient, Ambulatory"
          />
        </Field>

        <p className="text-sm text-ink-muted">
          {count} blocks of {weeks} week{weeks === 1 ? "" : "s"} covers{" "}
          {weeksCovered} weeks
          {weeksCovered !== 52 ? (
            <span className="text-caution">
              {" "}
              — a year is 52, so {weeksCovered > 52 ? "this overruns" : "there is a gap"}.
              That is allowed; orientation and holidays often sit outside the blocks.
            </span>
          ) : (
            "."
          )}
        </p>

        {save.error ? (
          <p role="alert" className="text-sm text-critical">
            {save.error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button loading={save.pending} loadingLabel="Building…" onClick={() => save.run()}>
            Build it
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function CellSheet({
  cohort,
  block,
  structureId,
  services,
  current,
  onClose,
}: {
  cohort: Cohort;
  block: Block;
  structureId: string;
  services: Array<{ id: string; name: string }>;
  current: Assignment | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [serviceId, setServiceId] = React.useState(current?.serviceId ?? "");
  const [label, setLabel] = React.useState(current?.label ?? "");

  const save = useAction(
    async (clear: boolean) =>
      apiFetch(`/api/admin/blocks/${structureId}`, {
        method: "POST",
        body: JSON.stringify({
          cohortId: cohort.id,
          blockId: block.id,
          serviceId: serviceId || null,
          label,
          clear,
        }),
      }),
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  return (
    <Sheet open title={`${cohort.label} · ${block.label}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {block.startDate} to {block.endDate}
          {block.kind ? ` · ${block.kind}` : ""}
        </p>

        <Field label="Service">
          <select
            className="input"
            value={serviceId}
            onChange={(event) => setServiceId(event.target.value)}
          >
            <option value="">No service</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Or a label"
          hint="For a block with no service — vacation, research, an away elective."
        >
          <input
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Vacation"
          />
        </Field>

        {save.error ? (
          <p role="alert" className="text-sm text-critical">
            {save.error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button loading={save.pending} loadingLabel="Saving…" onClick={() => save.run(false)}>
            Save
          </Button>
          {current ? (
            <Button variant="secondary" onClick={() => save.run(true)}>
              Clear
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
    </label>
  );
}
