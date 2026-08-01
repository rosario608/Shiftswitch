-- The scheduler as an operational workflow: structured availability, locks,
-- an approval step before publication, provenance for a published shift, and
-- corrections to a schedule people are already working.
--
-- `0008` gave the programme a shape and gave the scheduler a draft. This one is
-- about the rest of the loop — the parts that only matter once a real schedule
-- has been published and somebody's month depends on it.
--
-- Additive, like `0008`. Every column added here has a default that means
-- "as before", and every table added is empty for a program that never uses it.

-- ---------------------------------------------------------------------------
-- Structured availability
--
-- Until now unavailability was a list of ISO dates inside `residents.constraints`
-- and a list of requested days inside `residents.preferences`. That was enough
-- for the validator to be correct and nowhere near enough for a person to use:
-- there was no way to say *why*, no way to say "the 4th to the 18th" without
-- typing fifteen dates, and no way to tell a fortnight of annual leave apart
-- from a conference apart from an accommodation.
--
-- The jsonb keys still work and are still read. This table is the structured
-- way in, and the two are merged before the constraint model sees either, so
-- nothing had to be migrated and an import that writes the jsonb keeps working.
--
-- ## Hard or soft is a column, not a kind
--
-- `hard` is stored per row rather than derived from `kind`, because the same
-- kind is genuinely both depending on the programme. Approved annual leave is
-- hard — scheduling over it is a defect. A conference somebody hopes to attend
-- is soft until the programme approves it, at which point the same row becomes
-- hard. Deriving it from the kind would mean either refusing that transition or
-- inventing a second kind for every one that has it.
--
-- A hard row feeds the same constraint as `constraints.unavailableDates`; a soft
-- row feeds the same objective as `preferences.requestedDaysOff`. No new
-- constraint was added for absences, deliberately: a schedule that puts somebody
-- on a service during their leave is wrong in exactly the way it was already
-- wrong, and a reader should not have to learn two names for it.
-- ---------------------------------------------------------------------------

CREATE TYPE absence_kind AS ENUM (
  'vacation',
  'leave',
  'conference',
  'elective',
  'unavailable',
  'restriction'
);

CREATE TABLE resident_absences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  resident_id uuid NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  kind        absence_kind NOT NULL,
  -- Inclusive on both ends. A single day is start = end, which is the common
  -- case and must not require the reader to think about half-open intervals.
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  /* Hard means the schedule is wrong if it ignores this. Soft means it is
     disappointing. Nothing else in the product gets an opinion about which. */
  hard        boolean NOT NULL DEFAULT true,
  -- Shown to the scheduler, never to other residents: "Sister's wedding" is
  -- not something the trade board needs to know.
  notes       text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resident_absences_range CHECK (end_date >= start_date)
);

-- Every load is "this program's absences overlapping this window", which is
-- exactly this index.
CREATE INDEX resident_absences_program_idx
  ON resident_absences (program_id, start_date, end_date);
CREATE INDEX resident_absences_resident_idx
  ON resident_absences (resident_id, start_date);

CREATE TRIGGER resident_absences_updated_at BEFORE UPDATE ON resident_absences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Locks
--
-- The generator already accepted locks as an argument. They had nowhere to live
-- between two runs, which made "regenerate the remainder" impossible: a
-- scheduler who hand-placed six people and pressed generate again lost the six.
--
-- A lock is deliberately *not* a column on the shift. Locking a resident, a
-- cohort, a service or a date is locking something that is not a row in
-- `shifts` — and the moment regeneration deletes and recreates the draft's
-- shifts, a per-shift flag would be deleted with them. Rows keyed by what the
-- scheduler actually pointed at survive that, and a lock on an assignment names
-- the resident and the moment rather than the shift id for the same reason.
-- ---------------------------------------------------------------------------

CREATE TYPE schedule_lock_kind AS ENUM (
  'assignment',
  'resident',
  'cohort',
  'service',
  'date'
);

CREATE TABLE schedule_version_locks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES schedule_versions (id) ON DELETE CASCADE,
  kind        schedule_lock_kind NOT NULL,
  /* Which one. Interpreted by kind: a resident id, a cohort id, a service id,
     or null for a date lock. Not a foreign key, because the four targets live
     in four tables and a lock that survives its target being deleted is a lock
     that silently protects nothing — `listLocks` resolves names and drops what
     no longer resolves. */
  target_id   uuid,
  /* Date locks, and the date half of an assignment lock. */
  target_date date,
  -- Why, in the scheduler's own words. Shown next to the lock indicator.
  reason      text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_lock_target CHECK (
    (kind = 'date' AND target_date IS NOT NULL)
    OR (kind = 'assignment' AND target_id IS NOT NULL AND target_date IS NOT NULL)
    OR (kind IN ('resident', 'cohort', 'service') AND target_id IS NOT NULL)
  )
);

