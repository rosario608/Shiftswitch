import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ScheduleWorkspace } from "@/components/app/schedule-workspace";
import { requirePageCapability } from "@/server/auth/page-guards";
import { getScheduleVersion } from "@/server/domain/schedule-versions";
import { loadWorkspace } from "@/server/domain/schedule-workspace";
import { toWorkspaceView } from "@/lib/workspace-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Build schedule" };

/**
 * The grid, for one draft.
 *
 * A separate route from the draft's summary page on purpose. That page answers
 * "should I publish this"; this one answers "how do I finish it", and the two
 * are different sittings. Putting the grid on the summary would bury the diff,
 * which is the thing somebody must read before the irreversible step.
 */
export default async function BuildPage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const context = await requirePageCapability("scheduling.plan");
  const { versionId } = await params;
  const version = await getScheduleVersion(context.program.id, versionId);
  if (!version) notFound();

  const workspace = await loadWorkspace(context, { versionId });

  return (
    <div className="space-y-5">
      <Link
        href={`/admin/scheduler/${versionId}`}
        className="inline-flex items-center gap-1 text-sm font-semibold text-brand"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {version.name}
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-ink">Build</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Services down the side, days across the top, tinted by whether each is
          covered. Tap shifts to select them, then move them together. Nothing
          here is visible to residents until this schedule is published.
        </p>
      </header>

      <ScheduleWorkspace initial={toWorkspaceView(workspace)} />
    </div>
  );
}
