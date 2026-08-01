"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Wand2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Setting a program up from a starting point, and then checking the guesses.
 *
 * The second half is the part that matters. Applying a configuration is a
 * convenience; the list of things nobody has vouched for is the product being
 * honest about which of the numbers on this screen it made up. Until somebody
 * ticks one it fills in nothing, so the list is not a chore — it is the switch
 * that turns each default on.
 */

export interface ConfigurationOption {
  id: string;
  label: string;
  description: string;
  positions: number;
  cycles: number;
  assumed: number;
}

export interface UnconfirmedRow {
  kind: "position" | "cycle";
  id: string;
  serviceName: string;
  name: string;
  summary: string;
  notes: string;
}

export function StartingConfigurationPanel({
  configurations,
  unconfirmed,
  defaultYear,
}: {
  configurations: ConfigurationOption[];
  unconfirmed: UnconfirmedRow[];
  defaultYear: number;
}) {
  const router = useRouter();
  const [id, setId] = React.useState(configurations[0]?.id ?? "");
  const [year, setYear] = React.useState(String(defaultYear));

  const apply = useAction(
    async () =>
      apiFetch<{ result: { positions: number; cycles: number; assumed: number } }>(
        "/api/admin/starting-configuration",
        {
          method: "POST",
          body: JSON.stringify({ id, academicYear: Number(year) }),
        },
      ),
    { onSuccess: () => router.refresh() },
  );

  const chosen = configurations.find((entry) => entry.id === id);

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-4">
          <div>
            <p className="font-semibold text-ink">Start from a common shape</p>
            <p className="mt-1 text-sm text-ink-muted">
              Services, teams and coverage cycles taken from real internal-medicine
              schedules. Everything is editable afterwards, and nothing here is a
              claim about how your program should work.
            </p>
          </div>

          {configurations.length > 1 ? (
            <Field label="Which one" htmlFor="config-id">
              <Select
                id="config-id"
                value={id}
                onChange={(event) => setId(event.target.value)}
              >
                {configurations.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field
            label="Academic year"
            htmlFor="config-year"
            hint="The calendar year it starts in: 2026 for the 2026–27 year. Cycles are anchored to the first Monday in July of that year."
          >
            <Input
              id="config-year"
              type="number"
              min={2000}
              max={2100}
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </Field>

          {chosen ? (
            <p className="text-sm text-ink-muted">
              {chosen.positions} position{chosen.positions === 1 ? "" : "s"} and{" "}
              {chosen.cycles} cycle{chosen.cycles === 1 ? "" : "s"}.{" "}
              {chosen.assumed > 0
                ? `${chosen.assumed} of them are our guess and will not be used until you say they are right.`
                : "Every one of them comes from a program's own document."}
            </p>
          ) : null}

          <Button
            block
            loading={apply.pending}
            loadingLabel="Setting up…"
            onClick={() => apply.run()}
          >
            <Wand2 className="h-4 w-4" aria-hidden="true" />
            Set up {chosen?.label ?? "this program"}
          </Button>
          <ActionAlert action={apply} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div>
            <p className="font-semibold text-ink">
              {unconfirmed.length === 0
                ? "Nothing is waiting on you"
                : `${unconfirmed.length} thing${unconfirmed.length === 1 ? "" : "s"} we guessed`}
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              {unconfirmed.length === 0
                ? "Every default in this program came from a document or has been checked by somebody."
                : "Nobody has said these are right, so nothing is filled in from them. Check one and it starts being used."}
            </p>
          </div>

          {unconfirmed.length > 0 ? (
            <ul className="space-y-3">
              {unconfirmed.map((row) => (
                <UnconfirmedItem key={`${row.kind}-${row.id}`} row={row} />
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

function UnconfirmedItem({ row }: { row: UnconfirmedRow }) {
  const router = useRouter();
  const needsHours = row.kind === "position" && row.summary === "No hours yet";
  const [start, setStart] = React.useState("07:00");
  const [length, setLength] = React.useState("12");
  const [editing, setEditing] = React.useState(false);

  const confirm = useAction(
    async () =>
      apiFetch("/api/admin/starting-configuration/confirm", {
        method: "POST",
        body: JSON.stringify({
          kind: row.kind,
          id: row.id,
          ...(needsHours || editing
            ? {
                defaultStart: start,
                defaultMinutes: Math.round(Number(length) * 60),
              }
            : {}),
        }),
      }),
    { onSuccess: () => router.refresh() },
  );

  return (
    <li className="rounded-xl border border-border-base p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-ink">
            {row.serviceName ? `${row.serviceName} · ` : ""}
            {row.name}
          </p>
          <p className="text-sm text-ink-muted">{row.summary}</p>
        </div>
        <Badge tone="caution">Our guess</Badge>
      </div>

      {row.notes ? (
        <p className="mt-1 text-sm text-ink-subtle">{row.notes}</p>
      ) : null}

      {needsHours || editing ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field label="Starts" htmlFor={`start-${row.id}`}>
            <Input
              id={`start-${row.id}`}
              type="time"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </Field>
          <Field label="Hours long" htmlFor={`length-${row.id}`}>
            <Input
              id={`length-${row.id}`}
              type="number"
              min={0.5}
              max={30}
              step={0.5}
              value={length}
              onChange={(event) => setLength(event.target.value)}
            />
          </Field>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" loading={confirm.pending} onClick={() => confirm.run()}>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {needsHours || editing ? "Save and use it" : "That's right"}
        </Button>
        {!needsHours && !editing && row.kind === "position" ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Change it first
          </Button>
        ) : null}
      </div>

      {confirm.error ? (
        <Alert tone="error" className="mt-2">
          {confirm.error}
        </Alert>
      ) : null}
    </li>
  );
}
