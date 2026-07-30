-- ShiftSwitch initial schema
-- All timestamps are stored as timestamptz (absolute instants).
-- Wall-clock rendering is always performed in the owning program's IANA timezone.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enumerated domains
-- ---------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('resident', 'chief', 'admin');

CREATE TYPE shift_status AS ENUM (
  'scheduled',
  'posted',
  'offer_pending',
  'pending_approval',
  'completed',
  'cancelled'
);

CREATE TYPE trade_request_status AS ENUM (
  'open',
  'offer_pending',
  'accepted',
  'pending_approval',
  'approved',
  'completed',
  'cancelled',
  'expired'
);

CREATE TYPE trade_offer_status AS ENUM (
  'pending',
  'accepted',
  'rejected',
  'withdrawn',
  'invalidated',
  'expired',
  'completed'
);

CREATE TYPE assignment_status AS ENUM ('active', 'ended');

CREATE TYPE contact_type AS ENUM (
  'program_coordinator',
  'chief_resident',
  'associate_program_director',
  'program_director',
  'other'
);

CREATE TYPE email_status AS ENUM ('generated', 'opened', 'marked_sent');

CREATE TYPE rule_scope AS ENUM ('program', 'service', 'rotation', 'shift');

-- ---------------------------------------------------------------------------
-- Programs
-- ---------------------------------------------------------------------------

CREATE TABLE programs (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                          text        NOT NULL,
  institution                   text        NOT NULL,
  timezone                      text        NOT NULL DEFAULT 'America/New_York',
  approved_email_domains        text[]      NOT NULL DEFAULT '{}',
  default_trade_approval_required boolean   NOT NULL DEFAULT false,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programs_name_institution_key UNIQUE (name, institution)
);

-- ---------------------------------------------------------------------------
-- Users / identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id text        UNIQUE,                   -- Google `sub` (OIDC subject)
  email        text        NOT NULL UNIQUE,
  full_name    text        NOT NULL DEFAULT '',
  picture_url  text,
  role         user_role,                            -- NULL => not yet configured
  program_id   uuid        REFERENCES programs (id) ON DELETE SET NULL,
  active       boolean     NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- A configured user must always belong to a program.
  CONSTRAINT users_role_requires_program CHECK (role IS NULL OR program_id IS NOT NULL)
);

CREATE INDEX users_program_idx ON users (program_id);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,           -- sha256 of the opaque cookie value
  user_agent  text,
  ip_hash     text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Residents
-- ---------------------------------------------------------------------------

CREATE TABLE residents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  program_id      uuid        NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  pgy_level       int         NOT NULL CHECK (pgy_level BETWEEN 1 AND 10),
  graduation_year int         NOT NULL CHECK (graduation_year BETWEEN 1900 AND 2200),
  credentials     text[]      NOT NULL DEFAULT '{}',
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT residents_user_program_key UNIQUE (user_id, program_id)
);

CREATE INDEX residents_program_idx ON residents (program_id, active);

-- ---------------------------------------------------------------------------
-- Services / rotations
-- ---------------------------------------------------------------------------

CREATE TABLE services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid    NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  name        text    NOT NULL,
  tradeable   boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_program_name_key UNIQUE (program_id, name)
);

CREATE TABLE rotations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid    NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  name        text    NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rotations_program_name_key UNIQUE (program_id, name)
);

-- ---------------------------------------------------------------------------
-- Shifts and assignments
-- ---------------------------------------------------------------------------

CREATE TABLE shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id       uuid        NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  service_id       uuid        NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  rotation_id      uuid        REFERENCES rotations (id) ON DELETE SET NULL,
  -- `date` is the *calendar date of the shift start in the program timezone*.
  -- It is a denormalised label for grouping/sorting only; start/end instants are
  -- authoritative for every duration, rest, and overlap computation.
  date             date        NOT NULL,
  start_datetime   timestamptz NOT NULL,
  end_datetime     timestamptz NOT NULL,
  location         text        NOT NULL DEFAULT '',
  shift_type       text        NOT NULL DEFAULT 'day',
  required_pgy_min int         NOT NULL DEFAULT 1 CHECK (required_pgy_min BETWEEN 1 AND 10),
  required_pgy_max int         NOT NULL DEFAULT 10 CHECK (required_pgy_max BETWEEN 1 AND 10),
  tradeable        boolean     NOT NULL DEFAULT true,
  approval_required boolean    NOT NULL DEFAULT false,
  trade_deadline   timestamptz,
  status           shift_status NOT NULL DEFAULT 'scheduled',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shifts_end_after_start CHECK (end_datetime > start_datetime),
  CONSTRAINT shifts_pgy_range CHECK (required_pgy_max >= required_pgy_min)
);

