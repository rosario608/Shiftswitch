"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileUp, Upload } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ScheduleCheck } from "@/components/app/schedule-check";
import { ActionAlert } from "@/components/app/action-alert";
import { ApiError, apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

interface ImportIssue {
  row: number;
  column: string;
  message: string;
}

interface ImportRow {
  residentEmail?: string;
  residentName?: string;
  date: string;
  startTime: string;
  endTime: string;
  endsNextDay?: boolean;
  service: string;
  rotation?: string;
  shiftType?: string;
  location?: string;
  pgy?: number;
}

interface ImportPreview {
  rows: ImportRow[];
  issues: ImportIssue[];
  summary: {
    totalRows: number;
    validRows: number;
    unmatched: Array<{ name: string; email: string; rows: number }>;
    heldRows: number;
    hoursFilledIn: number;
    newServices: string[];
    newRotations: string[];
    dateRange: { from: string; to: string } | null;
  };
}

/**
 * Two-step import: the file is validated in full and previewed first. Nothing
 * is written unless every row is valid and the administrator confirms.
 */
export function ImportWizard() {
  const router = useRouter();
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  /* The window that was just imported, so the schedule can be checked the
     moment it lands rather than at some later point when somebody thinks to.
     An imported month is exactly when a coverage gap is cheapest to fix. */
  const [imported, setImported] = React.useState<{
    from: string;
    to: string;
  } | null>(null);

  const commit = useAction(
    async () =>
      apiFetch<{
        result: {
          createdShifts: number;
          createdServices: number;
          createdRotations: number;
          skippedExisting: number;
          heldRows: number;
          heldPeople: number;
          cancelledRows: number;
        };
      }>("/api/admin/import", {
        method: "POST",
        body: JSON.stringify({ rows: preview?.rows ?? [] }),
      }),
    {
      onSuccess: (response) => {
        const held = response.result.heldRows
          ? ` ${response.result.heldRows} shift(s) for ${response.result.heldPeople} person/people who have not joined yet are waiting for them — they appear automatically when those people sign in.`
          : "";
        setResult(
          `Imported ${response.result.createdShifts} shift(s). ${response.result.skippedExisting} already existed and were skipped.${held}`,
        );
        setImported(preview?.summary.dateRange ?? null);
        setPreview(null);
        setFileName(null);
        router.refresh();
      },
    },
  );

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setUploadError(null);
    setResult(null);
    setPreview(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/admin/import", {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new ApiError(
          payload?.error?.message ?? "That file could not be imported.",
          payload?.error?.code ?? "internal",
          response.status,
        );
      }
      setPreview(payload.preview as ImportPreview);
    } catch (error) {
      setUploadError(
        error instanceof ApiError
          ? error.message
          : "That file could not be read.",
      );
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-4 py-8 text-center">
            <FileUp className="h-6 w-6 text-ink-subtle" aria-hidden="true" />
            <span className="font-semibold text-ink">
              Choose a CSV or XLSX file
            </span>
            <span className="text-sm text-ink-muted">
              Columns: Email, Date, Start time, End time, Service, Rotation,
              Shift type, Location, PGY
            </span>
            <input
              type="file"
              accept=".csv,.xlsx,.xls,text/csv"
              className="sr-only"
              onChange={onFile}
            />
            {fileName ? (
              <span className="text-sm text-ink-subtle">{fileName}</span>
            ) : null}
          </label>
          {uploading ? (
            <p className="mt-3 text-sm text-ink-muted" role="status">
              Validating the whole file…
            </p>
          ) : null}
        </CardBody>
      </Card>

      {uploadError ? <Alert tone="error">{uploadError}</Alert> : null}
      {result ? (
        <Alert tone="success" live>
          {result}
        </Alert>
      ) : null}
      {imported ? (
        <ScheduleCheck periodStart={imported.from} periodEnd={imported.to} />
      ) : null}
      <ActionAlert action={commit} />

      {preview ? (
        <ImportPreviewCard
          preview={preview}
          pending={commit.pending}
          onImport={() => commit.run()}
        />
      ) : null}
    </div>
  );
}

