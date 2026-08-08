import { z } from "zod";
import { requireCapability } from "@/server/auth/guards";
import { apiHandler, corsPreflight, ok, parseJson } from "@/server/http/api";
import {
  applyStartingConfiguration,
  listUnconfirmedDefaults,
  STARTING_CONFIGURATIONS,
} from "@/server/domain/starting-configuration";

export const dynamic = "force-dynamic";

/**
 * The configuration a program starts with, and what nobody has vouched for yet.
 *
 * `services.manage`, because applying it creates the program's services — the
 * same authority as creating one by hand, and deliberately not the chief
 * resident's, who builds schedules out of services rather than deciding what a
 * service is.
 */
export const GET = apiHandler(async () => {
  const context = await requireCapability("services.manage");
  return ok({
    configurations: STARTING_CONFIGURATIONS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      positions: entry.positions.length,
      cycles: entry.cycles.length,
      assumed: [...entry.positions, ...entry.cycles].filter(
        (item) => item.provenance === "assumed",
      ).length,
    })),
    unconfirmed: await listUnconfirmedDefaults(context.program.id),
  });
});

const applySchema = z.object({
  id: z.string().min(1).max(80),
  /* The two supplied documents disagree about which year they describe, so the
     year is asked for rather than inferred. Recorded under Decisions in
     docs/AI_PROJECT_STATE.md. */
  academicYear: z.number().int().min(2000).max(2100),
});

export const POST = apiHandler(async (request: Request) => {
  const context = await requireCapability("services.manage");
  const input = await parseJson(request, applySchema);
  const result = await applyStartingConfiguration(context, input);
  return ok({ result }, { status: 201 });
});

/** CORS preflight for the native client. See `corsPreflight`. */
export const OPTIONS = corsPreflight;