-- Locking the same thing twice is a no-op, not an error, and the index says so
-- rather than the application remembering to check.
CREATE UNIQUE INDEX schedule_version_locks_key
  ON schedule_version_locks (
    version_id, kind, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(target_date, 'epoch'::date)
  );

-- ---------------------------------------------------------------------------
-- Approval before publication
--
-- Publication was one button. For a schedule that governs a month of a
-- hospital's staffing, one button is one accident: the person building the
-- schedule and the person accountable for it are usually not the same person,
-- and even when they are, "I have reviewed this" and "this is now live" are two
-- decisions worth recording separately.
--
-- Approval is columns rather than a new enum value, because `status` answers
-- "is this the live schedule" and an approved draft is still a draft. Adding
-- 'approved' to the enum would make every existing `status = 'draft'` query
-- quietly wrong on the day somebody approved something.
-- ---------------------------------------------------------------------------

ALTER TABLE schedule_versions
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_notes text NOT NULL DEFAULT '',
  /* What the validator said at the moment of approval — the score, the counts,
     and the hard violations that were knowingly accepted. Stored rather than
     recomputed because the answer depends on data that keeps moving: rerunning
     the validator next month against today's roster does not tell you what the
     approver saw. */
  ADD COLUMN IF NOT EXISTS approval_report jsonb;

ALTER TABLE schedule_versions
  ADD CONSTRAINT schedule_versions_approved_fields CHECK (
    (approved_at IS NULL AND approved_by IS NULL)
    OR (approved_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Where a published shift came from
--
-- `schedule_version_id` is null for a live shift, and that is load-bearing:
-- null means published, which is why nothing needed backfilling in `0008`.
-- The cost was provenance — once published, a shift no longer knew which draft
-- produced it, so "what did we publish, and what has changed since" had no
-- answer.
--
-- A second column, set on publication and never cleared, restores it without
-- disturbing the first. `schedule_version_id` still answers "is this a draft";
-- `published_version_id` answers "which publication is this shift part of".
-- ---------------------------------------------------------------------------

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS published_version_id uuid
    REFERENCES schedule_versions (id) ON DELETE SET NULL;

CREATE INDEX shifts_published_version_idx ON shifts (published_version_id)
  WHERE published_version_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Corrections
--
-- A published schedule is wrong sometimes. Somebody resigns, a rotation moves,
-- a service closes for a week. The schedule has to change, and the change is
-- not a trade — nobody offered anything, and nobody agreed.
--
-- What makes a correction different from an ordinary edit is that residents
-- were already working the thing being changed. So it records what it replaced,
-- why, and who was affected, and the schedule can afterwards show the
-- difference between what was published and what is true now. `shift_assignments`
-- already carries the history; this table carries the *intent*, which history
-- cannot reconstruct.
-- ---------------------------------------------------------------------------

CREATE TABLE schedule_corrections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  -- The publication being corrected, when the shift carries one. Null for a
  -- shift that predates versioning or was created by hand.
  version_id  uuid REFERENCES schedule_versions (id) ON DELETE SET NULL,
  shift_id    uuid NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  -- Who held it before, and who holds it now. Either may be null: a shift can
  -- be corrected from nobody, or to nobody.
  previous_resident_id uuid REFERENCES residents (id) ON DELETE SET NULL,
  new_resident_id      uuid REFERENCES residents (id) ON DELETE SET NULL,
  -- Required by the domain, not merely by the column: a correction without a
  -- stated reason is indistinguishable from a mistake.
  reason      text NOT NULL,
  -- What the validator said about the schedule immediately after the
  -- correction, so a reader can see whether it fixed things or moved the
  -- problem somewhere else.
  impact      jsonb,
  corrected_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_corrections_reason CHECK (btrim(reason) <> '')
);

CREATE INDEX schedule_corrections_program_idx
  ON schedule_corrections (program_id, created_at DESC);
CREATE INDEX schedule_corrections_shift_idx ON schedule_corrections (shift_id);
CREATE INDEX schedule_corrections_version_idx ON schedule_corrections (version_id)
  WHERE version_id IS NOT NULL;
