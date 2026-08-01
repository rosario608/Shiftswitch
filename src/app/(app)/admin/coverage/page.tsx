import { ScheduleWorkspace } from "@/components/app/schedule-workspace";
import { requirePageCapability } from "@/server/auth/page-guards";
import { loadWorkspace } from "@/server/domain/schedule-workspace";
import { toWorkspaceView } from "@/lib/workspace-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Coverage" };

/**
 * The live schedule, in the same grid a draft is built in.
 *
 * The same component and the same payload deliberately: a chief who has learnt
 * to read the grid while building next block should not have to learn a second
 * screen to ask whether *this* week is covered. The difference is that nothing
 * here is editable — the workspace refuses to bulk-edit a published schedule,
 * and changing one is a correction with a reason attached.
 */
export default async function CoveragePage() {
  const context = await requirePageCapability("scheduling.plan");
  const workspace = await loadWorkspace(context, { versionId: null });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Coverage</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          The published schedule from today onwards: what is short, what is
          over, who is working something they should not be. Everything here is
          the same check that runs before a schedule is published.
        </p>
      </header>

      <ScheduleWorkspace initial={toWorkspaceView(workspace)} />
    </div>
  );
}
