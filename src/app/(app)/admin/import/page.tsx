import { Card, CardBody } from "@/components/ui/card";
import { ImportWizard } from "@/components/app/import-wizard";
import { requirePageRole } from "@/server/auth/page-guards";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import schedule" };

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
        <CardBody className="text-sm">
          <p className="font-semibold text-ink">Example CSV</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-muted p-3 text-xs">
{`Email,Date,Start time,End time,Ends next day,Service,Rotation,Shift type,Location
resident01@hospital.org,2026-09-01,07:00,19:00,no,MICU,Critical Care,day,ICU Tower 4
resident02@hospital.org,2026-09-01,19:00,07:00,yes,MICU,Critical Care,night,ICU Tower 4`}
          </pre>
          <p className="mt-2 text-ink-muted">
            An overnight shift is a single row with “Ends next day” set — it is stored
            as one shift, never two.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
