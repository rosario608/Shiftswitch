-- The scheduling foundation: sites, service configuration, coverage
-- requirements, cohorts, blocks, resident scheduling data, and schedule
-- versions.
--
-- Everything here is additive. `shifts`, `shift_assignments`, `services`,
-- `rotations`, `residents` and the whole trade lifecycle keep working exactly
-- as they did; a program that never opens the scheduler screens sees no change
-- at all. Existing rows get defaults that mean "unconfigured", not "empty" —
-- the difference matters, because a service with no coverage requirement is not
-- a service requiring zero people.
--
-- The one idea running through all of it: **a program's shape is data.** Block
-- length, pairing, coverage patterns, PGY mix and the service list are rows,
-- not constants. A program running two-week blocks, or thirteen blocks a year,
-- or a service nobody has heard of, is expressible without a migration. That is
-- the requirement, and it is the reason several tables below look more general
-- than the Duke 4+4 case that motivated them.

-- ---------------------------------------------------------------------------
-- Sites
--
-- A service happens somewhere. Duke programs run at the university hospital,
-- the VA, and community sites, and "can this resident work at the VA" is a real
-- scheduling constraint with real credentialing behind it — not a note in a
-- location string. `shifts.location` stays as the free-text room/ward label it
-- has always been; this is the institution.
-- ---------------------------------------------------------------------------

CREATE TABLE sites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   uuid    NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  name         text    NOT NULL,
  abbreviation text    NOT NULL DEFAULT '',
  -- Null means "the program's timezone". A genuinely different timezone is
  -- rare but real for a distant affiliate, and assuming otherwise is the kind
  -- of thing that silently moves a shift by an hour.
  timezone     text,
  address      text    NOT NULL DEFAULT '',
  notes        text    NOT NULL DEFAULT '',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sites_program_name_key ON sites (program_id, lower(name));
CREATE INDEX sites_program_idx ON sites (program_id, active);

