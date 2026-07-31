import { Download } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { ImportWizard } from "@/components/app/import-wizard";
import { requirePageRole } from "@/server/auth/page-guards";

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
    name: "Email",
    required: true,
    notes: "The resident's address, exactly as it appears under Users.",
  },
  {
    name: "Date",
    required: true,
    notes: "YYYY-MM-DD or MM/DD/YYYY. The day the shift starts.",
  },
  {
    name: "Start time",
    required: true,
    notes: "24-hour (07:00) or 12-hour (7:00 am). Also accepts “Start”.",
  },
  {
    name: "End time",
    required: true,
    notes: "Same formats. Also accepts “End”.",
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
    name: "PGY",
    required: false,
    notes: "Ignored if the resident already has a training level.",
  },
];

export default async function ImportPage() {
  const context = await requirePageRole("chief");
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Import schedule</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Times are interpreted in {context.program.timezone}. Nothing is written
          until the whole file validates.
        </p>
      </header>

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
{`Email,Date,Start time,End time,Ends next day,Service,Rotation,Shift type,Location
resident01@hospital.org,2026-09-01,07:00,19:00,no,MICU,Critical Care,day,ICU Tower 4
resident02@hospital.org,2026-09-01,19:00,07:00,yes,MICU,Critical Care,night,ICU Tower 4`}
            </pre>
          </div>

          <ul className="list-disc space-y-1 pl-5 text-ink-muted">
            <li>
              An overnight shift is a <strong>single row</strong> with “Ends next
              day” set — it is stored as one shift, never two.
            </li>
            <li>
              Residents are matched by email address, so invite them first. A row
              for somebody who is not in the program yet stops the whole import.
            </li>
            <li>
              Services and rotations are created automatically if they do not
              exist yet.
            </li>
            <li>
              Importing the same file twice does not duplicate anything —
              identical shifts are recognised and skipped.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
