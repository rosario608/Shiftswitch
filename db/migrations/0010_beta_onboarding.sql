-- Beta onboarding: positions, rotation cycles, teams, enrollment, provenance.
--
-- Everything here comes from reading two real programmes' published schedules,
-- and every table exists because those schedules broke an assumption the
-- product had already made.
--
-- The assumption that broke hardest: that a service's name implies its hours.
-- One emergency-department code appears in a single week as 10a–6p, 3p–11p,
-- 7p–7a *and* 7a–7p. A MICU week runs 0700–2100 alternating with 0700–1400,
-- and the following week is 2000–1000. So a *position* is a label with a
-- suggested default attached, and the default is a hint the importer and the
-- entry form pre-fill — never something a shift inherits. `shifts` already
-- stores its own start and end instants and always has; nothing here changes
-- that, and nothing here may.
--
-- The second: that the week is the unit of coverage. It is not. Days off
-- rotate — MICU off Saturday, VA general medicine off Wednesday one week and
-- Saturday the next, nights off Monday and Saturday then Thursday, CICU and
-- consults every day of the week, VA MICU annotated q3 twenty-four-hour call.
-- A weekday/weekend split is one pattern among many rather than the model, so a
-- rotation pattern is a *cycle*: a length, an ordered list of states, and a
-- per-person offset into it.

-- ---------------------------------------------------------------------------
-- Positions: a label with a suggested default
-- ---------------------------------------------------------------------------

CREATE TABLE positions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id     uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  service_id     uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  name           text NOT NULL,
  short_name     text NOT NULL DEFAULT '',
  -- The suggested default, as a wall-clock time in the programme's timezone,
  -- plus how long it runs. Both nullable: a position whose hours genuinely vary
  -- every day should not be forced to invent one, and a null here means the
  -- importer and the form ask rather than guess.
  default_start  time,
  default_minutes int CHECK (default_minutes IS NULL OR default_minutes BETWEEN 30 AND 1800),
  default_shift_type text NOT NULL DEFAULT 'day',
  required_pgy_min int NOT NULL DEFAULT 1 CHECK (required_pgy_min BETWEEN 1 AND 10),
  required_pgy_max int NOT NULL DEFAULT 10 CHECK (required_pgy_max BETWEEN 1 AND 10),
  -- STATED when a programme's own document says it; ASSUMED when it was
  -- inferred. An assumed default may not generate anything until somebody with
  -- the authority confirms it — see `provenance` below.
  provenance     text NOT NULL DEFAULT 'assumed'
                 CHECK (provenance IN ('stated', 'assumed', 'confirmed')),
  confirmed_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at   timestamptz,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT positions_pgy_range CHECK (required_pgy_max >= required_pgy_min),
  CONSTRAINT positions_confirmed_has_who
    CHECK ((provenance = 'confirmed') = (confirmed_by IS NOT NULL))
);

CREATE UNIQUE INDEX positions_unique_name
  ON positions (service_id, lower(name)) WHERE active;
CREATE INDEX positions_program ON positions (program_id);

-- ---------------------------------------------------------------------------
-- Teams: positions grouped within a service
-- ---------------------------------------------------------------------------
--
-- MICU teams A and B; CICU day and night split by level; a general-medicine
-- team of one resident and two interns. A team is a grouping of positions, not
-- of people: who is on it comes from the schedule.

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  service_id  uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  int  NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX teams_unique_name
  ON teams (service_id, lower(name)) WHERE active;