CREATE INDEX shifts_program_start_idx ON shifts (program_id, start_datetime);
CREATE INDEX shifts_service_idx ON shifts (service_id);
CREATE INDEX shifts_status_idx ON shifts (program_id, status);

CREATE TABLE shift_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id          uuid        NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  resident_id       uuid        NOT NULL REFERENCES residents (id) ON DELETE RESTRICT,
  assignment_status assignment_status NOT NULL DEFAULT 'active',
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  CONSTRAINT shift_assignments_ended CHECK (
    (assignment_status = 'active' AND ended_at IS NULL) OR
    (assignment_status = 'ended'  AND ended_at IS NOT NULL)
  )
);

-- A shift has at most one authoritative (active) assignment.
CREATE UNIQUE INDEX shift_assignments_one_active_per_shift
  ON shift_assignments (shift_id)
  WHERE assignment_status = 'active';

CREATE INDEX shift_assignments_resident_idx
  ON shift_assignments (resident_id, assignment_status);

-- ---------------------------------------------------------------------------
-- Trade requests / offers
-- ---------------------------------------------------------------------------

CREATE TABLE trade_requests (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id             uuid        NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  source_shift_id        uuid        NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  initiating_resident_id uuid        NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  status                 trade_request_status NOT NULL DEFAULT 'open',
  preferences            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  notes                  text        NOT NULL DEFAULT '',
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- A shift can only be posted once at a time.
CREATE UNIQUE INDEX trade_requests_one_open_per_shift
  ON trade_requests (source_shift_id)
  WHERE status IN ('open', 'offer_pending', 'accepted', 'pending_approval', 'approved');

CREATE INDEX trade_requests_program_status_idx ON trade_requests (program_id, status);
CREATE INDEX trade_requests_resident_idx ON trade_requests (initiating_resident_id);

CREATE TABLE trade_offers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_request_id     uuid        NOT NULL REFERENCES trade_requests (id) ON DELETE CASCADE,
  offered_shift_id     uuid        NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  offering_resident_id uuid        NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  status               trade_offer_status NOT NULL DEFAULT 'pending',
  validation_snapshot  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  invalidation_reason  text,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The same shift may not be offered twice to the same request while live.
CREATE UNIQUE INDEX trade_offers_one_live_per_shift_request
  ON trade_offers (trade_request_id, offered_shift_id)
  WHERE status IN ('pending', 'accepted');

CREATE INDEX trade_offers_request_idx ON trade_offers (trade_request_id, status);
CREATE INDEX trade_offers_resident_idx ON trade_offers (offering_resident_id, status);
CREATE INDEX trade_offers_shift_idx ON trade_offers (offered_shift_id, status);

-- ---------------------------------------------------------------------------
-- Completed trades
--
-- `completed_trades` is the durable header record for a finalised transaction.
-- `trade_legs` describes each shift that changed hands. A 1:1 swap produces two
-- legs; a future A->B->C->A rotation simply produces more legs without any
-- schema change. The denormalised source/destination columns are convenience
-- fields for the (currently only) 1:1 case.
-- ---------------------------------------------------------------------------

CREATE TABLE completed_trades (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id           uuid        NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  trade_request_id     uuid        REFERENCES trade_requests (id) ON DELETE SET NULL,
  trade_offer_id       uuid        REFERENCES trade_offers (id) ON DELETE SET NULL,
  source_shift_id      uuid        NOT NULL REFERENCES shifts (id) ON DELETE RESTRICT,
  destination_shift_id uuid        NOT NULL REFERENCES shifts (id) ON DELETE RESTRICT,
  resident_a           uuid        NOT NULL REFERENCES residents (id) ON DELETE RESTRICT,
  resident_b           uuid        NOT NULL REFERENCES residents (id) ON DELETE RESTRICT,
  previous_assignments jsonb       NOT NULL,
  resulting_assignments jsonb      NOT NULL,
  approval_required    boolean     NOT NULL DEFAULT false,
  approved_by          uuid        REFERENCES users (id) ON DELETE SET NULL,
  approved_at          timestamptz,
  approval_notes       text,
  override_applied     boolean     NOT NULL DEFAULT false,
  validation_snapshot  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  completed_at         timestamptz NOT NULL DEFAULT now(),
  completed_by         uuid        REFERENCES users (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX completed_trades_offer_key
  ON completed_trades (trade_offer_id)
  WHERE trade_offer_id IS NOT NULL;

CREATE INDEX completed_trades_program_idx ON completed_trades (program_id, completed_at DESC);
CREATE INDEX completed_trades_resident_a_idx ON completed_trades (resident_a);
CREATE INDEX completed_trades_resident_b_idx ON completed_trades (resident_b);

CREATE TABLE trade_legs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  completed_trade_id  uuid NOT NULL REFERENCES completed_trades (id) ON DELETE CASCADE,
  leg_index           int  NOT NULL,
  shift_id            uuid NOT NULL REFERENCES shifts (id) ON DELETE RESTRICT,
  from_resident_id    uuid NOT NULL REFERENCES residents (id) ON DELETE RESTRICT,
  to_resident_id      uuid NOT NULL REFERENCES residents (id) ON DELETE RESTRICT,
  CONSTRAINT trade_legs_unique_index UNIQUE (completed_trade_id, leg_index)
);

-- ---------------------------------------------------------------------------
-- Program contacts
-- ---------------------------------------------------------------------------

CREATE TABLE program_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid         NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  name          text         NOT NULL,
  email         text         NOT NULL,
  contact_type  contact_type NOT NULL DEFAULT 'other',
  notify_role   text         NOT NULL DEFAULT 'to' CHECK (notify_role IN ('to', 'cc', 'none')),
  active        boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT program_contacts_email_key UNIQUE (program_id, email)
);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type           text        NOT NULL,
  title          text        NOT NULL,
  body           text        NOT NULL DEFAULT '',
  read_at        timestamptz,
  related_entity_type text,
  related_entity_id   uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_recipient_idx
  ON notifications (recipient_user_id, created_at DESC);
CREATE INDEX notifications_unread_idx
  ON notifications (recipient_user_id) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- Email records
-- ---------------------------------------------------------------------------

CREATE TABLE email_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  completed_trade_id uuid        NOT NULL REFERENCES completed_trades (id) ON DELETE CASCADE,
  generated_by       uuid        REFERENCES users (id) ON DELETE SET NULL,
  recipients         text[]      NOT NULL DEFAULT '{}',
  cc_recipients      text[]      NOT NULL DEFAULT '{}',
  subject            text        NOT NULL,
  body               text        NOT NULL,
  status             email_status NOT NULL DEFAULT 'generated',
  generated_at       timestamptz NOT NULL DEFAULT now(),
  opened_at          timestamptz,
  marked_sent_at     timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_records_trade_idx ON email_records (completed_trade_id);

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

CREATE TABLE rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid       NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  rule_type   text       NOT NULL,
  name        text       NOT NULL,
  description text       NOT NULL DEFAULT '',
  params      jsonb      NOT NULL DEFAULT '{}'::jsonb,
  severity    text       NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
  scope       rule_scope NOT NULL DEFAULT 'program',
  scope_id    uuid,
  overridable boolean    NOT NULL DEFAULT true,
  active      boolean    NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rules_scope_id_required CHECK (scope = 'program' OR scope_id IS NOT NULL)
);

CREATE INDEX rules_program_idx ON rules (program_id, active);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  program_id    uuid        REFERENCES programs (id) ON DELETE SET NULL,
  actor_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  actor_label   text        NOT NULL DEFAULT 'system',
  action        text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     text,
  previous_state jsonb,
  new_state     jsonb,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_program_idx ON audit_logs (program_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER programs_updated_at BEFORE UPDATE ON programs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER residents_updated_at BEFORE UPDATE ON residents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER shifts_updated_at BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trade_requests_updated_at BEFORE UPDATE ON trade_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trade_offers_updated_at BEFORE UPDATE ON trade_offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER email_records_updated_at BEFORE UPDATE ON email_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER rules_updated_at BEFORE UPDATE ON rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
