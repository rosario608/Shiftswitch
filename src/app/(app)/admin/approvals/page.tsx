import { Check, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ApprovalActions } from "@/components/app/admin-actions";
import { requirePageCapability } from "@/server/auth/page-guards";
import { buildTradeContextByShiftIds } from "@/server/domain/trade-context";
import { listPendingApprovals } from "@/server/domain/trades";
import { validateTrade } from "@/server/domain/validation";
import { toShiftView } from "@/lib/views";
import { fmtTimestamp } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const context = await requirePageCapability("approvals.decide");
  const approvals = await listPendingApprovals(context.program.id);
  const timezone = context.program.timezone;

  if (approvals.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-ink">Approvals</h1>
        <EmptyState
          title="Nothing waiting for approval"
          description="Switches that need a chief decision will appear here with their full validation results."
        />
      </div>
    );
  }

  // Re-validate each pending trade against the schedule as it stands right now,
  // so a chief never approves against a stale snapshot.
  const items = [];
  for (const request of approvals) {
    const offer = request.offers.find((entry) => entry.status === "accepted");
    if (!offer) continue;
    const tradeContext = await buildTradeContextByShiftIds(
      context.program,
      request.source_shift_id,
      offer.offered_shift_id,
    );
    items.push({
      request,
      offer,
      validation: validateTrade(tradeContext),
    });
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Approvals</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {items.length} switch{items.length === 1 ? "" : "es"} waiting for a decision.
        </p>
      </header>

      <ul className="space-y-4">
        {items.map(({ request, offer, validation }) => {
          const source = toShiftView(request.shift, timezone);
          const offered = toShiftView(offer.offered_shift, timezone);
          return (
            <li key={request.id}>
              <Card>
                <CardBody className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-ink">
                        {request.initiator_name} ↔ {offer.offering_resident_name}
                      </p>
                      <p className="text-sm text-ink-subtle">
                        Accepted {fmtTimestamp(offer.updated_at, timezone)}
                      </p>
                    </div>
                    <Badge tone={validation.valid ? "positive" : "critical"}>
                      {validation.valid ? "Passes rules" : "Fails rules"}
                    </Badge>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-border-base p-3">
                      <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                        Currently {request.initiator_name}
                      </p>
                      <p className="mt-1 font-semibold text-ink">
                        {source.dateLabel} · {source.serviceName}
                      </p>
                      <p className="text-sm text-ink-muted">{source.timeRange}</p>
                      <p className="mt-2 text-sm text-ink">
                        → becomes {offer.offering_resident_name} (PGY-
                        {offer.offering_resident_pgy})
                      </p>
                    </div>
                    <div className="rounded-xl border border-border-base p-3">
                      <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                        Currently {offer.offering_resident_name}
                      </p>
                      <p className="mt-1 font-semibold text-ink">
                        {offered.dateLabel} · {offered.serviceName}
                      </p>
                      <p className="text-sm text-ink-muted">{offered.timeRange}</p>
                      <p className="mt-2 text-sm text-ink">
                        → becomes {request.initiator_name}
                      </p>
                    </div>
                  </div>

                  {validation.approvalReasons.length > 0 ? (
                    <Alert tone="warning" title="Why approval is required">
                      <ul className="list-disc pl-4">
                        {validation.approvalReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </Alert>
                  ) : null}

                  <div>
                    <p className="mb-2 text-sm font-semibold text-ink">
                      Validation results
                    </p>
                    <ul className="space-y-1">
                      {validation.checks.map((check) => (
                        <li key={check.key} className="flex items-start gap-2 text-sm">
                          {check.status === "pass" ? (
                            <Check
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-positive"
                              aria-hidden="true"
                            />
                          ) : (
                            <X
                              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                                check.status === "fail" ? "text-critical" : "text-caution"
                              }`}
                              aria-hidden="true"
                            />
                          )}
                          <span className="text-ink-muted">
                            <span className="sr-only">
                              {check.status === "pass"
                                ? "Passed: "
                                : check.status === "fail"
                                  ? "Failed: "
                                  : "Warning: "}
                            </span>
                            {check.residentName ? (
                              <span className="font-medium text-ink">
                                {check.residentName}:{" "}
                              </span>
                            ) : null}
                            {check.message}
                            {check.detail ? (
                              <span className="block text-xs text-ink-subtle">
                                Required: {check.detail.required} · Available:{" "}
                                {check.detail.available}
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <ApprovalActions
                    tradeRequestId={request.id}
                    hasFailures={!validation.valid}
                  />
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
