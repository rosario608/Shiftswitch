"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Copy, RefreshCw, XCircle } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ActionAlert } from "@/components/app/action-alert";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * What is wrong, in a sentence, for somebody who does not read stack traces.
 *
 * The audience is the person who owns this product and does not troubleshoot.
 * So the page is built around two things and nothing else:
 *
 *   **A verdict** — one line, in plain English, that says whether residents are
 *   affected right now and what to do about it. Not a table of green ticks to
 *   interpret.
 *
 *   **A copyable report** — the thing you paste into the next goal. That is its
 *   literal purpose, so it is plain text, complete, and one tap to copy.
 *
 * Everything else on the screen is subordinate to those.
 */

export type HealthStatus = "ok" | "degraded" | "failed";

export interface HealthComponentView {
  name: string;
  status: HealthStatus;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface HealthReportView {
  status: HealthStatus;
  checkedAt: string;
  release: string;
  environment: string;
  components: HealthComponentView[];
}

const COMPONENT_LABEL: Record<string, string> = {
  database: "Database",
  migrations: "Database schema",
  auth: "Sign-in",
  email: "Email delivery",
};

/** The verdict. One sentence, and it leads with whether residents can tell. */
function verdict(report: HealthReportView): { title: string; body: string } {
  const failed = report.components.filter((c) => c.status === "failed");
  const degraded = report.components.filter((c) => c.status === "degraded");

  if (failed.length > 0) {
    return {
      title: "Something is broken, and residents are affected right now.",
      body:
        failed.map((component) => component.summary).join(" ") +
        " Copy the report below and send it on — it says exactly what needs doing.",
    };
  }
  if (degraded.length > 0) {
    return {
      title: "ShiftSwitch is working. One thing needs attention when convenient.",
      body:
        degraded.map((component) => component.summary).join(" ") +
        " Nobody's schedule is affected by this.",
    };
  }
  return {
    title: "Everything is working.",
    body:
      "The database is reachable, its schema matches this version of ShiftSwitch, " +
      "and sign-in is configured. Nothing needs doing.",
  };
}

/**
 * The report, as text.
 *
 * Plain text rather than JSON because it gets pasted into a message or a goal,
 * where JSON is noise. It carries the release and the timestamp because the
 * first question anybody asks about a pasted report is "when, and which
 * version". It carries no data about any person — every value in it came from
 * the health check, which reports filenames and whether variables are set.
 */
export function reportText(report: HealthReportView): string {
  const lines = [
    "ShiftSwitch diagnostic report",
    `Taken: ${report.checkedAt}`,
    `Release: ${report.release}`,
    `Environment: ${report.environment}`,
    `Overall: ${report.status.toUpperCase()}`,
    "",
  ];
  for (const component of report.components) {
    lines.push(
      `[${component.status.toUpperCase()}] ${COMPONENT_LABEL[component.name] ?? component.name}`,
    );
    lines.push(`  ${component.summary}`);
    if (component.detail) {
      for (const [key, value] of Object.entries(component.detail)) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        lines.push(`  ${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === "ok") {
    return <CheckCircle2 className="h-5 w-5 text-positive" aria-hidden="true" />;
  }
  if (status === "degraded") {
    return <AlertTriangle className="h-5 w-5 text-caution" aria-hidden="true" />;
  }
  return <XCircle className="h-5 w-5 text-critical" aria-hidden="true" />;
}

export function DiagnosticsPanel({ initial }: { initial: HealthReportView }) {
  const [report, setReport] = React.useState(initial);
  const [copied, setCopied] = React.useState(false);

  const recheck = useAction(
    async () => apiFetch<HealthReportView>("/api/admin/diagnostics", { method: "POST" }),
    { onSuccess: (next) => setReport(next) },
  );

  const text = reportText(report);
  const summary = verdict(report);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3_000);
    } catch {
      /* Clipboard access can be refused — an insecure origin, a permission
         prompt declined. The textarea below is always present and always
         selectable, so there is a way to get the text either way, and claiming
         a copy that did not happen would be the one unforgivable thing on a
         page whose whole job is honesty. */
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <Alert
        tone={
          report.status === "ok" ? "success" : report.status === "degraded" ? "warning" : "error"
        }
        title={summary.title}
      >
        {summary.body}
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          loading={recheck.pending}
          loadingLabel="Checking…"
          onClick={() => recheck.run()}
        >
          <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
          Check again
        </Button>
        <span className="text-xs text-ink-subtle">
          Checked {new Date(report.checkedAt).toLocaleString()} · release {report.release}
        </span>
      </div>

      <ActionAlert action={recheck} />

      <ul className="space-y-2">
        {report.components.map((component) => (
          <li key={component.name}>
            <Card>
              <CardBody className="flex items-start gap-3">
                <StatusIcon status={component.status} />
                <div className="min-w-0">
                  <p className="font-semibold text-ink">
                    {COMPONENT_LABEL[component.name] ?? component.name}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-muted">{component.summary}</p>
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>

      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold text-ink">The report to send on</h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Copy this and paste it wherever you are asking for help. It names
                versions and filenames only — no resident, no schedule, no
                address.
              </p>
            </div>
            <Button variant="secondary" onClick={copy}>
              <Copy className="mr-1 h-4 w-4" aria-hidden="true" />
              {copied ? "Copied" : "Copy report"}
            </Button>
          </div>
          <label className="sr-only" htmlFor="diagnostic-report">
            Diagnostic report
          </label>
          <textarea
            id="diagnostic-report"
            readOnly
            value={text}
            rows={Math.min(24, text.split("\n").length + 1)}
            className="input w-full font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
        </CardBody>
      </Card>
    </div>
  );
}