CREATE TRIGGER sites_updated_at BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Service configuration
--
-- `services` was name, abbreviation, tradeable, active — enough to label a
-- shift and no more. A scheduler needs to say what the service *requires*.
-- ---------------------------------------------------------------------------

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites (id) ON DELETE SET NULL,
  -- PGY eligibility for the service as a whole. `shifts.required_pgy_min/max`
  -- still governs an individual shift and still wins; this is the default a new
  -- shift inherits and what the coverage planner reasons about.
  ADD COLUMN IF NOT EXISTS pgy_min int NOT NULL DEFAULT 1
    CHECK (pgy_min BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS pgy_max int NOT NULL DEFAULT 10
    CHECK (pgy_max BETWEEN 1 AND 10),
  -- Hours, as a decimal: 11.5 is a real shift length. Null means "no typical
  -- length" — clinic sessions and electives genuinely do not have one, and
  -- defaulting them to 8 would be inventing a fact.
  ADD COLUMN IF NOT EXISTS typical_shift_hours numeric(4, 2)
    CHECK (typical_shift_hours IS NULL
           OR (typical_shift_hours > 0 AND typical_shift_hours <= 48)),
  -- Whether the service must be covered every day it is scheduled. A MICU with
  -- nobody on it is an emergency; an elective with nobody on it is a Tuesday.
  ADD COLUMN IF NOT EXISTS coverage_mandatory boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_email text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_phone text NOT NULL DEFAULT '',
  -- Where this service came from, so the UI can say "from the Duke Internal
  -- Medicine template" and mean it. Free text, not an enum: a future template
  -- is a new string, not a migration.
  ADD COLUMN IF NOT EXISTS source_template text NOT NULL DEFAULT '';

ALTER TABLE services
  ADD CONSTRAINT services_pgy_range CHECK (pgy_max >= pgy_min);

CREATE INDEX services_site_idx ON services (site_id) WHERE site_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Coverage requirements
--
-- "How many people does this service need, when?" — the question the whole
-- scheduler exists to answer, and the one the schema could not previously
-- express at all.
--
-- One table rather than five, with a `scope` discriminator, because these are
-- the same statement made about different spans of time and a scheduler reads
-- them as one list. The alternative — weekday_coverage, weekend_coverage,
-- date_coverage, period_coverage — makes "what does Christmas look like"
-- a four-way union and makes precedence a matter of which table you remembered.
--
-- Precedence is explicit and ordered most-specific-first:
--
--   date        a named day. New Year's Day.
--   period      a date range. The winter holiday block, an accreditation visit.
--   weekday     days of the week. The default shape of an ordinary week.
--
-- `days_of_week` uses PostgreSQL's `EXTRACT(DOW)` convention — 0 is Sunday — so
-- a weekend rule is `{0,6}` and needs no separate concept. "Weekend" is a
-- selection in the UI, not a row type, because programs disagree about whether
-- Friday night is the weekend and the schema should not take a side.
-- ---------------------------------------------------------------------------

CREATE TYPE coverage_scope AS ENUM ('weekday', 'period', 'date');

CREATE TABLE coverage_requirements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid    NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  service_id  uuid    NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  scope       coverage_scope NOT NULL DEFAULT 'weekday',
  -- What the scheduler calls this. "Weeknights", "Holiday coverage".
  label       text    NOT NULL DEFAULT '',

  -- scope = 'weekday'
  days_of_week smallint[] NOT NULL DEFAULT '{}',

  -- scope = 'date'
  specific_date date,

  -- scope = 'period'
  period_start date,
  period_end   date,

  -- The time band within the day. Null start and end mean the whole day, which
  -- is what a ward service usually wants; a night float sets 19:00–07:00 and
  -- the end being *before* the start is how an overnight band is expressed.
  start_time  time,
  end_time    time,

  min_staff   int     NOT NULL DEFAULT 1 CHECK (min_staff >= 0),
  -- Null means "no maximum". A cap of zero is meaningful (nobody may be on this
  -- service then) and is not the same as no cap.
  max_staff   int     CHECK (max_staff IS NULL OR max_staff >= 0),

  /* Required PGY mix, as `[{"pgy": 2, "min": 1, "max": 2}, ...]`.
     jsonb rather than columns because programs express this differently — "at
     least one senior", "exactly two interns", "no PGY-1 alone overnight" — and
     every one of those is a shape this array can carry without a migration.
     Validated in `src/server/domain/coverage.ts`, not by a CHECK, so the error
     can name the entry that is wrong. */
  pgy_mix     jsonb   NOT NULL DEFAULT '[]'::jsonb,

  notes       text    NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT coverage_staff_range
    CHECK (max_staff IS NULL OR max_staff >= min_staff),
  -- Each scope carries exactly the fields it means, so a row cannot claim to be
  -- about a date and also about Tuesdays.
  CONSTRAINT coverage_scope_fields CHECK (
    (scope = 'weekday' AND specific_date IS NULL AND period_start IS NULL
       AND period_end IS NULL AND array_length(days_of_week, 1) IS NOT NULL)
    OR (scope = 'date' AND specific_date IS NOT NULL AND period_start IS NULL
       AND period_end IS NULL)
    OR (scope = 'period' AND specific_date IS NULL AND period_start IS NOT NULL
       AND period_end IS NOT NULL AND period_end >= period_start)
  ),
  CONSTRAINT coverage_pgy_mix_is_array CHECK (jsonb_typeof(pgy_mix) = 'array')
);

CREATE INDEX coverage_service_idx ON coverage_requirements (service_id, active);
CREATE INDEX coverage_program_idx ON coverage_requirements (program_id, active);
CREATE INDEX coverage_date_idx ON coverage_requirements (specific_date)
  WHERE specific_date IS NOT NULL;

