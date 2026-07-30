import { Card, CardBody } from "@/components/ui/card";
import { ProgramForm } from "@/components/app/program-form";
import { requirePageRole } from "@/server/auth/page-guards";

export const dynamic = "force-dynamic";
export const metadata = { title: "Program settings" };

export default async function ProgramSettingsPage() {
  const context = await requirePageRole("admin");
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Program settings</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Authentication restrictions, timezone and the default approval policy.
        </p>
      </header>
      <Card>
        <CardBody>
          <ProgramForm
            program={{
              name: context.program.name,
              institution: context.program.institution,
              timezone: context.program.timezone,
              approvedEmailDomains: context.program.approved_email_domains,
              defaultTradeApprovalRequired:
                context.program.default_trade_approval_required,
            }}
          />
        </CardBody>
      </Card>
    </div>
  );
}
