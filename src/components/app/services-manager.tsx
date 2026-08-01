"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Pencil, Plus, Settings, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

export interface ServiceRow {
  id: string;
  name: string;
  abbreviation: string;
  active: boolean;
  tradeable: boolean;
  shift_count: number;
  upcoming_shift_count: number;
  /** Services only: the scheduling configuration summary. */
  site_name?: string | null;
  coverage_count?: number;
  coverage_mandatory?: boolean;
}

type Kind = "service" | "rotation";

const COPY: Record<
  Kind,
  { one: string; many: string; add: string; blurb: string; empty: string }
> = {
  service: {
    one: "service",
    many: "Services",
    add: "Add service",
    blurb:
      "Where the work happens — MICU, Wards, Night Float. Every shift belongs to exactly one, and residents can only swap shifts on a service you allow to be swapped.",
    empty:
      "No services yet. Add the ones your program runs, or import a schedule — the import creates any service it finds and you can tidy the names here afterwards.",
  },
  rotation: {
    one: "rotation",
    many: "Rotations",
    add: "Add rotation",
    blurb:
      "The educational block a shift belongs to — Critical Care, Ambulatory. Optional: a shift does not need one.",
    empty: "No rotations yet. These are optional; add them if your program uses them.",
  },
};

/**
 * Service and rotation management.
 *
 * The screen answers the question an administrator actually arrives with —
 * "how do I add a service?" — with a labelled button, not a hidden affordance.
 * Everything else on the page is secondary to that.
 */
export function ServicesManager({
  services,
  rotations,
  mayManage,
}: {
  services: ServiceRow[];
  rotations: ServiceRow[];
  /**
   * `services.manage`. Without it the screen is still useful — it is the route
   * to each service's coverage requirements, which belong to `scheduling.plan`
   * — but nothing on it may be added, renamed or deactivated.
   */
  mayManage: boolean;
}) {
  return (
    <div className="space-y-8">
      <Section kind="service" rows={services} mayManage={mayManage} />
      <Section kind="rotation" rows={rotations} mayManage={mayManage} />
    </div>
  );
}

function Section({
  kind,
  rows,
  mayManage,
}: {
  kind: Kind;
  rows: ServiceRow[];
  mayManage: boolean;
}) {
  const copy = COPY[kind];
  const [adding, setAdding] = React.useState(false);
  const active = rows.filter((row) => row.active);
  const inactive = rows.filter((row) => !row.active);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose">
          <h2 className="text-lg font-semibold text-ink">{copy.many}</h2>
          <p className="mt-1 text-sm text-ink-muted">{copy.blurb}</p>
        </div>
        {mayManage ? (
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy.add}
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-ink-muted">{copy.empty}</CardBody>
        </Card>
      ) : (
        <ul className="space-y-2">
          {active.map((row) => (
            <Row key={row.id} kind={kind} row={row} mayManage={mayManage} />
          ))}
          {inactive.length > 0 && (
            <li className="pt-2 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
              Inactive
            </li>
          )}
          {inactive.map((row) => (
            <Row key={row.id} kind={kind} row={row} mayManage={mayManage} />
          ))}
        </ul>
      )}

      <ServiceSheet
        key={adding ? "add-open" : "add-closed"}
        kind={kind}
        open={adding}
        onClose={() => setAdding(false)}
      />
    </section>
  );
}