ALTER TABLE positions
  ADD COLUMN team_id uuid REFERENCES teams (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Rotation patterns: a cycle, not a week
-- ---------------------------------------------------------------------------

CREATE TYPE rotation_state AS ENUM (
  -- The states the two programmes' documents actually use. `pre` is the day
  -- before call, `post` the day after — both are worked days with different
  -- hours, which is exactly why they cannot be collapsed into "on".
  'on',
  'pre',
  'post',
  'off',
  'late',
  'night',
  'clinic'
);

CREATE TABLE rotation_patterns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  service_id   uuid REFERENCES services (id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- 3 for q3 call, 4 for a late/pre/night/off cycle, 7 for a service that
  -- genuinely does run on weekdays. Seven is a *case*, not the model.
  cycle_days   int  NOT NULL CHECK (cycle_days BETWEEN 1 AND 366),
  -- Exactly `cycle_days` entries, in order, checked in the domain because a
  -- SQL check cannot compare an array's length to another column portably
  -- across the versions this runs on.
  states       rotation_state[] NOT NULL,
  -- The day the cycle's first state lands on. Everything else is derived from
  -- this and the per-person offset, so a programme that starts its cycle on a
  -- different date does not need a different pattern.
  anchor_date  date NOT NULL,
  provenance   text NOT NULL DEFAULT 'assumed'
               CHECK (provenance IN ('stated', 'assumed', 'confirmed')),
  confirmed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  notes        text NOT NULL DEFAULT '',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rotation_patterns_states_present CHECK (cardinality(states) > 0),
  CONSTRAINT rotation_patterns_confirmed_has_who
    CHECK ((provenance = 'confirmed') = (confirmed_by IS NOT NULL))
);

CREATE INDEX rotation_patterns_service ON rotation_patterns (service_id);

-- Where in the cycle a given person sits. Two residents on the same q3 service
-- are two days apart; that is the whole content of an offset.
CREATE TABLE rotation_pattern_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id  uuid NOT NULL REFERENCES rotation_patterns (id) ON DELETE CASCADE,
  resident_id uuid NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  offset_days int  NOT NULL DEFAULT 0 CHECK (offset_days >= 0),
  team_id     uuid REFERENCES teams (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pattern_id, resident_id)
);

-- ---------------------------------------------------------------------------
-- Exceptions: any pattern, overridden for a date or a range, with a reason
-- ---------------------------------------------------------------------------
--
-- The worked example is the winter holiday block: a fortnight with its own
-- per-service rosters that replaces the normal pattern and stays visible as an
-- exception rather than quietly editing the pattern it suspends.

CREATE TABLE pattern_exceptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  pattern_id   uuid REFERENCES rotation_patterns (id) ON DELETE CASCADE,
  service_id   uuid REFERENCES services (id) ON DELETE CASCADE,
  resident_id  uuid REFERENCES residents (id) ON DELETE CASCADE,
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  -- Null means "no pattern applies here" — the holiday roster is entered by
  -- hand and nothing should be generated over it.
  replacement_states rotation_state[],
  reason       text NOT NULL,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pattern_exceptions_range CHECK (ends_on >= starts_on),
  CONSTRAINT pattern_exceptions_reason CHECK (length(btrim(reason)) > 0),
  -- It has to override *something*.
  CONSTRAINT pattern_exceptions_target
    CHECK (pattern_id IS NOT NULL OR service_id IS NOT NULL OR resident_id IS NOT NULL)
);

CREATE INDEX pattern_exceptions_window
  ON pattern_exceptions (program_id, starts_on, ends_on);

-- Per-person block cadence: what one programme calls its irregularities. A
-- 4+4 structure with individual exceptions is data, not a special case in code.
CREATE TABLE block_structure_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  structure_id  uuid NOT NULL REFERENCES block_structures (id) ON DELETE CASCADE,
  resident_id   uuid NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  block_index   int  NOT NULL CHECK (block_index >= 0),
  -- Either a different length for this person's block, or a shift of its start.
  length_days   int  CHECK (length_days IS NULL OR length_days BETWEEN 1 AND 366),
  offset_days   int  NOT NULL DEFAULT 0,
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (structure_id, resident_id, block_index),
  CONSTRAINT block_structure_exceptions_reason CHECK (length(btrim(reason)) > 0)
);

-- `block_structures.academic_year` already exists and is already the parameter
-- this needed — 2026 meaning the 2026–27 year. The two supplied documents
-- disagree about which year they describe, and that disagreement is recorded in
-- docs/AI_PROJECT_STATE.md under Decisions rather than resolved by picking one.
-- What the column lacked was provenance: whether a structure came from a
-- programme's own document or was inferred here.
ALTER TABLE block_structures
  ADD COLUMN provenance text NOT NULL DEFAULT 'assumed'
    CHECK (provenance IN ('stated', 'assumed', 'confirmed'));