CREATE TRIGGER coverage_requirements_updated_at BEFORE UPDATE ON coverage_requirements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Rules that apply to a service. `rules` already supports `scope = 'service'`
-- with a `scope_id`, so this is a view onto existing data rather than a new
-- table: nothing to add.

-- ---------------------------------------------------------------------------
-- Block structures
--
-- A block structure is the program's year: an ordered list of named spans. It
-- is a *table*, not a constant, and that is the entire point.
--
-- Duke Internal Medicine runs 4+4 — four weeks of inpatient paired with four of
-- ambulatory. That is one instance of "a list of blocks with a length and a
-- kind". A program running two-week blocks has 26 rows instead of 13. A program
-- running a 13-block year has 13. None of them needs a migration, because none
-- of "4", "+", or "week" appears in the schema.
--
-- `blocks` carries explicit start and end dates rather than a length and an
-- offset. Academic years do not divide evenly into anything: orientation eats
-- the first week, the winter holiday block is short, and the last block ends
-- when graduation says it does. Storing dates means the irregular block is
-- ordinary data instead of an exception to a formula.
-- ---------------------------------------------------------------------------

CREATE TABLE block_structures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id        uuid    NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  name              text    NOT NULL,
  -- The academic year this describes, by its starting calendar year: 2026 for
  -- 2026–27. Programs say "the 26-27 year" and mean this.
  academic_year     int     NOT NULL CHECK (academic_year BETWEEN 1900 AND 2200),
  description       text    NOT NULL DEFAULT '',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX block_structures_program_name_key
  ON block_structures (program_id, lower(name));
CREATE INDEX block_structures_program_idx ON block_structures (program_id, active);

CREATE TRIGGER block_structures_updated_at BEFORE UPDATE ON block_structures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE blocks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_structure_id uuid NOT NULL REFERENCES block_structures (id) ON DELETE CASCADE,
  -- Position in the year, 1-based. Sorting by date would usually agree, but a
  -- program that numbers a split block 7a/7b needs the order stated.
  sequence           int  NOT NULL CHECK (sequence >= 1),
  label              text NOT NULL,
  start_date         date NOT NULL,
  end_date           date NOT NULL,
  /* What kind of block this is in the program's own vocabulary — "inpatient",
     "ambulatory", "elective", "vacation". Free text with no enum, because the
     pairing in 4+4 is *between kinds* and a program that pairs three kinds in
     rotation must be able to say so. */
  kind               text NOT NULL DEFAULT '',
  notes              text NOT NULL DEFAULT '',
  CONSTRAINT blocks_end_after_start CHECK (end_date >= start_date),
  CONSTRAINT blocks_sequence_key UNIQUE (block_structure_id, sequence)
);

CREATE INDEX blocks_structure_idx ON blocks (block_structure_id, start_date);

-- ---------------------------------------------------------------------------
-- Cohorts
--
-- A cohort is a group of residents within a PGY class who move through the year
-- together. In a 4+4 program the classes split into paired cohorts that
-- alternate: while cohort A is on wards, its partner B is in clinic.
--
-- Pairing is `paired_cohort_id`, a self-reference, rather than a "group"
-- concept. Two cohorts that alternate point at each other; a program that does
-- not pair leaves it null; a program pairing three ways chains them. The
-- application keeps the reciprocal link consistent — see `cohorts.ts`.
-- ---------------------------------------------------------------------------

CREATE TABLE cohorts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id       uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  label            text NOT NULL,
  pgy_level        int  NOT NULL CHECK (pgy_level BETWEEN 1 AND 10),
  -- The span this cohort exists for. Usually the academic year, but a cohort
  -- created mid-year for an off-cycle intake is a real thing.
  start_date       date,
  end_date         date,
  paired_cohort_id uuid REFERENCES cohorts (id) ON DELETE SET NULL,
  notes            text NOT NULL DEFAULT '',
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cohorts_dates CHECK (
    start_date IS NULL OR end_date IS NULL OR end_date >= start_date
  ),
  CONSTRAINT cohorts_not_paired_to_self CHECK (paired_cohort_id <> id)
);

