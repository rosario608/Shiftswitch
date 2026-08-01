"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Phone, Search } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * The roster, led by availability.
 *
 * The question that brings a chief here is almost never "show me a list of
 * residents". It is "who is free" or "how do I reach this person", and usually
 * somebody has just called in sick. So: the count of who is unavailable sits at
 * the top and is the one thing readable at a glance, the phone number is a tap
 * (a real `tel:` link, because the next action is a phone call), and the
 * directory is underneath for when it is genuinely wanted.
 */

interface Resident {
  id: string;
  name: string;
  email: string;
  pgyLevel: number;
  active: boolean;
  schedulable: boolean;
  schedulingNotes: string;
  cohortLabel: string | null;
  upcomingShifts: number;
  phone: string | null;
  phoneDisplay: string | null;
}

export function RosterManager({
  residents,
  sites,
  cohortCount,
  mayReadPhone,
}: {
  residents: Resident[];
  sites: Array<{ id: string; name: string }>;
  cohortCount: number;
  mayReadPhone: boolean;
}) {
  const [editing, setEditing] = React.useState<Resident | null>(null);
  const [filter, setFilter] = React.useState("");
  const [onlyUnavailable, setOnlyUnavailable] = React.useState(false);

  const unavailable = residents.filter(
    (resident) => resident.active && !resident.schedulable,
  );

  const shown = residents.filter((resident) => {
    if (onlyUnavailable && resident.schedulable) return false;
    if (!filter.trim()) return true;
    const needle = filter.trim().toLowerCase();
    return (
      resident.name.toLowerCase().includes(needle) ||
      resident.email.toLowerCase().includes(needle) ||
      (resident.cohortLabel ?? "").toLowerCase().includes(needle) ||
      `pgy-${resident.pgyLevel}`.includes(needle)
    );
  });

  if (residents.length === 0) {
    return (
      <EmptyState
        title="Nobody on the roster yet"
        description="Residents appear here once they accept an invitation. Invite them from Users & roles."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Availability first: the thing somebody standing in a corridor needs. */}
      <Card>
        <CardBody>
          {unavailable.length === 0 ? (
            <p className="text-sm text-ink">
              <span className="font-semibold">All {residents.length}</span>{" "}
              residents are available to schedule.
            </p>
          ) : (
            <>
              <p className="text-sm text-ink">
                <span className="font-semibold text-caution">
                  {unavailable.length}
                </span>{" "}
                of {residents.length} cannot be scheduled right now.
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {unavailable.map((resident) => (
                  <li key={resident.id} className="text-sm text-ink-muted">
                    <span className="font-medium text-ink">{resident.name}</span>
                    {resident.schedulingNotes ? ` — ${resident.schedulingNotes}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          {cohortCount === 0 ? (
            <p className="mt-2 text-sm text-ink-subtle">
              No cohorts yet, so everybody has to be scheduled individually.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1">
          <span className="sr-only">Search the roster</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-subtle"
            aria-hidden="true"
          />
          <input
            className="input pl-9"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Name, email, cohort, PGY…"
          />
        </label>
        <Button
          size="sm"
          variant={onlyUnavailable ? "primary" : "secondary"}
          aria-pressed={onlyUnavailable}
          onClick={() => setOnlyUnavailable(!onlyUnavailable)}
        >
          Unavailable only
        </Button>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title="Nobody matches"
          description={
            onlyUnavailable
              ? "Everybody is available to schedule."
              : `No resident matches “${filter}”.`
          }
        />
      ) : (
        <ul className="space-y-2">
          {shown.map((resident) => (
            <li key={resident.id}>
              <Card>
                <CardBody className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">
                        {resident.name}{" "}
                        <span className="font-normal text-ink-muted">
                          · PGY-{resident.pgyLevel}
                        </span>
                      </p>
                      <p className="mt-0.5 text-sm text-ink-muted">
                        {resident.cohortLabel ?? "No cohort"} ·{" "}
                        {resident.upcomingShifts} upcoming shift
                        {resident.upcomingShifts === 1 ? "" : "s"}
                      </p>
                      {resident.schedulingNotes ? (
                        <p className="mt-0.5 text-sm text-ink-subtle">
                          {resident.schedulingNotes}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {!resident.active ? (
                        <Badge tone="neutral">Left the program</Badge>
                      ) : !resident.schedulable ? (
                        <Badge tone="caution">Not schedulable</Badge>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-t border-border-base pt-2">
                    {/* A real tel: link, because the next thing that happens
                        after finding a number at 2am is a phone call. */}
                    {resident.phoneDisplay ? (
                      <a
                        href={`tel:${resident.phone}`}
                        className="inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm font-semibold text-ink hover:bg-surface-muted"
                      >
                        <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                        {resident.phoneDisplay}
                      </a>
                    ) : mayReadPhone ? (
                      <span className="text-sm text-ink-subtle">No phone number</span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditing(resident)}
                    >
                      Edit
                    </Button>
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <ResidentSheet
          resident={editing}
          sites={sites}
          mayReadPhone={mayReadPhone}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function ResidentSheet({
  resident,
  sites,
  mayReadPhone,
  onClose,
}: {
  resident: Resident;
  sites: Array<{ id: string; name: string }>;
  mayReadPhone: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [phone, setPhone] = React.useState(resident.phoneDisplay ?? "");
  const [pgyLevel, setPgyLevel] = React.useState(resident.pgyLevel);
  const [schedulable, setSchedulable] = React.useState(resident.schedulable);
  const [notes, setNotes] = React.useState(resident.schedulingNotes);
  const [eligibility, setEligibility] = React.useState<
    Array<{ siteId: string; siteName: string; eligible: boolean }> | null
  >(null);

  /* Site eligibility is loaded when the sheet opens rather than shipped with
     the list: it is one row per resident per site, it is rarely looked at, and
     putting it in the roster payload would multiply the page's size by the
     number of sites for information almost nobody scrolls to. */
  React.useEffect(() => {
    let cancelled = false;
    apiFetch<{ sites: Array<{ site_id: string; site_name: string; eligible: boolean }> }>(
      `/api/admin/roster/${resident.id}`,
    )
      .then((data) => {
        if (cancelled) return;
        setEligibility(
          data.sites.map((entry) => ({
            siteId: entry.site_id,
            siteName: entry.site_name,
            eligible: entry.eligible,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setEligibility([]);
      });
    return () => {
      cancelled = true;
    };
  }, [resident.id]);

  const save = useAction(
    async () =>
      apiFetch(`/api/admin/roster/${resident.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(mayReadPhone ? { phone } : {}),
          pgyLevel,
          schedulable,
          schedulingNotes: notes,
          siteEligibility: (eligibility ?? []).map((entry) => ({
            siteId: entry.siteId,
            eligible: entry.eligible,
          })),
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
    <Sheet open title={resident.name} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{resident.email}</p>

        {mayReadPhone ? (
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
              Phone
            </span>
            <input
              className="input"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(919) 555-0142"
              inputMode="tel"
            />
            <span className="mt-1 block text-xs text-ink-muted">
              Any format. Visible to chief residents and program leadership only.
            </span>
          </label>
        ) : null}

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
            Training level
          </span>
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
        </label>

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={schedulable}
            onChange={(event) => setSchedulable(event.target.checked)}
          />
          <span>
            Available to schedule
            <span className="block text-ink-muted">
              Turn this off for leave or research. Different from leaving the
              program — they stay on the roster and keep their history.
            </span>
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
            Scheduling notes
          </span>
          <textarea
            className="input min-h-[3.5rem]"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="On parental leave until March."
          />
        </label>

        {sites.length > 0 ? (
          <fieldset className="space-y-2 border-t border-border-base pt-3">
            <legend className="text-sm font-semibold text-ink">
              Sites they may work
            </legend>
            {eligibility === null ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : (
              eligibility.map((entry, index) => (
                <label key={entry.siteId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={entry.eligible}
                    onChange={(event) =>
                      setEligibility(
                        eligibility.map((item, i) =>
                          i === index ? { ...item, eligible: event.target.checked } : item,
                        ),
                      )
                    }
                  />
                  <span className="text-ink">{entry.siteName}</span>
                </label>
              ))
            )}
            <p className="text-xs text-ink-muted">
              Uncheck a site somebody is not credentialed for. Nothing recorded
              means no restriction.
            </p>
          </fieldset>
        ) : null}

        {save.error ? <Alert tone="error">{save.error}</Alert> : null}

        <div className="flex gap-2">
          <Button loading={save.pending} loadingLabel="Saving…" onClick={() => save.run()}>
            Save
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