/**
 * The preview, split in two: what stops the import and what merely wants
 * reading. A word in the Status column the product does not recognise is worth
 * showing and worth nobody's evening — it is not a reason to refuse a file that
 * otherwise describes a real month.
 */
function ImportPreviewCard({
  preview,
  pending,
  onImport,
}: {
  preview: ImportPreview;
  pending: boolean;
  onImport: () => void;
}) {
  const blocking = preview.issues.filter((issue) => issue.column !== "Status");
  const notes = preview.issues.filter((issue) => issue.column === "Status");

  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <p className="font-semibold text-ink">Preview</p>
          <p className="mt-1 text-sm text-ink-muted">
            {preview.summary.totalRows} row(s) read
            {preview.summary.dateRange
              ? ` · ${preview.summary.dateRange.from} to ${preview.summary.dateRange.to}`
              : ""}
          </p>
        </div>

        {blocking.length > 0 ? (
          <Alert
            tone="error"
            title={`${blocking.length} error${blocking.length === 1 ? "" : "s"} found. No changes have been made.`}
          >
            <ul className="mt-1 max-h-56 list-disc overflow-auto pl-4">
              {blocking.slice(0, 50).map((issue, index) => (
                <li key={`${issue.row}-${issue.column}-${index}`}>
                  Row {issue.row} · {issue.column}: {issue.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : (
          <Alert tone="success">
            All {preview.rows.length} row(s) are valid and ready to import.
          </Alert>
        )}

        {notes.length > 0 ? (
          <Alert tone="warning" title="Worth a look, but nothing is blocked">
            <ul className="mt-1 max-h-40 list-disc overflow-auto pl-4">
              {notes.slice(0, 20).map((issue, index) => (
                <li key={`${issue.row}-${index}`}>
                  Row {issue.row}: {issue.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {preview.summary.unmatched.length > 0 ? (
          <Alert
            tone="info"
            title={`${preview.summary.heldRows} shift(s) are for ${preview.summary.unmatched.length} person/people who have not joined yet`}
          >
            <p className="mt-1">
              These are kept and appear on their schedule the first time they
              sign in. You do not need to invite them first.
            </p>
            <ul className="mt-1 max-h-40 list-disc overflow-auto pl-4">
              {preview.summary.unmatched.slice(0, 30).map((person) => (
                <li key={person.email || person.name}>
                  {person.name} · {person.rows} shift(s)
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {preview.summary.hoursFilledIn > 0 ? (
          <Alert tone="info">
            {preview.summary.hoursFilledIn} row(s) had no hours in the file, so
            the confirmed hours for their position were used. Check them below.
          </Alert>
        ) : null}

        {preview.summary.newServices.length > 0 ? (
          <Alert tone="info">
            New services that will be created:{" "}
            {preview.summary.newServices.join(", ")}
          </Alert>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <caption className="sr-only">First rows of the import file</caption>
            <thead>
              <tr className="border-b border-border-base text-ink-subtle">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Resident
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Date
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Time
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Service
                </th>
                <th scope="col" className="py-2 font-medium">
                  Location
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 10).map((row, index) => (
                <tr
                  key={index}
                  className="border-b border-border-base last:border-0"
                >
                  <td className="py-2 pr-3 text-ink">
                    {row.residentName || row.residentEmail}
                  </td>
                  <td className="py-2 pr-3 text-ink-muted">{row.date}</td>
                  <td className="py-2 pr-3 text-ink-muted">
                    {row.startTime}–{row.endTime}
                    {row.endsNextDay ? " (+1)" : ""}
                  </td>
                  <td className="py-2 pr-3 text-ink-muted">{row.service}</td>
                  <td className="py-2 text-ink-muted">{row.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rows.length > 10 ? (
            <p className="mt-2 text-sm text-ink-subtle">
              …and {preview.rows.length - 10} more row(s).
            </p>
          ) : null}
        </div>

        <Button
          block
          disabled={blocking.length > 0}
          loading={pending}
          loadingLabel="Importing…"
          onClick={onImport}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          Import {preview.rows.length} shift(s)
        </Button>
      </CardBody>
    </Card>
  );
}
