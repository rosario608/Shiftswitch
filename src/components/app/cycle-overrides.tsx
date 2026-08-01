"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarOff, Snowflake, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Suspending a rotation cycle over a range, and saying why.
 *
 * The one every programme has is the winter holiday fortnight: two weeks with
 * their own per-service rosters, worked out on a whiteboard and typed in by
 * hand. It is offered as a preset here because it is universal — and because
 * the correct way to express it is not obvious.
 *
 * "Nothing applies here" is **not** the same as "everybody is off". A programme
 * whose holiday roster is decided elsewhere needs the first; writing the second
 * tells everything downstream that a fortnight of people are free, which is the
 * kind of confident wrongness this product cannot afford. So the choice is
 * spelled out in those words rather than left to whoever fills the form.
 */

export interface CycleOption {
  id: string;
  name: string;
  serviceName: string | null;
  cycleDays: number;
  provenance: string;
}

export interface OverrideView {
  id: string;
  startsOn: string;
  endsOn: string;
  reason: string;
  appliesTo: string;
  replaces: string;
}

export function CycleOverrides({
  cycles,
  overrides,
  holidayPreset,
}: {
  cycles: CycleOption[];
  overrides: OverrideView[];
  holidayPreset: { startsOn: string; endsOn: string; reason: string };
}) {
  const router = useRouter();
  const [patternId, setPatternId] = React.useState(cycles[0]?.id ?? "");
  const [startsOn, setStartsOn] = React.useState(holidayPreset.startsOn);
  const [endsOn, setEndsOn] = React.useState(holidayPreset.endsOn);
  const [reason, setReason] = React.useState("");
  const [mode, setMode] = React.useState<"nothing" | "off">("nothing");

  const create = useAction(
    async () =>
      apiFetch("/api/admin/cycles/exceptions", {
        method: "POST",
        body: JSON.stringify({
          patternId: patternId || null,
          startsOn,
          endsOn,
          reason: reason.trim(),
          /* Empty for "nothing applies", a one-day cycle of `off` for a genuine
             shutdown. The two are different facts and only one is safe to
             schedule against. */
          replacementStates: mode === "off" ? ["off"] : [],
        }),
      }),
    {
      onSuccess: () => {
        setReason("");
        router.refresh();
      },
    },
  );

  const remove = useAction(
    async (id: string) =>
      apiFetch(`/api/admin/cycles/exceptions/${id}`, { method: "DELETE" }),
    { onSuccess: () => router.refresh() },
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-4">
          <div>
            <p className="font-semibold text-ink">Suspend a cycle for a while</p>
            <p className="mt-1 text-sm text-ink-muted">
              A holiday block, a conference week, anything the normal pattern does
              not describe. The cycle underneath comes back on its own when the
              range ends.
            </p>
          </div>

          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setStartsOn(holidayPreset.startsOn);
              setEndsOn(holidayPreset.endsOn);
              setReason(holidayPreset.reason);
              setMode("nothing");
            }}
          >
            <Snowflake className="h-3.5 w-3.5" aria-hidden="true" />
            Winter holiday block
          </Button>

          <Field label="Which cycle" htmlFor="override-pattern">
            <Select
              id="override-pattern"
              value={patternId}
              onChange={(event) => setPatternId(event.target.value)}
            >
              {cycles.map((cycle) => (
                <option key={cycle.id} value={cycle.id}>
                  {cycle.serviceName ? `${cycle.serviceName} · ` : ""}
                  {cycle.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="override-start">
              <Input
                id="override-start"
                type="date"
                value={startsOn}
                onChange={(event) => setStartsOn(event.target.value)}
              />
            </Field>
            <Field label="To" htmlFor="override-end">
              <Input
                id="override-end"
                type="date"
                value={endsOn}
                onChange={(event) => setEndsOn(event.target.value)}
              />
            </Field>
          </div>

          <Field
            label="What applies instead"
            htmlFor="override-mode"
            hint="These are different facts. Only the second one is safe to schedule against."
          >
            <Select
              id="override-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as "nothing" | "off")}
            >
              <option value="nothing">
                Nothing — this roster is decided somewhere else
              </option>
              <option value="off">Everybody on this cycle is off</option>
            </Select>
          </Field>

          <Field
            label="Why"
            htmlFor="override-reason"
            hint="Somebody reading the schedule in March needs to know."
          >
            <Textarea
              id="override-reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
            />
          </Field>

          <Button
            block
            disabled={!patternId || reason.trim().length < 3}
            loading={create.pending}
            loadingLabel="Saving…"
            onClick={() => create.run()}
          >
            <CalendarOff className="h-4 w-4" aria-hidden="true" />
            Suspend it
          </Button>
          <ActionAlert action={create} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <p className="font-semibold text-ink">Ranges that are already different</p>
          {overrides.length === 0 ? (
            <EmptyState
              title="No overrides"
              description="Every cycle runs uninterrupted. When the holidays come round, this is where the fortnight goes."
            />
          ) : (
            <ul className="space-y-2">
              {overrides.map((override) => (
                <li
                  key={override.id}
                  className="flex flex-wrap items-start justify-between gap-2 border-b border-border-base pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {override.startsOn} to {override.endsOn}
                    </p>
                    <p className="text-sm text-ink-muted">
                      {override.appliesTo} · {override.replaces}
                    </p>
                    <p className="text-sm text-ink-subtle">{override.reason}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={remove.pending}
                    onClick={() => remove.run(override.id)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <ActionAlert action={remove} />
        </CardBody>
      </Card>
    </div>
  );
}
