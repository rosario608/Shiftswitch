import { Download } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { AssistedImport } from "@/components/app/assisted-import";
import { ImportWizard } from "@/components/app/import-wizard";
import { requirePageCapability } from "@/server/auth/page-guards";
import { assistedImportLimits } from "@/server/domain/assisted-import/limits";
import { modelTransport } from "@/server/domain/assisted-import/transport";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import schedule" };

/**
 * Documented here rather than only in the code, because the person who has to
 * get a spreadsheet into this shape is not going to read `import.ts`. Aliases
 * accepted by the parser are listed so an export from another system usually
 * works untouched.
 */
const COLUMNS: Array<{ name: string; required: boolean; notes: string }> = [
  {
    name: "Resident",
    required: true,
    notes:
      "Their name, their email address, or both. A name is enough — “Osei, Nadia” and “Nadia Osei” are read as the same person.",
  },
  {
    name: "PGY",
    required: false,
    notes: "Ignored if the resident already has a training level.",
  },
  {
    name: "Date",
    required: true,
    notes: "YYYY-MM-DD or MM/DD/YYYY. The day the shift starts.",
  },
  {
    name: "Start",
    required: true,
    notes:
      "24-hour (07:00) or 12-hour (7:00 am). Also accepts “Start time”. Can be left blank only when the position has confirmed hours.",
  },
  {
    name: "End",
    required: true,
    notes: "Same formats. Also accepts “End time”.",
  },
  {
    name: "Ends next day",
    required: false,
    notes: "yes/no. Set it for an overnight shift. Also accepts “Overnight”.",
  },
  {
    name: "Service",
    required: true,
    notes: "Created if it does not exist yet, e.g. MICU.",
  },
  { name: "Rotation", required: false, notes: "Created if it does not exist." },
  {
    name: "Shift type",
    required: false,
    notes: "day, night, call… Defaults to day. Also accepts “Type”.",
  },
  { name: "Location", required: false, notes: "Free text, e.g. ICU Tower 4." },
  {
    name: "Status",
    required: false,
    notes:
      "confirmed, draft or cancelled. A cancelled row creates nothing. A word this does not recognise is reported and the row imports normally.",
  },
];

export default async function ImportPage() {
  const context = await requirePageCapability("schedule.manage");
  const transport = modelTransport();
  const limits = assistedImportLimits();

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Import schedule</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Times are interpreted in {context.program.timezone}. Nothing is written
          until the whole file validates. People it names who have not joined
          yet are kept, not dropped.
        </p>
      </header>

      {/* First, because it is the one that takes the file a programme
          actually has. The template below is the path that needs nothing
          configured and is unchanged. */}
      <AssistedImport
        configured={transport.configured}
        unavailableReason={transport.unavailableReason ?? null}
        maxBytes={limits.maxBytes}
      />

      <ImportWizard />

      <Card>
        <CardBody className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-ink">The file</p>
              <p className="text-ink-muted">
                CSV or Excel. Start from the template if you are not sure.
              </p>
            </div>
            <a
              href="/api/admin/import/template"
              className="flex min-h-[2.5rem] items-center gap-1.5 rounded-xl border border-border-strong px-3 text-sm font-semibold text-ink"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download template
            </a>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-ink-subtle">
                <tr>
                  <th className="py-1 pr-3 font-semibold">Column</th>
                  <th className="py-1 pr-3 font-semibold">Required</th>
                  <th className="py-1 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody className="align-top text-ink-muted">
                {COLUMNS.map((column) => (
                  <tr key={column.name} className="border-t border-border-base">
                    <td className="py-1.5 pr-3 font-medium text-ink">{column.name}</td>
                    <td className="py-1.5 pr-3">{column.required ? "Yes" : "Optional"}</td>
                    <td className="py-1.5">{column.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <p className="font-semibold text-ink">Example</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-muted p-3 text-xs">
{`Resident,PGY,Date,Start,End,Service,Rotation,Shift type,Location,Status
Nadia Osei,2,2026-09-01,07:00,19:00,MICU,Critical Care,day,ICU Tower 4,confirmed
Tom Reyes,3,2026-09-01,19:00,07:00,MICU,Critical Care,night,ICU Tower 4,confirmed`}
            </pre>
          </div>

          <ul className="list-disc space-y-1 pl-5 text-ink-muted">
            <li>
              An overnight shift is a <strong>single row</strong> with “Ends next
              day” set — it is stored as one shift, never two.
            </li>
            <li>
              You do not have to invite anybody first. Rows for people who have
              not joined are <strong>kept</strong>, listed here as waiting, and
              appear on their schedule the first time they sign in.
            </li>
            <li>
              Services and rotations are created automatically if they do not
              exist yet.
            </li>
            <li>
              Importing the same file twice does not duplicate anything —
              identical shifts are recognised and skipped.
            </li>
            <li>
              An overnight row still needs its end time; “Ends next day” is
              inferred when the end is at or before the start.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