CREATE UNIQUE INDEX cohorts_program_label_key ON cohorts (program_id, lower(label));
CREATE INDEX cohorts_program_pgy_idx ON cohorts (program_id, pgy_level, active);

CREATE TRIGGER cohorts_updated_at BEFORE UPDATE ON cohorts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* Membership is a table rather than `residents.cohort_id` because it carries
   dates. A resident who moves cohort in January — parental leave, a remediation
   plan, an off-cycle start — has two memberships, and the schedule for
   September must still be able to say which cohort they were in *then*. A
   single column would lose that the moment it was updated. */
CREATE TABLE cohort_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id   uuid NOT NULL REFERENCES cohorts (id) ON DELETE CASCADE,
  resident_id uuid NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  start_date  date,
  end_date    date,
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cohort_members_dates CHECK (
    start_date IS NULL OR end_date IS NULL OR end_date >= start_date
  )
);

-- A resident belongs to a cohort once. Moving between cohorts is two rows in
-- two *different* cohorts, which is why this is not keyed on the resident alone.
CREATE UNIQUE INDEX cohort_members_key ON cohort_members (cohort_id, resident_id);
CREATE INDEX cohort_members_resident_idx ON cohort_members (resident_id);

/* What a cohort does in a block. This is the schedule at the level a program
   director actually plans it: "PGY-2 cohort A is on Wards for block 3". The
   shift-level schedule is generated from or reconciled against this, and the
   two are deliberately separate — a block assignment is an intention, a shift
   is a fact. */
CREATE TABLE cohort_block_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id   uuid NOT NULL REFERENCES cohorts (id) ON DELETE CASCADE,
  block_id    uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  service_id  uuid REFERENCES services (id) ON DELETE SET NULL,
  rotation_id uuid REFERENCES rotations (id) ON DELETE SET NULL,
  -- For a block with no service — vacation, a research month — where a label is
  -- the whole content.
  label       text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cohort_block_key UNIQUE (cohort_id, block_id)
);

CREATE INDEX cohort_block_block_idx ON cohort_block_assignments (block_id);

/* One resident, one block, different from the rest of their cohort.
   Every program has these and they are usually tracked in somebody's head or a
   spreadsheet column called "NOTES". Making them a first-class row is the
   difference between a scheduler that survives contact with reality and one
   that is abandoned in October. */
CREATE TABLE resident_block_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resident_id uuid NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  block_id    uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  service_id  uuid REFERENCES services (id) ON DELETE SET NULL,
  rotation_id uuid REFERENCES rotations (id) ON DELETE SET NULL,
  label       text NOT NULL DEFAULT '',
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT resident_block_override_key UNIQUE (resident_id, block_id)
);

CREATE INDEX resident_block_overrides_block_idx ON resident_block_overrides (block_id);

-- ---------------------------------------------------------------------------
-- Resident scheduling data
--
-- What a scheduler needs to know about a person beyond their PGY.
-- ---------------------------------------------------------------------------

ALTER TABLE residents
  -- Stored E.164 where possible; validated and normalised in the application so
  -- the error can explain itself. Readable only with `residents.contact_info`,
  -- which is why it is a column on a table every screen already reads: the
  -- guard lives in the query, and `listResidents` will not select it without
  -- the capability.
  ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '',
  -- Separate from `active`. An inactive resident has left; a resident who is
  -- active but not schedulable is on leave, on research, or newly matched and
  -- not yet started. Conflating them means a scheduler either loses them from
  -- the roster or assigns them shifts they cannot work.
  ADD COLUMN IF NOT EXISTS schedulable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS scheduling_notes text NOT NULL DEFAULT '',
  /* Soft wishes: preferred services, days off requested, "prefers nights".
     Deliberately jsonb and deliberately *soft* — the rules engine decides what
     is legal, this records what somebody would like, and the scheduler sees
     both without the second being able to override the first. */
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  /* Hard constraints that are not rules: "no VA rotations" (no parking pass),
     "cannot work Fridays" (religious observance), an accommodation. Rules are
     program policy; these are facts about one person. */
  ADD COLUMN IF NOT EXISTS constraints jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE residents
  ADD CONSTRAINT residents_preferences_is_object
    CHECK (jsonb_typeof(preferences) = 'object'),
  ADD CONSTRAINT residents_constraints_is_object
    CHECK (jsonb_typeof(constraints) = 'object');

