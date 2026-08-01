import { query, queryOne, withTransaction, type Queryable } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "../audit";
import type { ImportRow } from "../import";
import { assistedImportLimits } from "./limits";
import type { Extraction, MediaKind, ProposedRow, RowOrigin } from "./extract";

/**
 * The proposal, written down.
 *
 * ## Why the server keeps this rather than the browser
 *
 * The rule the whole feature rests on is *a row the model was unsure about
 * cannot be committed until a person has opened it*. A rule like that is only
 * worth having if it cannot be talked out of. If the confidences travelled to
 * the client and back, "reviewed" would be a claim the client makes about
 * itself, and a commit that skipped every flagged row would be indistinguishable
 * from one that read them all.
 *
 * So the confidence is written here at extraction time and read back from here
 * at commit time. The request says which rows the reviewer opened; it does not
 * say which rows needed opening.
 *
 * ## What is stored, and what is not
 *
 * The rows, their origins, their confidences, and what the reviewer changed.
 * **Not the file** — it is deleted once the extraction returns, which is what
 * the upload screen says will happen. The origin is what remains of it, and
 * that is the point of insisting the model produce one.
 */

export interface StoredRow {
  id: string;
  rowIndex: number;
  proposed: ProposedRow;
  corrected: ProposedRow | null;
  origin: RowOrigin;
  confidence: number;
  needsReview: boolean;
  reviewedAt: Date | null;
}

export interface StoredExtraction {
  id: string;
  filename: string;
  mediaKind: MediaKind;
  byteSize: number;
  pageCount: number | null;
  model: string;
  costMicros: number;
  status: "proposed" | "unreadable" | "committed" | "discarded";
  unreadableReason: string | null;
  notes: string[];
  createdAt: Date;
  rows: StoredRow[];
}

interface ExtractionRecord {
  id: string;
  filename: string;
  media_kind: MediaKind;
  byte_size: number;
  page_count: number | null;
  model: string;
  cost_micros: string;
  status: StoredExtraction["status"];
  unreadable_reason: string | null;
  notes: string[] | null;
  created_at: Date;
}

interface RowRecord {
  id: string;
  row_index: number;
  proposed: ProposedRow;
  corrected: ProposedRow | null;
  origin: RowOrigin;
  confidence: string;
  needs_review: boolean;
  reviewed_at: Date | null;
}

/**
 * Whether a row has to be looked at before it can become a schedule.
 *
 * Two reasons, and they are different in kind. The model saying it was unsure
 * is the obvious one. The other is a row missing something a shift cannot be
 * built without — a date, hours, a service, a person — which the model may
 * have reported with perfect confidence because it correctly read a cell that
 * did not contain the thing. High confidence in an incomplete row is still an
 * incomplete row.
 */
export function needsReview(row: ProposedRow, floor: number): boolean {
  if (row.confidence < floor) return true;
  if (!row.date) return true;
  if (!row.startTime || !row.endTime) return true;
  if (!row.service) return true;
  if (!row.residentName && !row.residentEmail) return true;
  return false;
}

