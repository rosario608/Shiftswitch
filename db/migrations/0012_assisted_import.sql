-- Assisted import: what a model proposed, kept apart from what a person committed.
--
-- ## Why this is two tables and not a parsing step
--
-- Every other schedule source in this product is a pure function: bytes in,
-- rows out, nothing remembered. A model is not that. It is a source that can be
-- confidently wrong about a cell, and the whole safety argument for letting one
-- near a residency schedule rests on a person having looked at the rows it was
-- least sure about *before* anything was written.
--
-- That argument needs somewhere to stand. If the proposal lives only in the
-- browser, then "this row was flagged and reviewed" is a claim the client
-- makes about itself, and a commit that skipped the review looks exactly like
-- one that did not. So the proposal is written down first, by the server, with
-- the model's own confidence attached — and the commit reads the confidence
-- back from here rather than from the request.
--
-- Nothing in these tables is a schedule. `shifts` is still written by exactly
-- one path, `commitImport`, and these rows reach it as ordinary import records
-- that go through the same validation as a hand-typed CSV. A row in here is a
-- suggestion; it becomes a shift the way every other row does or not at all.
--
-- ## Why the original is kept beside the correction
--
-- `proposed` is never updated. A reviewer's fix goes in `corrected`, and both
-- survive the commit. This is the only record of where the model was wrong,
-- and it is the thing anybody asking "should we keep using this" needs. It is
-- also what makes a bad extraction diagnosable after the fact rather than
-- reconstructable from a screenshot.

CREATE TABLE assisted_import_extractions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id      uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,

  -- What was sent. The file itself is deleted after extraction; this is the
  -- description of it that survives, so a reader knows what produced the rows.
  filename        text NOT NULL,
  media_kind      text NOT NULL CHECK (media_kind IN ('spreadsheet', 'csv', 'pdf', 'image')),
  byte_size       integer NOT NULL,
  page_count      integer,

  -- What answered. Recorded because a later model will read the same file
  -- differently, and "which one said this" is the first question when an
  -- extraction turns out to have been wrong.
  model           text NOT NULL,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  cost_micros     bigint  NOT NULL DEFAULT 0,

  -- Facts about the file as a whole that no single row carries: a legend the
  -- extraction had to apply, a timezone the file states, a column it ignored.
  -- A reviewer checking row 40 against a spreadsheet needs to know that "N"
  -- was read as a night shift, and that fact belongs to the file, not to a row.
  notes           jsonb NOT NULL DEFAULT '[]'::jsonb,

  status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'unreadable', 'committed', 'discarded')),
  -- Present when status = 'unreadable': what could not be read, in words a
  -- coordinator can act on. Never a stack trace.
  unreadable_reason text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  committed_at    timestamptz
);

CREATE INDEX assisted_import_extractions_program
  ON assisted_import_extractions (program_id, created_at DESC);

CREATE TABLE assisted_import_rows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES assisted_import_extractions(id) ON DELETE CASCADE,

  -- Position in the proposal, so "row 4" on the screen and "row 4" in the
  -- audit entry are the same row.
  row_index     integer NOT NULL,

  -- The canonical import columns as the model proposed them. Never updated.
  proposed      jsonb NOT NULL,
  -- The reviewer's version, when they changed something. Null means they
  -- accepted the proposal as it stands.
  corrected     jsonb,

  -- Where in the file this came from: sheet and cell, page and region. Shown
  -- beside the extraction so a reviewer checks against the source rather than
  -- against their memory of it.
  origin        jsonb NOT NULL,

  -- The model's own confidence, 0 to 1. Stored server-side precisely so the
  -- commit gate cannot be argued with by a client.
  confidence    numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- Set at extraction time from the confidence and from whether required
  -- fields are missing. A true here cannot be committed until reviewed_at.
  needs_review  boolean NOT NULL,
  reviewed_at   timestamptz,
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,

  UNIQUE (extraction_id, row_index)
);

-- The reviewer's queue: what still needs looking at, worst first. Partial,
-- because once an extraction is worked through most of its rows never want
-- reading this way again.
CREATE INDEX assisted_import_rows_needing_review
  ON assisted_import_rows (extraction_id, confidence)
  WHERE needs_review AND reviewed_at IS NULL;

COMMENT ON TABLE assisted_import_extractions IS
  'One upload read by a model. A proposal, never a schedule: rows reach shifts through commitImport like any other import.';
COMMENT ON COLUMN assisted_import_rows.proposed IS
  'What the model said, never updated. Corrections go in corrected, so where it was wrong stays visible.';
