import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requirePageCapability } from "@/server/auth/page-guards";
import { listAuditLogs } from "@/server/domain/audit";
import { fmtTimestamp, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; page?: string }>;
}) {
  const context = await requirePageCapability("audit.view");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? 1));
  const limit = 50;
  const logs = await listAuditLogs({
    programId: context.program.id,
    action: params.action,
    limit,
    offset: (page - 1) * limit,
  });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Audit log</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Every schedule and administrative change, in order.
        </p>
      </header>

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="action"
          defaultValue={params.action ?? ""}
          placeholder="Filter by action, e.g. switch.completed"
          aria-label="Filter by action"
          className="min-h-[2.75rem] w-full rounded-xl border border-border-strong bg-surface px-3 text-base"
        />
        <button
          type="submit"
          className="min-h-[2.75rem] rounded-xl bg-brand px-4 font-semibold text-white"
        >
          Filter
        </button>
      </form>

      {logs.length === 0 ? (
        <EmptyState
          title="No audit entries"
          description="Entries appear as soon as shifts, switches or settings change."
        />
      ) : (
        <ul className="space-y-2">
          {logs.map((log) => (
            <li key={String(log.id)}>
              <Card>
                <CardBody>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{titleCase(log.action)}</p>
                      <p className="text-sm text-ink-muted">
                        {log.actor_name ?? log.actor_label} · {log.entity_type}
                        {log.entity_id ? ` · ${log.entity_id.slice(0, 8)}` : ""}
                      </p>
                      {log.reason ? (
                        <p className="mt-1 text-sm text-ink-subtle italic">
                          {log.reason}
                        </p>
                      ) : null}
                    </div>
                    <p className="shrink-0 text-xs text-ink-subtle">
                      {fmtTimestamp(log.created_at, context.program.timezone)}
                    </p>
                  </div>
                  {log.previous_state || log.new_state ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm text-brand-ink">
                        Details
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-muted p-2 text-xs">
                        {JSON.stringify(
                          { previous: log.previous_state, next: log.new_state },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-between">
        {page > 1 ? (
          <a
            href={`/admin/audit?page=${page - 1}${params.action ? `&action=${params.action}` : ""}`}
            className="text-sm font-semibold text-brand-ink"
          >
            ← Newer
          </a>
        ) : (
          <span />
        )}
        {logs.length === limit ? (
          <a
            href={`/admin/audit?page=${page + 1}${params.action ? `&action=${params.action}` : ""}`}
            className="text-sm font-semibold text-brand-ink"
          >
            Older →
          </a>
        ) : null}
      </div>
    </div>
  );
}
