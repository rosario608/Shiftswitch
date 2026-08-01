import { can, ROLE_LABEL } from "@/server/auth/roles";
import Link from "next/link";
import { Download, LogOut, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, SectionHeading } from "@/components/ui/card";
import { AvailabilityManager } from "@/components/app/availability-manager";
import { InstallPrompt } from "@/components/app/install-prompt";
import { requirePageUser } from "@/server/auth/page-guards";
import { queryOne } from "@/server/db/pool";
import {
  ABSENCE_KINDS,
  ABSENCE_KIND_DEFAULT_HARD,
  ABSENCE_KIND_DESCRIPTION,
  ABSENCE_KIND_LABEL,
  listAbsences,
} from "@/server/domain/availability";
import { localDateString } from "@/server/domain/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Profile" };

export default async function ProfilePage() {
  const context = await requirePageUser();
  const stats = await queryOne<{ completed: string; posted: string }>(
    `SELECT
       (SELECT count(*) FROM completed_trades
         WHERE program_id = $1 AND ($2::uuid IS NOT NULL AND (resident_a = $2 OR resident_b = $2)))::text AS completed,
       (SELECT count(*) FROM trade_requests
         WHERE program_id = $1 AND initiating_resident_id = $2)::text AS posted`,
    [context.program.id, context.resident?.id ?? null],
  );

  /* From today. What somebody wants from this section is "have I told them
     about next month" — last year's leave is filing, not information. */
  const myAbsences = context.resident
    ? await listAbsences(context.program.id, {
        residentId: context.resident.id,
        from: localDateString(new Date(), context.program.timezone),
      })
    : [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Profile</h1>
      </header>

      <Card>
        <CardBody className="space-y-1">
          <p className="text-lg font-semibold text-ink">{context.user.fullName}</p>
          <p className="text-sm text-ink-muted">{context.user.email}</p>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Badge tone="brand">{ROLE_LABEL[context.user.role]}</Badge>
            {context.resident ? (
              <Badge tone="neutral">PGY-{context.resident.pgy_level}</Badge>
            ) : null}
            {context.resident?.credentials?.length ? (
              <Badge tone="neutral">
                {context.resident.credentials.join(" · ")}
              </Badge>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <section>
        <SectionHeading title="Program" />
        <Card>
          <CardBody className="space-y-1 text-sm">
            <p className="font-semibold text-ink">{context.program.name}</p>
            <p className="text-ink-muted">{context.program.institution}</p>
            <p className="text-ink-subtle">Timezone: {context.program.timezone}</p>
            <p className="text-ink-subtle">
              Trades{" "}
              {context.program.default_trade_approval_required
                ? "require chief approval"
                : "complete automatically when both residents agree"}
              .
            </p>
          </CardBody>
        </Card>
      </section>

      {context.resident ? (
        <section>
          <SectionHeading title="Your activity" />
          <Card>
            <CardBody className="grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {Number(stats?.completed ?? 0)}
                </p>
                <p className="text-sm text-ink-muted">Completed switches</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {Number(stats?.posted ?? 0)}
                </p>
                <p className="text-sm text-ink-muted">Shifts posted</p>
              </div>
            </CardBody>
          </Card>
        </section>
      ) : null}

      {context.resident ? (
        <section>
          <SectionHeading
            title="When you are away"
            description="Recorded here, it reaches whoever builds the schedule."
          />
          <AvailabilityManager
            manages={false}
            selfResidentId={context.resident.id}
            residents={[]}
            kinds={ABSENCE_KINDS.map((kind) => ({
              value: kind,
              label: ABSENCE_KIND_LABEL[kind],
              description: ABSENCE_KIND_DESCRIPTION[kind],
              defaultHard: ABSENCE_KIND_DEFAULT_HARD[kind],
            }))}
            absences={myAbsences.map((absence) => ({
              id: absence.id,
              residentId: absence.resident_id,
              residentName: absence.resident_name,
              kind: absence.kind,
              kindLabel: ABSENCE_KIND_LABEL[absence.kind],
              startDate: absence.start_date,
              endDate: absence.end_date,
              hard: absence.hard,
              notes: absence.notes,
              createdByName: absence.created_by_name,
            }))}
          />
        </section>
      ) : null}

      <InstallPrompt />

      <section className="space-y-2">
        <a
          href="/api/admin/export?format=pdf&scope=mine"
          className="flex min-h-[2.75rem] items-center justify-center gap-2 rounded-xl border border-border-strong px-4 font-semibold text-ink"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Download my schedule (PDF)
        </a>
        {can(context.user.role, "audit.view") ? (
          <Link
            href="/admin"
            className="flex min-h-[2.75rem] items-center justify-center gap-2 rounded-xl border border-border-strong px-4 font-semibold text-ink"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Program administration
          </Link>
        ) : null}
        <a
          href="/api/auth/signout"
          className="flex min-h-[2.75rem] items-center justify-center gap-2 rounded-xl border border-border-strong px-4 font-semibold text-critical"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </a>
      </section>
    </div>
  );
}
