-- Program leadership roles, and services you can actually manage.
--
-- 1. `user_role` gains `apd` and `pd`. The enum's declared order is deliberate
--    and matches the seniority ordering the authorization layer uses:
--
--        resident < chief < apd < pd < admin
--
--    Ordering the enum this way means `ORDER BY role` in any ad-hoc query sorts
--    the way a human expects, and it keeps the database's idea of the hierarchy
--    from silently disagreeing with the application's.
--
--    ALTER TYPE ... ADD VALUE is transactional from PostgreSQL 12 onward as
--    long as the new value is not *used* in the same transaction. Nothing here
--    uses them, so this runs inside the migration transaction like every other
--    migration.
--
-- 2. Services and rotations become manageable objects rather than side effects
--    of an import: an optional abbreviation for the compact schedule views, and
--    case-insensitive uniqueness so "MICU" and "micu" cannot both exist and
--    quietly split a service in two.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'apd' AFTER 'chief';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'pd' AFTER 'apd';

-- ---------------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------------

ALTER TABLE services ADD COLUMN IF NOT EXISTS abbreviation text NOT NULL DEFAULT '';

-- The old constraint was case-sensitive, so it let "MICU" and "micu" coexist as
-- two services with two separate schedules. Replace it rather than add to it:
-- two overlapping uniqueness rules would produce two different error messages
-- for what a user experiences as one mistake.
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_program_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS services_program_name_lower_idx
  ON services (program_id, lower(name));

-- ---------------------------------------------------------------------------
-- Rotations
-- ---------------------------------------------------------------------------

ALTER TABLE rotations ADD COLUMN IF NOT EXISTS abbreviation text NOT NULL DEFAULT '';

ALTER TABLE rotations DROP CONSTRAINT IF EXISTS rotations_program_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS rotations_program_name_lower_idx
  ON rotations (program_id, lower(name));
