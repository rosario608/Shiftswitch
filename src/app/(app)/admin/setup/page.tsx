import { StartingConfigurationPanel } from "@/components/app/starting-configuration-panel";
import { requirePageCapability } from "@/server/auth/page-guards";
import {
  STARTING_CONFIGURATIONS,
  listUnconfirmedDefaults,
} from "@/server/domain/starting-configuration";

export const dynamic = "force-dynamic";
export const metadata = { title: "First-time setup" };

/**
 * Where a program gets its shape, and where the product admits what it guessed.
 *
 * The two halves are on one screen on purpose. Applying a starting
 * configuration and then never seeing which of its numbers were invented is the
 * failure this whole mechanism exists to prevent: the wrongest schedule is the
 * confident one, and a guessed hour that generated three hundred shifts looks
 * exactly as authoritative as three hundred from the program's own file.
 */
export default async function SetupPage() {
  const context = await requirePageCapability("services.manage");
  const unconfirmed = await listUnconfirmedDefaults(context.program.id);

  /* The academic year the program is most likely to mean, offered rather than
     assumed. The two documents this was built from disagree about which year
     they describe, so nothing here picks one — see Decisions in
     docs/AI_PROJECT_STATE.md. */
  const now = new Date();
  const defaultYear = now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">First-time setup</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          {unconfirmed.length > 0
            ? `${unconfirmed.length} default${unconfirmed.length === 1 ? " is" : "s are"} still our guess, so nothing is filled in from ${unconfirmed.length === 1 ? "it" : "them"}. Checking one takes a tap.`
            : "Everything this program schedules from has come from a document or been checked by somebody."}
        </p>
      </header>

      <StartingConfigurationPanel
        configurations={STARTING_CONFIGURATIONS.map((entry) => ({
          id: entry.id,
          label: entry.label,
          description: entry.description,
          positions: entry.positions.length,
          cycles: entry.cycles.length,
          assumed: [...entry.positions, ...entry.cycles].filter(
            (item) => item.provenance === "assumed",
          ).length,
        }))}
        unconfirmed={unconfirmed.map((row) => ({
          kind: row.kind,
          id: row.id,
          serviceName: row.service_name,
          name: row.name,
          summary: row.summary,
          notes: row.notes,
        }))}
        defaultYear={defaultYear}
      />
    </div>
  );
}
