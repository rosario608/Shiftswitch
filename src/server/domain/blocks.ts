import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";

/**
 * Block structures: the shape of a programme's year.
 *
 * A block structure is an ordered list of named date spans. That is the whole
 * model, and its generality is the requirement rather than an accident.
 *
 * Duke Internal Medicine runs **4+4**: four weeks inpatient paired with four
 * ambulatory. That is not encoded anywhere. It is thirteen rows produced by
 * `generateBlocks({ weeks: 4, ... })`, and a programme running two-week blocks
 * passes `weeks: 2` and gets twenty-six. A programme running the traditional
 * thirteen four-week blocks with no pairing passes the same generator and
 * ignores `kinds`. None of them is a code path; they are arguments.
 *
 * Blocks carry explicit **start and end dates** rather than a length and an
 * offset from July 1st. Academic years do not divide evenly into anything:
 * orientation eats the first week, the winter holiday block is short, and the
 * last block ends when graduation says it does. With dates, the irregular block
 * is ordinary data. With a formula it is a special case, and every programme
 * has at least one.
 */

export interface BlockStructure {
  id: string;
  program_id: string;
  name: string;
  academic_year: number;
  description: string;
  active: boolean;
  created_at: Date;
  block_count: number;
}

export interface Block {
  id: string;
  block_structure_id: string;
  sequence: number;
  label: string;
  start_date: Date;
  end_date: Date;
  kind: string;
  notes: string;
}

export interface BlockInput {
  sequence: number;
  label: string;
  startDate: string;
  endDate: string;
  kind?: string;
  notes?: string;
}

/**
 * Builds a year of blocks from a description of the pattern.
 *
 * Convenience, not truth: it produces a starting point that is then edited like
 * any other data. Nothing downstream knows or cares whether a block came from
 * here or was typed in.
 *
 * `kinds` is what makes 4+4 expressible without naming it. Given
 * `["Inpatient", "Ambulatory"]` the generator alternates, so block 1 is
 * inpatient, block 2 ambulatory, and so on. Given one kind it repeats it. Given
 * three it rotates through three. The "+" in "4+4" is this list having two
 * entries, and nothing in the code says two.
 */
export function generateBlocks(options: {
  startDate: string;
  weeks: number;
  count: number;
  kinds?: string[];
  labelPrefix?: string;
}): BlockInput[] {
  const { startDate, weeks, count } = options;
  if (weeks < 1 || weeks > 52) {
    throw validationFailed("A block is between 1 and 52 weeks long.");
  }
  if (count < 1 || count > 60) {
    throw validationFailed("A year has between 1 and 60 blocks.");
  }

  const kinds = options.kinds?.length ? options.kinds : [""];
  const prefix = options.labelPrefix ?? "Block";
  const blocks: BlockInput[] = [];

  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    throw validationFailed(`"${startDate}" is not a date.`);
  }

  for (let index = 0; index < count; index += 1) {
    const blockStart = new Date(start);
    blockStart.setUTCDate(blockStart.getUTCDate() + index * weeks * 7);
    const blockEnd = new Date(blockStart);
    // Inclusive end: a four-week block ending on day 28 would overlap the next
    // block's first day, and every off-by-one in a schedule is a resident
    // double-booked or a day with nobody on service.
    blockEnd.setUTCDate(blockEnd.getUTCDate() + weeks * 7 - 1);

    const kind = kinds[index % kinds.length];
    blocks.push({
      sequence: index + 1,
      label: kind ? `${prefix} ${index + 1} · ${kind}` : `${prefix} ${index + 1}`,
      startDate: blockStart.toISOString().slice(0, 10),
      endDate: blockEnd.toISOString().slice(0, 10),
      kind,
    });
  }
  return blocks;
}

export async function listBlockStructures(programId: string): Promise<BlockStructure[]> {
  return query<BlockStructure>(
    `SELECT b.*, (SELECT count(*) FROM blocks WHERE block_structure_id = b.id)::int
              AS block_count
       FROM block_structures b
      WHERE b.program_id = $1
      ORDER BY b.academic_year DESC, lower(b.name)`,
    [programId],
  );
}

export async function listBlocks(
  programId: string,
  structureId: string,
): Promise<Block[]> {
  return query<Block>(
    `SELECT bl.* FROM blocks bl
       JOIN block_structures bs ON bs.id = bl.block_structure_id
      WHERE bl.block_structure_id = $1 AND bs.program_id = $2
      ORDER BY bl.sequence`,
    [structureId, programId],
  );
}

/** The block containing a date, if any. */
export async function blockOn(
  structureId: string,
  isoDate: string,
): Promise<Block | null> {
  return queryOne<Block>(
    `SELECT * FROM blocks
      WHERE block_structure_id = $1 AND start_date <= $2 AND end_date >= $2
      ORDER BY sequence LIMIT 1`,
    [structureId, isoDate],
  );
}