function Row({
  kind,
  row,
  mayManage,
}: {
  kind: Kind;
  row: ServiceRow;
  mayManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);

  const toggle = useAction(
    async () =>
      apiFetch(`/api/admin/services/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ kind, active: !row.active }),
      }),
    { onSuccess: () => router.refresh() },
  );

  return (
    <li>
      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">
                {row.name}
                {row.abbreviation ? (
                  <span className="ml-2 text-sm text-ink-subtle">
                    ({row.abbreviation})
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-ink-subtle">
                {row.shift_count === 0
                  ? "No shifts yet"
                  : `${row.shift_count} shift${row.shift_count === 1 ? "" : "s"}` +
                    (row.upcoming_shift_count > 0
                      ? ` · ${row.upcoming_shift_count} upcoming`
                      : "")}
              </p>
              {kind === "service" ? (
                <p className="mt-0.5 text-sm text-ink-subtle">
                  {row.site_name ?? "No site"}
                  {" · "}
                  {row.coverage_count
                    ? `${row.coverage_count} coverage rule${row.coverage_count === 1 ? "" : "s"}`
                    : "no coverage set"}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {kind === "service" && row.coverage_mandatory && !row.coverage_count ? (
                /* The state worth surfacing on the list rather than one level
                   in: a service that must be covered, with nothing saying by
                   how many people, will never warn anybody that it is short. */
                <Badge tone="critical">No coverage set</Badge>
              ) : null}
              {kind === "service" && !row.tradeable && (
                <Badge tone="neutral">Not swappable</Badge>
              )}
              <Badge tone={row.active ? "positive" : "neutral"}>
                {row.active ? "Active" : "Inactive"}
              </Badge>
            </div>
          </div>

          {toggle.error && <Alert tone="error">{toggle.error}</Alert>}

          <div className="flex flex-wrap gap-2">
            {mayManage ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit
              </Button>
            ) : null}
            {kind === "service" ? (
              <Link
                href={`/admin/services/${row.id}`}
                className="inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm font-semibold text-ink-muted hover:bg-surface-muted"
              >
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                Configure
              </Link>
            ) : null}
            {mayManage ? (
              <Button
                size="sm"
                variant="ghost"
                loading={toggle.pending}
                onClick={toggle.run}
              >
                {row.active ? (
                  <>
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Deactivate
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    Reactivate
                  </>
                )}
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <ServiceSheet
        key={editing ? `edit-${row.id}-open` : `edit-${row.id}-closed`}
        kind={kind}
        row={row}
        open={editing}
        onClose={() => setEditing(false)}
      />
    </li>
  );
}

function ServiceSheet({
  kind,
  row,
  open,
  onClose,
}: {
  kind: Kind;
  row?: ServiceRow;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const copy = COPY[kind];
  /* State is initialised from props once. The caller remounts this component
     each time the sheet opens (see the `key` below), so reopening after a change
     elsewhere shows the current values without an effect that writes state back
     on every render. */
  const [name, setName] = React.useState(row?.name ?? "");
  const [abbreviation, setAbbreviation] = React.useState(row?.abbreviation ?? "");
  const [tradeable, setTradeable] = React.useState(row?.tradeable ?? true);

  const save = useAction(
    async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error(`Give the ${copy.one} a name.`);
      const body = JSON.stringify({
        kind,
        name: trimmed,
        abbreviation: abbreviation.trim(),
        ...(kind === "service" ? { tradeable } : {}),
      });
      return row
        ? apiFetch(`/api/admin/services/${row.id}`, { method: "PATCH", body })
        : apiFetch("/api/admin/services", { method: "POST", body });
    },
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={row ? `Edit ${copy.one}` : copy.add}
      description={
        row
          ? "Renaming keeps every shift attached — nothing moves."
          : `Names are compared without case, so you cannot end up with two ${copy.one}s that differ only in capitalisation.`
      }
    >
      <div className="space-y-4">
        <Field
          label="Name"
          htmlFor={`svc-name-${row?.id ?? "new"}`}
          hint={kind === "service" ? "e.g. MICU, Wards, Night Float" : "e.g. Critical Care"}
        >
          <Input
            id={`svc-name-${row?.id ?? "new"}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </Field>

        <Field
          label="Short name (optional)"
          htmlFor={`svc-abbr-${row?.id ?? "new"}`}
          hint="Used where space is tight, like a month grid. Leave blank to use the full name."
        >
          <Input
            id={`svc-abbr-${row?.id ?? "new"}`}
            value={abbreviation}
            maxLength={16}
            onChange={(event) => setAbbreviation(event.target.value)}
            placeholder="e.g. ICU"
          />
        </Field>

        {kind === "service" && (
          <label className="flex items-start gap-3 rounded-card border border-border-base p-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={tradeable}
              onChange={(event) => setTradeable(event.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-ink">Residents may swap these shifts</span>
              <span className="mt-0.5 block text-ink-muted">
                Turn this off for sessions the program does not allow to be swapped,
                such as continuity clinic.
              </span>
            </span>
          </label>
        )}

        {save.error && <Alert tone="error">{save.error}</Alert>}

        <Button block loading={save.pending} onClick={save.run}>
          {row ? "Save changes" : copy.add}
        </Button>
      </div>
    </Sheet>
  );
}
