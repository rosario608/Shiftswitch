import { notFound } from "@/server/http/errors";
import { generatedSource } from "./generated";
import { spreadsheetSource } from "./spreadsheet";
import type { ScheduleSource, ScheduleSourceInfo } from "./types";

export * from "./types";
export { spreadsheetSource, generatedSource };

/**
 * The registry of schedule sources.
 *
 * Adding MedHub later means writing `medhub.ts` implementing `ScheduleSource`,
 * adding it to this array, and stopping. It would report `configured: false`
 * until whatever it needs is provided, in the same way the invitation transport
 * reports honestly rather than failing at the point of use.
 *
 * It is deliberately not here now: MedHub is not a launch dependency, nothing
 * scrapes it, and no MedHub credential is collected or stored anywhere in this
 * repository.
 */
const SOURCES: ScheduleSource<never>[] = [
  spreadsheetSource as ScheduleSource<never>,
  generatedSource as unknown as ScheduleSource<never>,
];

export function listScheduleSources(): ScheduleSourceInfo[] {
  return SOURCES.map(({ id, label, description, configured, unavailableReason }) => ({
    id,
    label,
    description,
    configured,
    ...(unavailableReason ? { unavailableReason } : {}),
  }));
}

export function getScheduleSource<Input>(id: string): ScheduleSource<Input> {
  const source = SOURCES.find((candidate) => candidate.id === id);
  if (!source) throw notFound(`There is no schedule source called "${id}".`);
  return source as unknown as ScheduleSource<Input>;
}
