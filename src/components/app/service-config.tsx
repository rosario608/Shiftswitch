"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * One service's configuration, and its coverage requirements.
 *
 * The coverage editor is the part that matters. A requirement is a sentence —
 * "on weekdays, between 07:00 and 19:00, this service needs 2 to 3 people, at
 * least one of them a senior" — and the form is laid out to read as that
 * sentence rather than as a row of database columns.
 */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

interface PgyMixEntry {
  pgy: number;
  min: number;
  max: number | null;
}

interface Coverage {
  id: string;
  scope: "weekday" | "period" | "date";
  label: string;
  daysOfWeek: number[];
  specificDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  startTime: string | null;
  endTime: string | null;
  minStaff: number;
  maxStaff: number | null;
  pgyMix: PgyMixEntry[];
  notes: string;
}

interface Service {
  id: string;
  name: string;
  abbreviation: string;
  siteId: string | null;
  pgyMin: number;
  pgyMax: number;
  typicalShiftHours: number | null;
  tradeable: boolean;
  active: boolean;
  coverageMandatory: boolean;
  notes: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  shiftCount: number;
}

/**
 * Two halves under two capabilities.
 *
 * `services.manage` says what the service *is* — its site, its PGY range,
 * whether its shifts may be swapped. `scheduling.plan` says how many people it
 * needs, which is the generator's primary input. A chief resident holds the
 * second and not the first, so they see the identity as a read-only summary
 * and the coverage as something they can change. Rendering a summary rather
 * than a disabled form is deliberate: a greyed-out field invites somebody to
 * hunt for the permission that would ungrey it, and there isn't one — this is
 * simply not their half of the screen.
 */
