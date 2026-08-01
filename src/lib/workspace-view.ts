import type { Workspace } from "@/server/domain/schedule-workspace";
import type { WorkspaceData } from "@/components/app/schedule-workspace";

/**
 * The server's workspace, as the client component's props.
 *
 * A function rather than passing the object straight through, for one reason:
 * `Date` does not survive the server/client boundary as a `Date`, and a
 * component that receives what it thinks is a Date and gets a string fails at
 * the first `.toISOString()`. Converting here, once, means the component's type
 * is honest about what it actually receives.
 */
export function toWorkspaceView(workspace: Workspace): WorkspaceData {
  return {
    ...workspace,
    history: workspace.history.map((entry) => ({
      ...entry,
      at: entry.at.toISOString(),
    })),
    locks: workspace.locks.map((lock) => ({
      id: lock.id,
      kind: lock.kind,
      target_label: lock.target_label,
      target_date: lock.target_date,
      reason: lock.reason,
    })),
  };
}
