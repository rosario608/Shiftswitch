"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, FileUp, Sparkles } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { apiFetch } from "@/lib/api-client";
import { useAction } from "@/lib/use-action";

/**
 * Uploading a file nobody has cleaned up, and checking what came back.
 *
 * ## The screen is built around one refusal
 *
 * A row the extraction was unsure about cannot be imported until somebody has
 * opened it. So the flagged rows are at the top, they say *why* they are
 * flagged, they show where in the file they came from, and the import button
 * says how many are still waiting rather than being mysteriously disabled.
 *
 * The gate itself is on the server — `rowsForCommit` reads the confidences out
 * of the database — so nothing here is load-bearing for safety. What this
 * screen is responsible for is making the check worth doing: a reviewer who
 * cannot see the cell reference will click "looks right" forty times, and the
 * gate will have achieved nothing but a delay.
 *
 * ## What it says about the file
 *
 * That it leaves the server. In one sentence, before the file picker, because
 * a coordinator uploading their programme's schedule is entitled to know that
 * and should not have to find it in a policy document.
 */

interface ProposedRow {
  residentName: string;
  residentEmail: string;
  date: string;
  startTime: string;
  endTime: string;
  service: string;
  rotation: string;
  shiftType: string;
  location: string;
  status: string;
  uncertainty: string;
}

interface StoredRow {
  id: string;
  rowIndex: number;
  proposed: ProposedRow;
  corrected: ProposedRow | null;
  origin: { sheet?: string | null; cell?: string | null; page?: number | null; region?: string | null };
  confidence: number;
  needsReview: boolean;
  reviewedAt: string | null;
}

interface Extraction {
  id: string;
  filename: string;
  mediaKind: string;
  notes: string[];
  status: string;
  rows: StoredRow[];
}

function originLabel(origin: StoredRow["origin"]): string {
  if (origin.sheet && origin.cell) return `${origin.sheet} · ${origin.cell}`;
  if (origin.cell) return origin.cell;
  if (origin.page) return `Page ${origin.page}${origin.region ? ` · ${origin.region}` : ""}`;
  return origin.region ?? "—";
}