/* Which sites a resident may work. A join table rather than an array because
   credentialing is per-site and referential integrity matters: deleting a site
   should not leave a dangling id in an array nobody validates.

   Absence of rows means "no restriction recorded", not "eligible nowhere" —
   the common case is a program with one site and nothing to say. */
CREATE TABLE resident_site_eligibility (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resident_id uuid NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  eligible    boolean NOT NULL DEFAULT true,
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resident_site_key UNIQUE (resident_id, site_id)
);

CREATE INDEX resident_site_eligibility_site_idx ON resident_site_eligibility (site_id);

-- ---------------------------------------------------------------------------
-- Schedule versions
--
-- A draft is a schedule that is not yet true. The distinction the product
-- previously lacked: every shift was live the instant it was created, so there
-- was no way to build next block's schedule without residents seeing it
-- half-finished and trading against shifts that were about to move.
--
-- `shifts.schedule_version_id` is nullable, and **null means published**. Every
-- shift that exists today is live and stays live; nothing needs backfilling and
-- no existing query changes meaning. A draft's shifts carry a version id and
-- are filtered out of every resident-facing query by that one condition.
-- ---------------------------------------------------------------------------

CREATE TYPE schedule_version_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE schedule_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   uuid    NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  name         text    NOT NULL,
  status       schedule_version_status NOT NULL DEFAULT 'draft',
  -- The span this version is responsible for. Publishing replaces the live
  -- schedule *within this window only*, which is what makes it safe to publish
  -- one block without touching the rest of the year.
  period_start date    NOT NULL,
  period_end   date    NOT NULL,
  block_structure_id uuid REFERENCES block_structures (id) ON DELETE SET NULL,
  notes        text    NOT NULL DEFAULT '',
  created_by   uuid    REFERENCES users (id) ON DELETE SET NULL,
  published_by uuid    REFERENCES users (id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_versions_period CHECK (period_end >= period_start),
  -- A published version knows who published it and when; a draft knows neither.
  -- Stated as a constraint because "published with no publisher" is the state
  -- an audit would most want to ask about and least want to find.
  CONSTRAINT schedule_versions_published_fields CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  )
);

CREATE INDEX schedule_versions_program_idx
  ON schedule_versions (program_id, status, period_start);

CREATE TRIGGER schedule_versions_updated_at BEFORE UPDATE ON schedule_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS schedule_version_id uuid
    REFERENCES schedule_versions (id) ON DELETE CASCADE;

-- Partial: the overwhelming majority of shifts are published and carry null,
-- and indexing those would be indexing the whole table to find nothing.
CREATE INDEX shifts_version_idx ON shifts (schedule_version_id)
  WHERE schedule_version_id IS NOT NULL;

/* A draft shift may not be traded, and this is enforced where it cannot be
   forgotten. Every resident-facing query filters on `schedule_version_id IS
   NULL`, but a filter is something a future query can omit; a partial unique
   index cannot be. A trade request may only reference a shift with no version. */
CREATE OR REPLACE FUNCTION assert_shift_is_published() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM shifts
     WHERE id = NEW.source_shift_id AND schedule_version_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A shift in an unpublished draft schedule cannot be posted for trade.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trade_requests_published_only
  BEFORE INSERT ON trade_requests
  FOR EACH ROW EXECUTE FUNCTION assert_shift_is_published();
