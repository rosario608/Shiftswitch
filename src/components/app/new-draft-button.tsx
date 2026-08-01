"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Starting a draft.
 *
 * Defaults to copying the published schedule for the period, because that is
 * what a scheduler almost always wants: next month is last month with things
 * moved, not a blank page. Starting empty is offered, and warned about, because
 * publishing an empty draft clears the live schedule for the period — a real
 * thing to want, and a terrible thing to do by accident.
 */
export function NewDraftButton({ timezone }: { timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const today = React.useMemo(() => localToday(timezone), [timezone]);
  const [name, setName] = React.useState("");
  const [periodStart, setPeriodStart] = React.useState(today);
  const [periodEnd, setPeriodEnd] = React.useState(addDays(today, 27));
  const [copy, setCopy] = React.useState(true);
  const [notes, setNotes] = React.useState("");

  const create = useAction(
    async () =>
      apiFetch<{ version: { id: string } }>("/api/admin/schedule-versions", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || `Draft from ${periodStart}`,
          periodStart,
          periodEnd,
          copyFromPublished: copy,
          notes,
        }),
      }),
    {
      onSuccess: (result) => {
        setOpen(false);
        router.push(`/admin/scheduler/${result.version.id}`);
      },
    },
  );

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Start a draft
      </Button>

      {open ? (
        <Sheet open title="Start a draft schedule" onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              A draft is invisible to residents and cannot be switched. Nothing you
              do in it reaches anybody until you publish it.
            </p>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
                Name
              </span>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="December"
                autoFocus
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
                  Covers from
                </span>
                <input
                  type="date"
                  className="input"
                  value={periodStart}
                  onChange={(event) => setPeriodStart(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
                  To
                </span>
                <input
                  type="date"
                  className="input"
                  value={periodEnd}
                  onChange={(event) => setPeriodEnd(event.target.value)}
                />
              </label>
            </div>

            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={copy}
                onChange={(event) => setCopy(event.target.checked)}
              />
              <span>
                Start from the published schedule
                <span className="block text-ink-muted">
                  {copy
                    ? "Every published shift in this period is copied in, with whoever is on it. Publishing changes only what you move."
                    : "The draft starts empty. Publishing an empty draft deletes every published shift in this period."}
                </span>
              </span>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
                Notes
              </span>
              <textarea
                className="input min-h-[3.5rem]"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Holiday coverage, rebuilt after the January intake."
              />
            </label>

            {create.error ? (
              <p role="alert" className="text-sm text-critical">
                {create.error}
              </p>
            ) : null}

            <div className="flex gap-2">
              <Button
                loading={create.pending}
                loadingLabel="Creating…"
                onClick={() => create.run()}
              >
                Create draft
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

/* The program's today, not the device's. A chief in a different timezone from
   the program should still get the program's dates in the form. */
function localToday(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
