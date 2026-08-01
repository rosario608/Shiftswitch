-- Enrollment status: an account that is in the program but not yet vouched for.
--
-- An enrollment link is handed to a class, not to an address. That is what makes
-- it usable — a chief posts one link and forty people join over a fortnight —
-- and it is also the whole of its risk: anybody holding the link can open it.
--
-- Two things narrow that. A programme may list its email domains, and an
-- address inside one is admitted at once, because a hospital address is already
-- proof of belonging. Without that proof the account still joins — refusing
-- would send a real resident away at the only moment they were willing to sign
-- up — but it joins *pending*: it can see its own schedule and correct its own
-- hours, and it can see nothing about anybody else until somebody with the
-- authority admits it.
--
-- ## Why a column rather than reusing what is here
--
-- `users.active` is the wrong instrument: a deactivated account cannot sign in
-- at all, and this one must, or "nobody lands on an empty screen" fails at the
-- first person who used a personal address. `users.role = NULL` is the other
-- near miss — it already means "not configured yet", and it takes the program
-- with it, so a pending account would have no schedule to land on either.
--
-- So: a third fact, defaulting to `confirmed`, which is what every account that
-- exists today is. Nothing changes for anybody already in the product.

ALTER TABLE users
  ADD COLUMN enrollment_status text NOT NULL DEFAULT 'confirmed'
    CHECK (enrollment_status IN ('confirmed', 'pending'));

COMMENT ON COLUMN users.enrollment_status IS
  'confirmed: a full member. pending: joined by an enrollment link without a recognised email domain — sees only themselves until admitted.';

-- The administrator's queue: who is waiting, oldest first. Partial, because the
-- overwhelming majority of rows are confirmed and never want reading this way.
CREATE INDEX users_pending_enrollment
  ON users (program_id, created_at)
  WHERE enrollment_status = 'pending';