export function ServiceConfig({
  service,
  sites,
  coverage,
  mayEditService,
  mayEditCoverage,
}: {
  service: Service;
  sites: Array<{ id: string; name: string }>;
  coverage: Coverage[];
  mayEditService: boolean;
  mayEditCoverage: boolean;
}) {
  const [editing, setEditing] = React.useState<Coverage | null>(null);
  const [adding, setAdding] = React.useState(false);

  return (
    <div className="space-y-6">
      {mayEditService ? (
        <ServiceFields service={service} sites={sites} />
      ) : (
        <ServiceSummary service={service} sites={sites} />
      )}

      <section>
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">
            Coverage
          </h2>
          {mayEditCoverage ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add a requirement
            </Button>
          ) : null}
        </div>

        {coverage.length === 0 ? (
          <EmptyState
            title="No coverage set"
            description={
              service.coverageMandatory
                ? "This service is marked as needing coverage, but nothing says how many people. Nothing will warn you when it is short."
                : "Say how many people this service needs, and when. You can vary it by weekday, by a date range, or for one specific day."
            }
            action={
              mayEditCoverage ? (
                <Button onClick={() => setAdding(true)}>Add a requirement</Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-2">
            {coverage.map((requirement) => (
              <li key={requirement.id}>
                <Card>
                  <CardBody className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-ink">
                          {requirement.label || describeScope(requirement)}
                        </p>
                        <p className="mt-0.5 text-sm text-ink-muted">
                          {describeRequirement(requirement)}
                        </p>
                        {requirement.pgyMix.length > 0 ? (
                          <p className="mt-0.5 text-sm text-ink-subtle">
                            {requirement.pgyMix
                              .map(
                                (entry) =>
                                  `PGY-${entry.pgy}: ${entry.min}${
                                    entry.max != null ? `–${entry.max}` : "+"
                                  }`,
                              )
                              .join(" · ")}
                          </p>
                        ) : null}
                      </div>
                      <Badge tone="neutral">{SCOPE_LABEL[requirement.scope]}</Badge>
                    </div>
                    {mayEditCoverage ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditing(requirement)}
                      >
                        Edit
                      </Button>
                    ) : null}
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {adding || editing ? (
        <CoverageSheet
          serviceId={service.id}
          requirement={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

const SCOPE_LABEL = {
  weekday: "Weekly",
  period: "Date range",
  date: "One day",
} as const;

function describeScope(requirement: Coverage): string {
  if (requirement.scope === "date") return requirement.specificDate ?? "One day";
  if (requirement.scope === "period") {
    return `${requirement.periodStart} to ${requirement.periodEnd}`;
  }
  const days = requirement.daysOfWeek;
  if (days.length === 7) return "Every day";
  if (sameDays(days, WEEKDAYS)) return "Weekdays";
  if (sameDays(days, WEEKEND)) return "Weekends";
  return days.map((day) => DAY_LABELS[day]).join(", ");
}

/** The requirement as a sentence, which is how a scheduler reads it. */
function describeRequirement(requirement: Coverage): string {
  const when =
    requirement.startTime && requirement.endTime
      ? ` between ${requirement.startTime} and ${requirement.endTime}`
      : "";
  const people =
    requirement.maxStaff == null
      ? `${requirement.minStaff} or more`
      : requirement.maxStaff === requirement.minStaff
        ? `exactly ${requirement.minStaff}`
        : `${requirement.minStaff} to ${requirement.maxStaff}`;
  return `${describeScope(requirement)}${when} · needs ${people} ${
    requirement.maxStaff === 1 && requirement.minStaff === 1 ? "person" : "people"
  }`;
}

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/** The identity half, for somebody who may read it but not change it. */
function ServiceSummary({
  service,
  sites,
}: {
  service: Service;
  sites: Array<{ id: string; name: string }>;
}) {
  const site = sites.find((candidate) => candidate.id === service.siteId);
  const rows: Array<[string, string]> = [
    ["Site", site?.name ?? "No site"],
    [
      "Training levels",
      service.pgyMin === service.pgyMax
        ? `PGY-${service.pgyMin}`
        : `PGY-${service.pgyMin} to PGY-${service.pgyMax}`,
    ],
    [
      "Typical shift",
      service.typicalShiftHours == null
        ? "No typical length"
        : `${service.typicalShiftHours} hours`,
    ],
    [
      "Coverage",
      service.coverageMandatory
        ? "Must be staffed every day it runs"
        : "A gap here is not flagged as a problem",
    ],
    [
      "Switching",
      service.tradeable
        ? "Residents may swap these shifts"
        : "These shifts cannot be swapped",
    ],
  ];

  return (
    <Card>
      <CardBody className="space-y-3">
        <h2 className="font-semibold text-ink">What this service is</h2>
        <dl className="space-y-2 text-sm">
          {rows.map(([term, value]) => (
            <div key={term} className="flex flex-wrap gap-x-2">
              <dt className="min-w-[9rem] text-ink-muted">{term}</dt>
              <dd className="font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        {service.notes ? (
          <p className="text-sm whitespace-pre-line text-ink-muted">{service.notes}</p>
        ) : null}
        <p className="text-sm text-ink-subtle">
          Program leadership sets these. Coverage below is yours to change.
        </p>
      </CardBody>
    </Card>
  );
}

function ServiceFields({
  service,
  sites,
}: {
  service: Service;
  sites: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [siteId, setSiteId] = React.useState(service.siteId ?? "");
  const [pgyMin, setPgyMin] = React.useState(service.pgyMin);
  const [pgyMax, setPgyMax] = React.useState(service.pgyMax);
  const [hours, setHours] = React.useState(
    service.typicalShiftHours == null ? "" : String(service.typicalShiftHours),
  );
  const [tradeable, setTradeable] = React.useState(service.tradeable);
  const [mandatory, setMandatory] = React.useState(service.coverageMandatory);
  const [notes, setNotes] = React.useState(service.notes);
  const [contactName, setContactName] = React.useState(service.contactName);
  const [contactEmail, setContactEmail] = React.useState(service.contactEmail);
  const [contactPhone, setContactPhone] = React.useState(service.contactPhone);

  const save = useAction(
    async () => {
      if (pgyMax < pgyMin) {
        throw new Error(
          `This service would be open to PGY-${pgyMin} through PGY-${pgyMax}, which is nobody.`,
        );
      }
      return apiFetch(`/api/admin/services/${service.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          kind: "service",
          name: service.name,
          siteId: siteId || null,
          pgyMin,
          pgyMax,
          typicalShiftHours: hours.trim() === "" ? null : Number(hours),
          tradeable,
          coverageMandatory: mandatory,
          notes,
          contactName,
          contactEmail,
          contactPhone,
        }),
      });
    },
    { onSuccess: () => router.refresh() },
  );

  return (
    <Card>
      <CardBody className="space-y-4">
        <h2 className="font-semibold text-ink">What this service is</h2>

        <Labelled label="Site">
          <select
            className="input"
            value={siteId}
            onChange={(event) => setSiteId(event.target.value)}
          >
            <option value="">No site</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </Labelled>

        <div className="grid grid-cols-2 gap-3">
          <Labelled label="Lowest PGY">
            <select
              className="input"
              value={pgyMin}
              onChange={(event) => setPgyMin(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((level) => (
                <option key={level} value={level}>
                  PGY-{level}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Highest PGY">
            <select
              className="input"
              value={pgyMax}
              onChange={(event) => setPgyMax(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((level) => (
                <option key={level} value={level}>
                  PGY-{level}
                </option>
              ))}
            </select>
          </Labelled>
        </div>

        <Labelled
          label="Typical shift length (hours)"
          hint="Leave empty if there isn't one — clinic sessions and electives often have no typical length."
        >
          <input
            type="number"
            step="0.5"
            min="0"
            max="48"
            className="input"
            value={hours}
            onChange={(event) => setHours(event.target.value)}
          />
        </Labelled>

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={mandatory}
            onChange={(event) => setMandatory(event.target.checked)}
          />
          <span>
            Coverage is mandatory
            <span className="block text-ink-muted">
              This service must be staffed every day it runs. Leaving it short is
              flagged as a problem rather than a gap.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={tradeable}
            onChange={(event) => setTradeable(event.target.checked)}
          />
          <span>
            Residents may swap these shifts
            <span className="block text-ink-muted">
              Turn this off for continuity clinic, where the point is that the
              same resident sees the same patients.
            </span>
          </span>
        </label>

        <Labelled label="Notes">
          <textarea
            className="input min-h-[4rem]"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Labelled>

        <fieldset className="space-y-3 border-t border-border-base pt-3">
          <legend className="text-sm font-semibold text-ink">
            Who to contact about this service
          </legend>
          <Labelled label="Name">
            <input
              className="input"
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
            />
          </Labelled>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labelled label="Email">
              <input
                type="email"
                className="input"
                value={contactEmail}
                onChange={(event) => setContactEmail(event.target.value)}
              />
            </Labelled>
            <Labelled label="Phone">
              <input
                className="input"
                value={contactPhone}
                onChange={(event) => setContactPhone(event.target.value)}
              />
            </Labelled>
          </div>
        </fieldset>

        {save.error ? <Alert tone="error">{save.error}</Alert> : null}

        <Button loading={save.pending} loadingLabel="Saving…" onClick={() => save.run()}>
          Save
        </Button>
      </CardBody>
    </Card>
  );
}

function CoverageSheet({
  serviceId,
  requirement,
  onClose,
}: {
  serviceId: string;
  requirement: Coverage | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [scope, setScope] = React.useState<Coverage["scope"]>(
    requirement?.scope ?? "weekday",
  );
  const [label, setLabel] = React.useState(requirement?.label ?? "");
  const [days, setDays] = React.useState<number[]>(requirement?.daysOfWeek ?? WEEKDAYS);
  const [specificDate, setSpecificDate] = React.useState(requirement?.specificDate ?? "");
  const [periodStart, setPeriodStart] = React.useState(requirement?.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = React.useState(requirement?.periodEnd ?? "");
  const [startTime, setStartTime] = React.useState(requirement?.startTime ?? "");
  const [endTime, setEndTime] = React.useState(requirement?.endTime ?? "");
  const [minStaff, setMinStaff] = React.useState(requirement?.minStaff ?? 1);
  const [maxStaff, setMaxStaff] = React.useState(
    requirement?.maxStaff == null ? "" : String(requirement.maxStaff),
  );
  const [pgyMix, setPgyMix] = React.useState<PgyMixEntry[]>(requirement?.pgyMix ?? []);
  const [notes, setNotes] = React.useState(requirement?.notes ?? "");

  const body = () =>
    JSON.stringify({
      serviceId,
      scope,
      label,
      daysOfWeek: scope === "weekday" ? days : undefined,
      specificDate: scope === "date" ? specificDate : null,
      periodStart: scope === "period" ? periodStart : null,
      periodEnd: scope === "period" ? periodEnd : null,
      startTime: startTime || null,
      endTime: endTime || null,
      minStaff,
      maxStaff: maxStaff.trim() === "" ? null : Number(maxStaff),
      pgyMix,
      notes,
    });

  const save = useAction(
    async () =>
      requirement
        ? apiFetch(`/api/admin/coverage/${requirement.id}`, {
            method: "PATCH",
            body: body(),
          })
        : apiFetch("/api/admin/coverage", { method: "POST", body: body() }),
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  const remove = useAction(
    async () =>
      apiFetch(`/api/admin/coverage/${requirement!.id}`, { method: "DELETE" }),
    {
      onSuccess: () => {
        onClose();
        router.refresh();
      },
    },
  );

  return (
    <Sheet
      open
      title={requirement ? "Edit coverage" : "Add coverage"}
      onClose={onClose}
    >
      <div className="space-y-4">
        <Labelled label="When this applies">
          <select
            className="input"
            value={scope}
            onChange={(event) => setScope(event.target.value as Coverage["scope"])}
          >
            <option value="weekday">Certain days of the week</option>
            <option value="period">A range of dates</option>
            <option value="date">One specific day</option>
          </select>
        </Labelled>

        {scope === "weekday" ? (
          <div>
            <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
              Days
            </span>
            <div className="mb-2 flex flex-wrap gap-1.5">
              <PresetButton label="Weekdays" onClick={() => setDays(WEEKDAYS)} />
              <PresetButton label="Weekends" onClick={() => setDays(WEEKEND)} />
              <PresetButton label="Every day" onClick={() => setDays(EVERY_DAY)} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {DAY_LABELS.map((dayLabel, day) => {
                const on = days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setDays(
                        on ? days.filter((d) => d !== day) : [...days, day].sort(),
                      )
                    }
                    className={`min-h-[2.5rem] min-w-[3rem] rounded-lg border px-2 text-sm font-semibold ${
                      on
                        ? "border-brand bg-brand text-white"
                        : "border-border-strong text-ink-muted"
                    }`}
                  >
                    {dayLabel}
                  </button>
                );
              })}
            </div>
          </div>
        ) : scope === "date" ? (
          <Labelled label="Date">
            <input
              type="date"
              className="input"
              value={specificDate}
              onChange={(event) => setSpecificDate(event.target.value)}
            />
          </Labelled>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Labelled label="From">
              <input
                type="date"
                className="input"
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
            </Labelled>
            <Labelled label="To">
              <input
                type="date"
                className="input"
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
              />
            </Labelled>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Labelled label="From (time)" hint="Leave both empty for the whole day.">
            <input
              type="time"
              className="input"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </Labelled>
          <Labelled label="To (time)">
            <input
              type="time"
              className="input"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </Labelled>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Labelled label="At least">
            <input
              type="number"
              min={0}
              max={50}
              className="input"
              value={minStaff}
              onChange={(event) => setMinStaff(Number(event.target.value))}
            />
          </Labelled>
          <Labelled label="At most" hint="Empty means no cap.">
            <input
              type="number"
              min={0}
              max={50}
              className="input"
              value={maxStaff}
              onChange={(event) => setMaxStaff(event.target.value)}
            />
          </Labelled>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink-subtle uppercase">
              Required mix by level
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setPgyMix([...pgyMix, { pgy: pgyMix.length + 1, min: 1, max: null }])
              }
            >
              Add a level
            </Button>
          </div>
          {pgyMix.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No requirement by level. Add one for rules like &ldquo;at least one
              senior&rdquo; or &ldquo;never an intern alone overnight&rdquo;.
            </p>
          ) : (
            <ul className="space-y-2">
              {pgyMix.map((entry, index) => (
                <li key={index} className="flex items-end gap-2">
                  <Labelled label="Level">
                    <select
                      className="input"
                      value={entry.pgy}
                      onChange={(event) =>
                        setPgyMix(
                          pgyMix.map((item, i) =>
                            i === index ? { ...item, pgy: Number(event.target.value) } : item,
                          ),
                        )
                      }
                    >
                      {[1, 2, 3, 4, 5, 6, 7].map((level) => (
                        <option key={level} value={level}>
                          PGY-{level}
                        </option>
                      ))}
                    </select>
                  </Labelled>
                  <Labelled label="Min">
                    <input
                      type="number"
                      min={0}
                      className="input"
                      value={entry.min}
                      onChange={(event) =>
                        setPgyMix(
                          pgyMix.map((item, i) =>
                            i === index ? { ...item, min: Number(event.target.value) } : item,
                          ),
                        )
                      }
                    />
                  </Labelled>
                  <Labelled label="Max">
                    <input
                      type="number"
                      min={0}
                      className="input"
                      value={entry.max ?? ""}
                      onChange={(event) =>
                        setPgyMix(
                          pgyMix.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  max:
                                    event.target.value === ""
                                      ? null
                                      : Number(event.target.value),
                                }
                              : item,
                          ),
                        )
                      }
                    />
                  </Labelled>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove PGY-${entry.pgy}`}
                    onClick={() => setPgyMix(pgyMix.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Labelled label="Label" hint="What you call this. “Weeknights”, “Holiday cover”.">
          <input
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Labelled>

        <Labelled label="Notes">
          <textarea
            className="input min-h-[3rem]"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Labelled>

        {save.error ? <Alert tone="error">{save.error}</Alert> : null}
        {remove.error ? <Alert tone="error">{remove.error}</Alert> : null}

        <div className="flex flex-wrap gap-2">
          <Button loading={save.pending} loadingLabel="Saving…" onClick={() => save.run()}>
            Save
          </Button>
          {requirement ? (
            <Button
              variant="danger"
              loading={remove.pending}
              loadingLabel="Removing…"
              onClick={() => remove.run()}
            >
              Remove
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

function PresetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[2rem] rounded-lg border border-border-strong px-2.5 text-sm font-semibold text-ink-muted hover:bg-surface-muted"
    >
      {label}
    </button>
  );
}

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block flex-1">
      <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
    </label>
  );
}
