"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Entering a week of shifts on a phone.
 *
 * The shape follows what a resident actually holds in their head, which is not
 * one shift: it is "MICU, seven to seven, Monday through Friday". So this asks
 * for the pattern once and then for the days — a grid of the next six weeks
 * where each day is one tap.
 *
 * The alternative, a form per shift, is the version that gets abandoned on the
 * third day. Somebody entering their block at the end of a call shift will do
 * it once; if it takes twenty taps they will not do it at all, and then the
 * product has nothing to show them and no reason to be opened again.
 *
 * Two conveniences carry most of the weight:
 *
 *   - **Every weekday**, because that is the commonest block by a distance.
 *   - **Same day next week**, which turns a q-week pattern into three taps.
 *
 * Neither invents anything: they only tick days in the grid, and what is ticked
 * is what gets sent.
 */

const WEEKDAY_LABEL = ["S", "M", "T", "W", "T", "F", "S"];

function isoDate(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
}

/** Six weeks starting on the Sunday of this week — one block, and a bit. */
function calendarWeeks(from: Date): string[][] {
  const start = new Date(from);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => {
      const at = new Date(start);
      at.setDate(start.getDate() + week * 7 + day);
      return isoDate(at);
    }),
  );
}

export function ShiftEntry({ services }: { services: string[] }) {
  const router = useRouter();
  const weeks = React.useMemo(() => calendarWeeks(new Date()), []);
  const today = React.useMemo(() => isoDate(new Date()), []);

  const [service, setService] = React.useState(services[0] ?? "");
  const [startTime, setStartTime] = React.useState("07:00");
  const [endTime, setEndTime] = React.useState("19:00");
  const [location, setLocation] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());

  const overnight = endTime <= startTime;

  function toggle(date: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  function pickWeekdays() {
    setPicked((current) => {
      const next = new Set(current);
      for (const week of weeks) {
        for (const [index, date] of week.entries()) {
          if (index > 0 && index < 6 && date >= today) next.add(date);
        }
      }
      return next;
    });
  }

  /* Whatever is already ticked, again seven days later. A q-week night float or
     an every-other-weekend pattern is two taps and this button. */
  function repeatNextWeek() {
    setPicked((current) => {
      const next = new Set(current);
      for (const date of current) {
        const at = new Date(`${date}T12:00:00Z`);
        at.setUTCDate(at.getUTCDate() + 7);
        next.add(at.toISOString().slice(0, 10));
      }
      return next;
    });
  }

  const save = useAction(
    async () =>
      apiFetch<{ result: { created: number; duplicates: string[] } }>(
        "/api/shifts/mine",
        {
          method: "POST",
          body: JSON.stringify({
            dates: [...picked].sort(),
            startTime,
            endTime,
            endsNextDay: overnight,
            service,
            location: location.trim() || undefined,
          }),
        },
      ),
    {
      onSuccess: () => {
        setPicked(new Set());
        router.push("/schedule");
        router.refresh();
      },
    },
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="space-y-4">
          <p className="font-semibold text-ink">What are you working?</p>

          <Field
            label="Service"
            htmlFor="entry-service"
            hint="Whatever your program calls it. If it is new, it gets created."
          >
            <Input
              id="entry-service"
              list="entry-service-options"
              value={service}
              onChange={(event) => setService(event.target.value)}
              placeholder="MICU"
              maxLength={120}
            />
          </Field>
          <datalist id="entry-service-options">
            {services.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts" htmlFor="entry-start">
              <Input
                id="entry-start"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </Field>
            <Field label="Ends" htmlFor="entry-end">
              <Input
                id="entry-end"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </Field>
          </div>
          {overnight ? (
            <p className="text-sm text-ink-muted">
              That runs overnight, so each one ends the next morning. It is stored
              as one shift, not two.
            </p>
          ) : null}

          <Field
            label="Where"
            htmlFor="entry-location"
            hint="Optional. Helps whoever might take it from you."
          >
            <Input
              id="entry-location"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="ICU Tower 4"
              maxLength={120}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-ink">Which days?</p>
            <p className="text-sm text-ink-muted">
              {picked.size} day{picked.size === 1 ? "" : "s"} picked
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={pickWeekdays}>
              Every weekday
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={picked.size === 0}
              onClick={repeatNextWeek}
            >
              Same days next week
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={picked.size === 0}
              onClick={() => setPicked(new Set())}
            >
              Clear
            </Button>
          </div>

          <div>
            <div className="grid grid-cols-7 gap-1 pb-1 text-center text-xs text-ink-subtle">
              {WEEKDAY_LABEL.map((label, index) => (
                <span key={index} aria-hidden="true">
                  {label}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {weeks.flat().map((date) => {
                const past = date < today;
                const on = picked.has(date);
                return (
                  <button
                    key={date}
                    type="button"
                    disabled={past}
                    aria-pressed={on}
                    onClick={() => toggle(date)}
                    className={[
                      "flex min-h-[2.75rem] items-center justify-center rounded-lg border text-sm font-medium",
                      past
                        ? "border-transparent text-ink-subtle opacity-40"
                        : on
                          ? "border-transparent bg-brand text-white"
                          : "border-border-base text-ink",
                    ].join(" ")}
                  >
                    <span className="sr-only">{date}</span>
                    <span aria-hidden="true">{Number(date.slice(8, 10))}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </CardBody>
      </Card>

      <ActionAlert action={save} />

      <Button
        block
        disabled={picked.size === 0 || !service.trim()}
        loading={save.pending}
        loadingLabel="Adding…"
        onClick={() => save.run()}
      >
        <CalendarPlus className="h-5 w-5" aria-hidden="true" />
        Add {picked.size} shift{picked.size === 1 ? "" : "s"}
      </Button>

      <p className="text-center text-sm text-ink-subtle">
        These will show as entered by you. Your program can confirm them later —
        either way they switch like any other shift.
      </p>
    </div>
  );
}