export async function createBlockStructure(
  context: AuthedContext,
  input: {
    name: string;
    academicYear: number;
    description?: string;
    blocks: BlockInput[];
  },
): Promise<BlockStructure> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw validationFailed("Give the block structure a name.");
  assertBlocksCoherent(input.blocks);

  return withTransaction(async (client) => {
    /* Serialise concurrent creates of the same name. Without it a double-tapped
       button produces one success and one unique-index violation naming an
       index rather than a structure. */
    await query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`block_structure:${context.program.id}:${name.toLowerCase()}`],
      client,
    );

    const clash = await queryOne<{ name: string }>(
      "SELECT name FROM block_structures WHERE program_id = $1 AND lower(name) = lower($2)",
      [context.program.id, name],
      client,
    );
    if (clash) {
      throw conflict(`Your program already has a block structure called "${clash.name}".`);
    }

    const structure = (await queryOne<{ id: string }>(
      `INSERT INTO block_structures (program_id, name, academic_year, description)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [context.program.id, name, input.academicYear, input.description ?? ""],
      client,
    ))!;

    for (const block of input.blocks) {
      await query(
        `INSERT INTO blocks (block_structure_id, sequence, label, start_date, end_date, kind, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          structure.id,
          block.sequence,
          block.label,
          block.startDate,
          block.endDate,
          block.kind ?? "",
          block.notes ?? "",
        ],
        client,
      );
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "block_structure.created",
        entityType: "block_structure",
        entityId: structure.id,
        newState: { name, academicYear: input.academicYear, blocks: input.blocks.length },
      },
      client,
    );

    return (await queryOne<BlockStructure>(
      `SELECT b.*, (SELECT count(*) FROM blocks WHERE block_structure_id = b.id)::int
                AS block_count
         FROM block_structures b WHERE b.id = $1`,
      [structure.id],
      client,
    ))!;
  });
}

/**
 * Blocks must not overlap and must be sequenced without gaps in numbering.
 *
 * Overlapping blocks are the defect that matters: a resident is in exactly one
 * block at a time, and two blocks claiming the same week means two cohort
 * assignments claiming the same resident. Gaps in *dates* are allowed — a
 * programme with a week of orientation outside any block is normal — but gaps
 * in *sequence* are a mistake every time.
 */
export function assertBlocksCoherent(blocks: BlockInput[]): void {
  if (blocks.length === 0) {
    throw validationFailed("A block structure needs at least one block.");
  }

  const sorted = [...blocks].sort((a, b) => a.sequence - b.sequence);
  sorted.forEach((block, index) => {
    if (block.sequence !== index + 1) {
      throw validationFailed(
        `Blocks are numbered 1 to ${blocks.length}; found ${block.sequence} at position ${index + 1}.`,
      );
    }
    if (!block.label.trim()) {
      throw validationFailed(`Block ${block.sequence} needs a label.`);
    }
    if (block.endDate < block.startDate) {
      throw validationFailed(`${block.label} ends before it starts.`);
    }
  });

  const byDate = [...sorted].sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (let index = 1; index < byDate.length; index += 1) {
    const previous = byDate[index - 1];
    const current = byDate[index];
    if (current.startDate <= previous.endDate) {
      throw validationFailed(
        `${previous.label} (ends ${previous.endDate}) overlaps ${current.label} ` +
          `(starts ${current.startDate}). A resident can only be in one block at a time.`,
      );
    }
  }
}

export async function deleteBlockStructure(
  context: AuthedContext,
  id: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await queryOne<{ id: string; name: string }>(
      "SELECT id, name FROM block_structures WHERE id = $1 AND program_id = $2 FOR UPDATE",
      [id, context.program.id],
      client,
    );
    if (!existing) throw notFound("That block structure no longer exists.");

    /* Refused rather than cascaded when a published schedule points at it.
       `schedule_versions.block_structure_id` is ON DELETE SET NULL, so the
       delete would succeed and quietly orphan the version's notion of its own
       year. */
    const versions = await queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM schedule_versions WHERE block_structure_id = $1",
      [id],
      client,
    );
    if (Number(versions?.count ?? 0) > 0) {
      throw conflict(
        `"${existing.name}" is used by ${versions!.count} schedule(s). ` +
          "Deactivate it instead — deleting it would leave those schedules without a year.",
      );
    }

    await query("DELETE FROM block_structures WHERE id = $1", [id], client);
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "block_structure.deleted",
        entityType: "block_structure",
        entityId: id,
        previousState: { name: existing.name },
      },
      client,
    );
  });
}
