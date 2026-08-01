"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * "Check this schedule", and what came back.
 *
 * The report leads with the one thing a chief needs before publishing —
 * whether anything is *wrong*, as opposed to imperfect — and only then offers
 * the detail. Every hard violation is reachable and the count is always the
 * real one: each is a shift somebody cannot work or a ward with nobody on it,
 * and a summary that said "3 problems" when there were three hundred would let
 * somebody publish having read the wrong number. The list itself is capped at
 * the first {@link HARD_SHOWN} with the rest one tap away, because a month
 * that has gone badly wrong can produce hundreds and a page nobody can scroll
 * hides things just as effectively.
 *
 * The soft side is a score with its breakdown, folded away by default. It is
 * genuinely secondary: an unbalanced month is a month people will still work.
 */

/** How many hard violations are shown before the rest are behind a button. */
const HARD_SHOWN = 25;

interface Violation {
  constraintId: string;
  kind: "hard" | "soft";
  label: string;
  message: string;
}

interface Objective {
  constraintId: string;
  label: string;
  penalty: number;
  violationCount: number;
  pointsLost: number;
}

interface Validation {
  summary: { valid: boolean; hardCount: number; softCount: number };
  violations: Violation[];
  score: { score: number; objectives: Objective[] };
  checked: Array<{ id: string; label: string; kind: string; description: string }>;
}

export function ScheduleCheck({
  versionId,
  periodStart,
  periodEnd,
}: {
  versionId?: string | null;
  periodStart?: string;
  periodEnd?: string;
}) {
  const [result, setResult] = React.useState<Validation | null>(null);
  const [showObjectives, setShowObjectives] = React.useState(false);
  const [showAllHard, setShowAllHard] = React.useState(false);
  const [showChecked, setShowChecked] = React.useState(false);

  const check = useAction(
    async () =>
      apiFetch<{ validation: Validation; period: { start: string; end: string } }>(
        "/api/admin/schedule-validation",
        {
          method: "POST",
          body: JSON.stringify({
            versionId: versionId ?? null,
            ...(periodStart && periodEnd
              ? { periodStart, periodEnd }
              : {}),
          }),
        },
      ),
    {
      onSuccess: (data) => {
        setResult(data.validation);
        setShowAllHard(false);
      },
    },
  );

  const hard = result?.violations.filter((v) => v.kind === "hard") ?? [];
  const soft = result?.violations.filter((v) => v.kind === "soft") ?? [];

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-ink">Check this schedule</h2>
            <p className="mt-0.5 max-w-prose text-sm text-ink-muted">
              Every coverage requirement, everybody&rsquo;s availability and
              eligibility, and every rule the programme has configured —
              checked against this schedule as it stands.
            </p>
          </div>
          <Button
            size="sm"
            loading={check.pending}
            loadingLabel="Checking…"
            onClick={() => check.run()}
          >
            {result ? "Check again" : "Check it"}
          </Button>
        </div>

        {check.error ? <Alert tone="error">{check.error}</Alert> : null}

        {result ? (
          <div className="space-y-3 border-t border-border-base pt-3">
            {result.summary.valid ? (
              <div className="flex items-start gap-2">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-positive"
                  aria-hidden="true"
                />
                <p className="text-sm text-ink">
                  <span className="font-semibold">Nothing is wrong with it.</span>{" "}
                  Every service has the people it needs, and nobody is scheduled
                  who cannot work.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-critical"
                  aria-hidden="true"
                />
                <p className="text-sm text-ink">
                  <span className="font-semibold text-critical">
                    {hard.length} {hard.length === 1 ? "problem" : "problems"}
                  </span>{" "}
                  must be fixed before this is published.
                </p>
              </div>
            )}

            {hard.length > 0 ? (
              <>
                <ul className="space-y-2">
                  {(showAllHard ? hard : hard.slice(0, HARD_SHOWN)).map(
                    (violation, index) => (
                      <li
                        key={`${violation.constraintId}-${index}`}
                        className="rounded-lg border border-critical/30 bg-critical/5 px-3 py-2"
                      >
                        <Badge tone="critical">{violation.label}</Badge>
                        <p className="mt-1 text-sm text-ink">{violation.message}</p>
                      </li>
                    ),
                  )}
                </ul>
                {/* Capped, not summarised. The count above is always the real
                    one — a chief can never read "3 problems" when there are
                    three hundred — but rendering every line of a month that has
                    gone badly wrong produces a page nobody can scroll. */}
                {!showAllHard && hard.length > HARD_SHOWN ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setShowAllHard(true)}
                  >
                    Show the other {hard.length - HARD_SHOWN}
                  </Button>
                ) : null}
              </>
            ) : null}

            <div className="border-t border-border-base pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-ink">
                  Quality score{" "}
                  <span className="font-semibold">{result.score.score}</span>
                  <span className="text-ink-muted"> out of 100</span>
                  {soft.length > 0 ? (
                    <span className="text-ink-muted">
                      {" "}
                      · {soft.length} thing{soft.length === 1 ? "" : "s"} worth
                      looking at
                    </span>
                  ) : null}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-expanded={showObjectives}
                  onClick={() => setShowObjectives(!showObjectives)}
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${showObjectives ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                  Breakdown
                </Button>
              </div>

              {showObjectives ? (
                <div className="mt-2 space-y-2">
                  {/* Every objective, including the ones that scored perfectly:
                      "checked and fine" and "not checked" must not look alike. */}
                  <ul className="divide-y divide-border-base rounded-lg border border-border-base">
                    {result.score.objectives.map((objective) => (
                      <li
                        key={objective.constraintId}
                        className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                      >
                        <span className="text-ink">{objective.label}</span>
                        <span
                          className={
                            objective.pointsLost > 0
                              ? "text-caution"
                              : "text-ink-subtle"
                          }
                        >
                          {objective.pointsLost > 0
                            ? `−${objective.pointsLost}`
                            : "fine"}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {soft.map((violation, index) => (
                    <p
                      key={`${violation.constraintId}-${index}`}
                      className="px-1 text-sm text-ink-muted"
                    >
                      <span className="font-medium text-ink">{violation.label}</span>
                      {" — "}
                      {violation.message}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="border-t border-border-base pt-3">
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={showChecked}
                onClick={() => setShowChecked(!showChecked)}
              >
                What was checked ({result.checked.length})
              </Button>
              {showChecked ? (
                <ul className="mt-2 space-y-1.5">
                  {result.checked.map((constraint) => (
                    <li key={constraint.id} className="text-sm">
                      <span className="font-medium text-ink">{constraint.label}</span>
                      <span className="text-ink-subtle">
                        {" "}
                        · {constraint.kind === "hard" ? "must hold" : "preference"}
                      </span>
                      <span className="block text-ink-muted">
                        {constraint.description}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