-- ---------------------------------------------------------------------------
-- Where a shift came from
-- ---------------------------------------------------------------------------
--
-- Status governs *disclosure*, not function. Every one of these trades, and
-- both parties see both statuses before accepting — a resident deciding whether
-- to take somebody's shift is entitled to know whether the programme has
-- confirmed it or the person typed it in themselves. Confirming is
-- capability-gated and never available to a resident.

CREATE TYPE shift_provenance AS ENUM (
  'provisional',    -- generated from a pattern or a template; a placeholder
  'self_reported',  -- the resident entered or corrected it
  'imported',       -- came from a file the programme supplied
  'confirmed'       -- somebody with the authority has vouched for it
);

ALTER TABLE shifts
  ADD COLUMN provenance shift_provenance NOT NULL DEFAULT 'imported',
  ADD COLUMN position_id uuid REFERENCES positions (id) ON DELETE SET NULL,
  ADD COLUMN team_id uuid REFERENCES teams (id) ON DELETE SET NULL,
  ADD COLUMN confirmed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN confirmed_at timestamptz;

CREATE INDEX shifts_provenance ON shifts (program_id, provenance);

-- ---------------------------------------------------------------------------
-- Enrollment: one link, many people
-- ---------------------------------------------------------------------------
--
-- Distinct from `invitations`, which name one address and are consumed once.
-- An enrollment link is handed to a class: it expires, it can be revoked, it is
-- rate limited, and every use is audited.

CREATE TABLE enrollment_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  -- Only ever the hash. The link itself exists in whatever message carried it
  -- and nowhere else, exactly as with invitations.
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL DEFAULT '',
  -- The role somebody joining receives. Always 'resident' in practice; stored
  -- so that a programme wanting a chiefs-only link does not need a migration.
  grants_role   user_role NOT NULL DEFAULT 'resident',
  expires_at    timestamptz NOT NULL,
  max_uses      int CHECK (max_uses IS NULL OR max_uses > 0),
  uses          int NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enrollment_links_program ON enrollment_links (program_id);

CREATE TABLE enrollment_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id       uuid REFERENCES enrollment_links (id) ON DELETE SET NULL,
  program_id    uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  email         text NOT NULL,
  -- admitted | pending | refused, with why.
  outcome       text NOT NULL,
  detail        text NOT NULL DEFAULT '',
  ip            text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enrollment_events_program ON enrollment_events (program_id, created_at DESC);
-- The rate limit reads this: how many attempts from one address recently.
CREATE INDEX enrollment_events_recent ON enrollment_events (link_id, created_at DESC);

-- Per-programme email domains. With a restriction, a matching account is
-- admitted at once; without one, accounts land pending and see only themselves.
CREATE TABLE program_email_domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  domain      text NOT NULL,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, domain),
  CONSTRAINT program_email_domains_shape CHECK (domain = lower(domain) AND domain LIKE '%.%')
);

-- ---------------------------------------------------------------------------
-- Held import rows
-- ---------------------------------------------------------------------------
--
-- A file naming forty residents, of whom six have joined, must not lose the
-- other thirty-four. Their rows are held, shown to the administrator as
-- unmatched, and attached the moment that person enrolls.

CREATE TABLE held_shift_rows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  -- What the file said, normalised for matching. Both kept: the name is what an
  -- administrator recognises, the normalised form is what matches.
  resident_name text NOT NULL,
  match_key     text NOT NULL,
  email         text NOT NULL DEFAULT '',
  pgy_level     int,
  date          date NOT NULL,
  start_datetime timestamptz NOT NULL,
  end_datetime   timestamptz NOT NULL,
  service_name  text NOT NULL,
  rotation_name text NOT NULL DEFAULT '',
  shift_type    text NOT NULL DEFAULT 'day',
  location      text NOT NULL DEFAULT '',
  status_hint   text NOT NULL DEFAULT '',
  import_batch  uuid NOT NULL,
  claimed_at    timestamptz,
  claimed_by_resident uuid REFERENCES residents (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT held_shift_rows_end_after_start CHECK (end_datetime > start_datetime)
);

-- The lookup that runs on every enrollment: unclaimed rows for this name.
CREATE INDEX held_shift_rows_match
  ON held_shift_rows (program_id, match_key) WHERE claimed_at IS NULL;
CREATE INDEX held_shift_rows_batch ON held_shift_rows (import_batch);
