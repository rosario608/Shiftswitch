/**
 * Where a schedule comes from.
 *
 * The application has exactly one *scheduling* model — `shifts`,
 * `shift_assignments`, `services`, `rotations` — and exactly one way of writing
 * to it: `validateImport` then `commitImport` in `../import.ts`. Those two
 * functions know nothing about files, vendors or APIs. They take a list of flat
 * records keyed by column name and are responsible for everything that matters:
 * matching residents, resolving services, timezone conversion, overnight
 * shifts, duplicate detection, and the all-or-nothing transaction.
 *
 * A *source* is the thin layer above that: the only thing it does is produce
 * those flat records. Today there is one, the uploaded spreadsheet. A future
 * MedHub integration would be a second implementation of this interface and
 * nothing else — no change to the schedule model, no change to validation, no
 * change to the commit path, no vendor-specific branch inside the domain.
 *
 * That is the whole point of the seam, so it is worth being explicit about what
 * it forbids:
 *
 *   - **No provider code below this layer.** If a rule only makes sense for one
 *     vendor, it belongs in that vendor's source module, not in `import.ts`.
 *   - **No provider credentials in the core.** A source that needs a token
 *     reads it from its own configuration and reports `configured: false` until
 *     it has one, exactly like the invitation transport.
 *   - **No source is trusted.** Records from an API get the same validation as
 *     records from a file a coordinator typed by hand. A remote source is not a
 *     more reliable source.
 *
 * MedHub is deliberately **not** implemented and is not a launch dependency.
 * Nothing here scrapes it, and nothing here asks anybody for MedHub
 * credentials.
 */

/**
 * One row as the source produced it: column name to raw cell text, before any
 * interpretation. Header aliasing, date parsing and time parsing all happen in
 * `import.ts`, so every source benefits from them and no source can quietly
 * disagree about what "07:00" means.
 */
export type ScheduleRecord = Record<string, string>;

export interface ScheduleSourceInfo {
  /** Stable identifier, used in API payloads and audit entries. */
  id: string;
  label: string;
  description: string;
  /**
   * Whether this source can be used right now. A source that needs
   * configuration it does not have reports `false` and explains why, rather
   * than failing at the moment somebody tries to use it.
   */
  configured: boolean;
  /** Present when `configured` is false: what is missing. */
  unavailableReason?: string;
}

export interface ScheduleSource<Input = unknown> extends ScheduleSourceInfo {
  /**
   * Produces the records to be validated. Throwing is fine and expected for
   * malformed input — the route turns it into a 422 with the message.
   */
  fetch(input: Input): Promise<ScheduleRecord[]>;
}

export interface UploadedFile {
  filename: string;
  contents: Buffer;
}