/** Writes an extraction and its rows. Returns the id the reviewer works from. */
export async function saveExtraction(
  context: AuthedContext,
  file: { filename: string; byteSize: number },
  extraction: Extraction,
): Promise<string> {
  const { confidenceFloor } = assistedImportLimits();

  return withTransaction(async (client) => {
    const record = await queryOne<{ id: string }>(
      `INSERT INTO assisted_import_extractions
         (program_id, uploaded_by, filename, media_kind, byte_size, page_count,
          model, input_tokens, output_tokens, cost_micros, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'proposed')
       RETURNING id`,
      [
        context.program.id,
        context.user.id,
        file.filename,
        extraction.mediaKind,
        file.byteSize,
        extraction.pageCount,
        extraction.model,
        extraction.inputTokens,
        extraction.outputTokens,
        extraction.costMicros,
        JSON.stringify(extraction.notes),
      ],
      client,
    );

    for (const [index, row] of extraction.rows.entries()) {
      await query(
        `INSERT INTO assisted_import_rows
           (extraction_id, row_index, proposed, origin, confidence, needs_review)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
        [
          record!.id,
          index,
          JSON.stringify(row),
          JSON.stringify(row.origin),
          row.confidence,
          needsReview(row, confidenceFloor),
        ],
        client,
      );
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "schedule.extraction_proposed",
        entityType: "assisted_import",
        entityId: record!.id,
        newState: {
          filename: file.filename,
          mediaKind: extraction.mediaKind,
          rows: extraction.rows.length,
          flagged: extraction.rows.filter((row) => needsReview(row, confidenceFloor)).length,
          model: extraction.model,
          costMicros: extraction.costMicros,
        },
      },
      client,
    );

    return record!.id;
  });
}

/** Records that a file could not be read, so the attempt is not invisible. */
export async function saveUnreadable(
  context: AuthedContext,
  file: { filename: string; byteSize: number; mediaKind: MediaKind },
  reason: string,
): Promise<string> {
  const record = await queryOne<{ id: string }>(
    `INSERT INTO assisted_import_extractions
       (program_id, uploaded_by, filename, media_kind, byte_size, model, status, unreadable_reason)
     VALUES ($1, $2, $3, $4, $5, '', 'unreadable', $6)
     RETURNING id`,
    [
      context.program.id,
      context.user.id,
      file.filename,
      file.mediaKind,
      file.byteSize,
      reason,
    ],
  );
  return record!.id;
}

export async function loadExtraction(
  programId: string,
  extractionId: string,
  executor?: Queryable,
): Promise<StoredExtraction | null> {
  const record = await queryOne<ExtractionRecord>(
    `SELECT id, filename, media_kind, byte_size, page_count, model,
            cost_micros::text AS cost_micros, status, unreadable_reason,
            notes, created_at
       FROM assisted_import_extractions
      WHERE id = $1 AND program_id = $2`,
    [extractionId, programId],
    executor,
  );
  if (!record) return null;

  /* Flagged rows first, least confident of those first. The reviewer's time is
     worth most where the model was least sure, and a list in file order spends
     it on the rows that were never in doubt. */
  const rows = await query<RowRecord>(
    `SELECT id, row_index, proposed, corrected, origin,
            confidence::text AS confidence, needs_review, reviewed_at
       FROM assisted_import_rows
      WHERE extraction_id = $1
      ORDER BY (needs_review AND reviewed_at IS NULL) DESC, confidence ASC, row_index ASC`,
    [extractionId],
    executor,
  );

  return {
    id: record.id,
    filename: record.filename,
    mediaKind: record.media_kind,
    byteSize: record.byte_size,
    pageCount: record.page_count,
    model: record.model,
    costMicros: Number(record.cost_micros),
    status: record.status,
    unreadableReason: record.unreadable_reason,
    notes: record.notes ?? [],
    createdAt: record.created_at,
    rows: rows.map((row) => ({
      id: row.id,
      rowIndex: row.row_index,
      proposed: row.proposed,
      corrected: row.corrected,
      origin: row.origin,
      confidence: Number(row.confidence),
      needsReview: row.needs_review,
      reviewedAt: row.reviewed_at,
    })),
  };
}

/**
 * A reviewer changing a row, or accepting it as it stands.
 *
 * Both count as having looked at it, which is the whole of what the gate below
 * asks for. `corrected` stays null when they accepted the proposal unchanged,
 * so the record distinguishes "checked and right" from "checked and fixed" —
 * the first is evidence the model is working and the second is evidence it is
 * not, and collapsing them would lose the only measurement this feature has.
 */
export async function reviewRow(
  context: AuthedContext,
  extractionId: string,
  rowId: string,
  correction: Partial<ProposedRow> | null,
): Promise<StoredRow> {
  return withTransaction(async (client) => {
    const existing = await queryOne<RowRecord & { extraction_status: string }>(
      `SELECT r.id, r.row_index, r.proposed, r.corrected, r.origin,
              r.confidence::text AS confidence, r.needs_review, r.reviewed_at,
              e.status AS extraction_status
         FROM assisted_import_rows r
         JOIN assisted_import_extractions e ON e.id = r.extraction_id
        WHERE r.id = $1 AND r.extraction_id = $2 AND e.program_id = $3
        FOR UPDATE OF r`,
      [rowId, extractionId, context.program.id],
      client,
    );
    if (!existing) throw notFound("That row is not part of this upload.");
    if (existing.extraction_status === "committed") {
      throw conflict(
        "This upload has already been imported, so its rows cannot be changed. Upload the corrected file again — importing the same shift twice does nothing.",
      );
    }

    const merged = correction
      ? { ...(existing.corrected ?? existing.proposed), ...correction }
      : null;

    const updated = await queryOne<RowRecord>(
      `UPDATE assisted_import_rows
          SET corrected = $2::jsonb,
              reviewed_at = now(),
              reviewed_by = $3
        WHERE id = $1
      RETURNING id, row_index, proposed, corrected, origin,
                confidence::text AS confidence, needs_review, reviewed_at`,
      [rowId, merged ? JSON.stringify(merged) : null, context.user.id],
      client,
    );

    return {
      id: updated!.id,
      rowIndex: updated!.row_index,
      proposed: updated!.proposed,
      corrected: updated!.corrected,
      origin: updated!.origin,
      confidence: Number(updated!.confidence),
      needsReview: updated!.needs_review,
      reviewedAt: updated!.reviewed_at,
    };
  });
}

/** The row as it should be imported: the reviewer's version if there is one. */
export function effectiveRow(row: StoredRow): ProposedRow {
  return row.corrected ?? row.proposed;
}

/**
 * The rows to import, or a refusal naming what is still unread.
 *
 * This is the gate. It reads `needs_review` and `reviewed_at` out of the
 * database — never out of the request — so the only way past it is to have
 * actually opened the rows.
 */
export async function rowsForCommit(
  programId: string,
  extractionId: string,
): Promise<{ rows: ImportRow[]; extraction: StoredExtraction }> {
  const extraction = await loadExtraction(programId, extractionId);
  if (!extraction) throw notFound("That upload is not in this program.");
  if (extraction.status === "committed") {
    throw conflict("This upload has already been imported.");
  }
  if (extraction.status === "unreadable") {
    throw validationFailed(
      `That file could not be read, so there is nothing to import. ${extraction.unreadableReason ?? ""}`.trim(),
    );
  }
  if (extraction.rows.length === 0) {
    throw validationFailed(
      "No shifts were found in that file, so there is nothing to import.",
    );
  }

  const unread = extraction.rows.filter((row) => row.needsReview && !row.reviewedAt);
  if (unread.length > 0) {
    throw validationFailed(
      `${unread.length} ${unread.length === 1 ? "row still needs" : "rows still need"} checking against the file before this can be imported. ` +
        "They are at the top of the list, marked “Check this”. Open each one, fix it or confirm it is right, and import again.",
    );
  }

  return { rows: extraction.rows.map((row) => toImportRow(effectiveRow(row))), extraction };
}

/** Canonical import columns, from the proposal. Empty strings become absent. */
export function toImportRow(row: ProposedRow): ImportRow {
  return {
    residentEmail: row.residentEmail || undefined,
    residentName: row.residentName || undefined,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    /* Left unsaid unless the extraction said it, so the importer infers it from
       the hours the way it does for every other source. A night shift read out
       of a file as 19:00–07:00 must not arrive asserting that it ends the same
       day. */
    endsNextDay: row.endsNextDay,
    service: row.service,
    rotation: row.rotation || undefined,
    shiftType: row.shiftType || undefined,
    location: row.location || undefined,
    status: row.status || undefined,
  };
}

export async function markCommitted(
  extractionId: string,
  executor?: Queryable,
): Promise<void> {
  await query(
    `UPDATE assisted_import_extractions
        SET status = 'committed', committed_at = now()
      WHERE id = $1`,
    [extractionId],
    executor,
  );
}

export async function listRecentExtractions(
  programId: string,
  limit = 10,
): Promise<
  {
    id: string;
    filename: string;
    status: StoredExtraction["status"];
    rows: number;
    unread: number;
    createdAt: Date;
  }[]
> {
  return query(
    `SELECT e.id,
            e.filename,
            e.status,
            count(r.id)::int AS rows,
            count(r.id) FILTER (WHERE r.needs_review AND r.reviewed_at IS NULL)::int AS unread,
            e.created_at AS "createdAt"
       FROM assisted_import_extractions e
       LEFT JOIN assisted_import_rows r ON r.extraction_id = e.id
      WHERE e.program_id = $1
      GROUP BY e.id
      ORDER BY e.created_at DESC
      LIMIT $2`,
    [programId, limit],
  );
}