export function AssistedImport({
  configured,
  unavailableReason,
  maxBytes,
}: {
  configured: boolean;
  unavailableReason: string | null;
  maxBytes: number;
}) {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [hint, setHint] = React.useState("");
  const [extraction, setExtraction] = React.useState<Extraction | null>(null);

  const upload = useAction(
    async () => {
      const body = new FormData();
      body.append("file", file!);
      if (hint.trim()) body.append("hint", hint.trim());
      return apiFetch<{ extraction: Extraction }>("/api/admin/import/assisted", {
        method: "POST",
        body,
      });
    },
    { onSuccess: (result) => setExtraction(result.extraction) },
  );

  const commit = useAction(
    async () =>
      apiFetch<{ result: { createdShifts: number; heldRows: number } }>(
        `/api/admin/import/assisted/${extraction!.id}/commit`,
        { method: "POST" },
      ),
    {
      onSuccess: () => {
        setExtraction(null);
        setFile(null);
        router.refresh();
      },
    },
  );

  if (!configured) {
    return (
      <Card>
        <CardBody className="space-y-2">
          <p className="font-semibold text-ink">Reading a messy file is not set up here</p>
          <p className="text-sm text-ink-muted">{unavailableReason}</p>
        </CardBody>
      </Card>
    );
  }

  const unread = extraction?.rows.filter((row) => row.needsReview && !row.reviewedAt) ?? [];

  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <p className="flex items-center gap-2 font-semibold text-ink">
            <Sparkles className="h-4 w-4 text-brand-ink" aria-hidden="true" />
            Upload the file you already have
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            A spreadsheet with merged cells, a PDF calendar, a photo of the
            printed sheet — it does not have to be tidy. Nothing is added to the
            schedule until you have checked it.
          </p>
          {/* Said plainly, before the picker, because it is true and because
              somebody uploading their programme's schedule should not have to
              go looking for it. */}
          <p className="mt-2 text-sm text-ink-muted">
            The file is sent to Anthropic&rsquo;s API to be read, and is not
            stored — what is kept is the rows it produced and where in the file
            each one came from.
          </p>
        </div>

        {upload.error ? <Alert tone="error">{upload.error}</Alert> : null}
        {commit.error ? <Alert tone="error">{commit.error}</Alert> : null}

        {!extraction ? (
          <div className="space-y-3">
            <Field
              label="The file"
              htmlFor="assisted-file"
              hint={`Up to ${Math.round(maxBytes / 1024 / 1024)} MB. .xlsx, .csv, .pdf, .png or .jpg.`}
            >
              <input
                id="assisted-file"
                type="file"
                accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="block w-full text-sm text-ink file:mr-3 file:min-h-[2.5rem] file:rounded-xl file:border file:border-border-strong file:bg-surface file:px-3 file:text-sm file:font-semibold file:text-ink"
              />
            </Field>

            <Field
              label="Anything worth knowing about it? (optional)"
              htmlFor="assisted-hint"
              hint="For example: “the codes are in the legend at the bottom” or “this is August 2026”."
            >
              <Input
                id="assisted-hint"
                value={hint}
                onChange={(event) => setHint(event.target.value)}
                placeholder="D means a day shift, N means nights"
              />
            </Field>

            <Button
              block
              disabled={!file}
              loading={upload.pending}
              loadingLabel="Reading the file…"
              onClick={() => upload.run()}
            >
              <FileUp className="h-4 w-4" aria-hidden="true" />
              Read this file
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold text-ink">
                {extraction.rows.length} shift
                {extraction.rows.length === 1 ? "" : "s"} found in {extraction.filename}
              </p>
              {unread.length > 0 ? (
                <Badge tone="caution">{unread.length} to check</Badge>
              ) : (
                <Badge tone="brand">All checked</Badge>
              )}
            </div>

            {extraction.notes.length > 0 ? (
              <Alert tone="info">
                <p className="font-medium">What it had to work out</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {extraction.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <ul className="space-y-2">
              {extraction.rows.map((row) => (
                <RowCard
                  key={row.id}
                  extractionId={extraction.id}
                  row={row}
                  onReviewed={(updated) =>
                    setExtraction((current) =>
                      current
                        ? {
                            ...current,
                            rows: current.rows.map((candidate) =>
                              candidate.id === updated.id ? updated : candidate,
                            ),
                          }
                        : current,
                    )
                  }
                />
              ))}
            </ul>

            <Button
              block
              disabled={unread.length > 0}
              loading={commit.pending}
              loadingLabel="Importing…"
              onClick={() => commit.run()}
            >
              {unread.length > 0
                ? `Check ${unread.length} more row${unread.length === 1 ? "" : "s"} first`
                : `Import ${extraction.rows.length} shift${extraction.rows.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * One proposed row, with where it came from beside it.
 *
 * A flagged row opens as a form; a confident one is a line of text. That
 * asymmetry is the point of the confidence being there at all — the reviewer's
 * attention is finite, and spreading it evenly across four hundred rows is the
 * same as not reviewing any of them.
 */
function RowCard({
  extractionId,
  row,
  onReviewed,
}: {
  extractionId: string;
  row: StoredRow;
  onReviewed: (row: StoredRow) => void;
}) {
  const current = row.corrected ?? row.proposed;
  const [draft, setDraft] = React.useState(current);
  const flagged = row.needsReview && !row.reviewedAt;

  const save = useAction(
    async (correction: Partial<ProposedRow> | null) =>
      apiFetch<{ row: StoredRow }>(`/api/admin/import/assisted/${extractionId}`, {
        method: "PATCH",
        body: JSON.stringify({ rowId: row.id, correction }),
      }),
    { onSuccess: (result) => onReviewed(result.row) },
  );

  if (!flagged) {
    return (
      <li>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border-base px-3 py-2 text-sm">
          <span className="min-w-0">
            <span className="block font-medium text-ink">
              {current.residentName || current.residentEmail || "—"} ·{" "}
              {current.service || "—"}
            </span>
            <span className="block text-ink-muted">
              {current.date || "no date"} {current.startTime}
              {current.endTime ? `–${current.endTime}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-right text-xs text-ink-subtle">
            {originLabel(row.origin)}
            {row.reviewedAt ? (
              <span className="mt-0.5 flex items-center justify-end gap-1 text-brand-ink">
                <Check className="h-3 w-3" aria-hidden="true" />
                Checked
              </span>
            ) : null}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li>
      <div className="space-y-3 rounded-xl border border-caution/50 bg-caution-soft/20 p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution" aria-hidden="true" />
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-ink">Check this against the file</p>
            <p className="text-ink-muted">
              {row.proposed.uncertainty ||
                "Something a shift needs is missing from this row."}
            </p>
            <p className="mt-0.5 text-xs text-ink-subtle">
              From {originLabel(row.origin)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Who" htmlFor={`who-${row.id}`}>
            <Input
              id={`who-${row.id}`}
              value={draft.residentName}
              onChange={(event) => setDraft({ ...draft, residentName: event.target.value })}
            />
          </Field>
          <Field label="Service" htmlFor={`service-${row.id}`}>
            <Input
              id={`service-${row.id}`}
              value={draft.service}
              onChange={(event) => setDraft({ ...draft, service: event.target.value })}
            />
          </Field>
          <Field label="Date" htmlFor={`date-${row.id}`}>
            <Input
              id={`date-${row.id}`}
              type="date"
              value={draft.date}
              onChange={(event) => setDraft({ ...draft, date: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Starts" htmlFor={`start-${row.id}`}>
              <Input
                id={`start-${row.id}`}
                type="time"
                value={draft.startTime}
                onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
              />
            </Field>
            <Field label="Ends" htmlFor={`end-${row.id}`}>
              <Input
                id={`end-${row.id}`}
                type="time"
                value={draft.endTime}
                onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
              />
            </Field>
          </div>
        </div>

        {save.error ? <Alert tone="error">{save.error}</Alert> : null}

        <div className="flex gap-2">
          <Button
            variant="secondary"
            block
            loading={save.pending}
            onClick={() => save.run(null)}
          >
            It&rsquo;s right
          </Button>
          <Button block loading={save.pending} onClick={() => save.run(draft)}>
            Save this fix
          </Button>
        </div>
      </div>
    </li>
  );
}
