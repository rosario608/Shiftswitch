"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Sheet } from "@/components/ui/sheet";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Asking for a draft.
 *
 * The form is deliberately three fields. A scheduler wants a month; they do not
 * want to choose an algorithm, a strategy or a weighting, and offering those
 * choices would mean the ones they picked wrongly are their fault. The seed is
 * there because a run has to be reproducible, and it is presented as "run it
 * again differently" rather than as a number to reason about.
 *
 * The result is the whole point of the screen. A run that could not be done
 * shows what would have to give, in the programme's own terms, and creates
 * nothing — there is no half-built draft to find later.
 */

interface Relaxation {
  constraintIds: string[];
  message: string;
  slotsRecovered: number;
}

interface GenerationResponse {
  feasible: boolean;
  versionId: string | null;
  versionName: string | null;
  report: {
    demand: { slots: number; filled: number; locked: number };
    coverage: Array<{ serviceName: string; required: number; filled: number }>;
    relaxations: Relaxation[];
    unfilled: Array<{ slot: { serviceName: string; date: string } }>;
    score: { score: number; objectives: Array<{ label: string; pointsLost: number }> };
    fairness: Array<{
      pgyLevel: number;
      residents: Array<{ name: string; shifts: number; nights: number; weekends: number }>;
    }>;
    needsReview: Array<{ reason: string }>;
    stoppedOnBudget: boolean;
    seed: number;
    elapsedMs: number;
  };
}

export function GenerateDraftButton({ timezone }: { timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<GenerationResponse | null>(null);

  const today = React.useMemo(() => localToday(timezone), [timezone]);
  const [periodStart, setPeriodStart] = React.useState(today);
  const [periodEnd, setPeriodEnd] = React.useState(addDays(today, 27));
  const [name, setName] = React.useState("");
  const [seed, setSeed] = React.useState(1);

  const generate = useAction(
    async () =>
      apiFetch<GenerationResponse>("/api/admin/schedule-generation", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || undefined,
          periodStart,
          periodEnd,
          seed,
        }),
      }),
    { onSuccess: (data) => setResult(data) },
  );

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        Build a draft
      </Button>

      {open ? (
        <Sheet
          open
          title="Build a draft schedule"
          onClose={() => {
            setOpen(false);
            setResult(null);
          }}
        >
          <div className="space-y-4">
            {!result ? (
              <>
                <p className="text-sm text-ink-muted">
                  Every coverage requirement, everybody&rsquo;s availability and
                  eligibility, the block year, and every rule you have
                  configured. What comes out is a draft — invisible to residents
                  until you publish it.
                </p>

                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
                    Name
                  </span>
                  <input
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="September"
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold text-ink-subtle uppercase">
                      From
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

                {generate.error ? <Alert tone="error">{generate.error}</Alert> : null}

                <div className="flex gap-2">
                  <Button
                    loading={generate.pending}
                    loadingLabel="Building…"
                    onClick={() => generate.run()}
                  >
                    Build it
                  </Button>
                  <Button variant="secondary" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : result.feasible ? (
              <Success
                result={result}
                onOpen={() => {
                  setOpen(false);
                  router.push(`/admin/scheduler/${result.versionId}`);
                }}
                onAgain={() => {
                  setSeed(seed + 1);
                  setResult(null);
                }}
              />
            ) : (
              <Failure
                result={result}
                onBack={() => setResult(null)}
              />
            )}
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

function Success({
  result,
  onOpen,
  onAgain,
}: {
  result: GenerationResponse;
  onOpen: () => void;
  onAgain: () => void;
}) {
  const { report } = result;
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink">
        <span className="font-semibold text-positive">
          {report.demand.filled} shifts
        </span>{" "}
        built across {report.coverage.length} service
        {report.coverage.length === 1 ? "" : "s"}, and every hard rule holds.
      </p>

      <Card>
        <CardBody className="space-y-1.5">
          {report.coverage.map((row) => (
            <p key={row.serviceName} className="flex justify-between text-sm">
              <span className="text-ink">{row.serviceName}</span>
              <span className={row.filled >= row.required ? "text-ink-muted" : "text-caution"}>
                {row.filled} of {row.required}
              </span>
            </p>
          ))}
        </CardBody>
      </Card>

      <div>
        <p className="text-sm text-ink">
          Quality score <span className="font-semibold">{report.score.score}</span>
          <span className="text-ink-muted"> out of 100</span>
        </p>
        <ul className="mt-1 space-y-0.5">
          {report.score.objectives
            .filter((objective) => objective.pointsLost > 0)
            .map((objective) => (
              <li key={objective.label} className="text-sm text-ink-muted">
                {objective.label} −{objective.pointsLost}
              </li>
            ))}
        </ul>
      </div>

      {report.fairness.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-ink-subtle uppercase">Spread</p>
          {report.fairness.map((level) => {
            const counts = level.residents.map((r) => r.shifts);
            return (
              <p key={level.pgyLevel} className="text-sm text-ink-muted">
                PGY-{level.pgyLevel}: {Math.min(...counts)}–{Math.max(...counts)} shifts
                each, across {level.residents.length} people
              </p>
            );
          })}
        </div>
      ) : null}

      {report.needsReview.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-ink-subtle uppercase">
            Worth a look before you publish
          </p>
          <ul className="mt-1 space-y-0.5">
            {report.needsReview.slice(0, 5).map((entry, index) => (
              <li key={index} className="text-sm text-ink-muted">
                {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-ink-subtle">
        Seed {report.seed} · {(report.elapsedMs / 1000).toFixed(1)}s
        {report.stoppedOnBudget
          ? " · stopped at the time limit, so this is the best it found rather than the best there is"
          : ""}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onOpen}>Open the draft</Button>
        <Button variant="secondary" onClick={onAgain}>
          Try a different arrangement
        </Button>
      </div>
    </div>
  );
}

function Failure({
  result,
  onBack,
}: {
  result: GenerationResponse;
  onBack: () => void;
}) {
  const { report } = result;
  return (
    <div className="space-y-3">
      <Alert tone="error" title="No schedule fits">
        {report.unfilled.length} of the {report.demand.slots} places could not be
        filled without breaking a rule, so nothing has been created.
      </Alert>

      {report.relaxations.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-ink-subtle uppercase">
            What would have to give
          </p>
          <ul className="mt-1 space-y-2">
            {report.relaxations.map((relaxation, index) => (
              <li key={index} className="text-sm text-ink">
                {relaxation.message}
                {relaxation.constraintIds.length > 0 ? (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {relaxation.constraintIds.map((id) => (
                      <Badge key={id} tone="caution">
                        {id.replace(/-/g, " ")}
                      </Badge>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Button variant="secondary" onClick={onBack}>
        Change the dates and try again
      </Button>
    </div>
  );
}

/* The program's today, not the device's — a chief in another timezone should
   still be offered the programme's dates. */
function localToday(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
