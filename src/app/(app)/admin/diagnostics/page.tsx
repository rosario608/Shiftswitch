import { DiagnosticsPanel } from "@/components/app/diagnostics-panel";
import { requirePageCapability } from "@/server/auth/page-guards";
import { checkHealth } from "@/server/health/check";

export const dynamic = "force-dynamic";
export const metadata = { title: "Diagnostics" };

/**
 * The page somebody opens when a resident says "it's not working".
 *
 * Guarded by `maintenance.run` — administrator only — for the same reason the
 * maintenance tools are: it reports the shape of the deployment, and while
 * there is nothing here about a person, there is no reason for a chief resident
 * to be reading environment configuration.
 *
 * Rendered server-side with the checks already run, so the page arrives with an
 * answer rather than a spinner. That matters more than it looks: this is the
 * screen somebody opens *because* something is slow or broken, and a diagnostic
 * page that itself hangs waiting on a fetch is worse than no page at all.
 */
export default async function DiagnosticsPage() {
  await requirePageCapability("maintenance.run");
  const report = await checkHealth();

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Diagnostics</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          What ShiftSwitch can and cannot do right now, and why. If something is
          wrong, the report at the bottom is the thing to send on — it is written
          to be pasted somewhere, and it contains no resident&rsquo;s name,
          schedule or contact details.
        </p>
      </header>

      <DiagnosticsPanel initial={JSON.parse(JSON.stringify(report))} />
    </div>
  );
}
