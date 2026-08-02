-- ---------------------------------------------------------------------------
-- 0014 — a shift can change hands one way, and notifications become a choice
--
-- ## Two things, one migration, because they meet
--
-- A giveaway is the first event whose recipient list is not obvious ("a shift
-- you could take" goes to people with no prior involvement), and it is the
-- first that a resident might reasonably want to hear about and another might
-- reasonably not. Splitting them into two migrations would mean shipping the
-- event before anybody could turn it off.
--
-- ## Why the trade tables barely change
--
-- `completed_trades` + `trade_legs` were designed for this. The comment in
-- 0001 says so: "A 1:1 swap produces two legs; a future A->B->C->A rotation
-- simply produces more legs without any schema change." A giveaway is that
-- same generalisation in the other direction — one leg.
--
-- So the only structural change is dropping three NOT NULLs that assumed a
-- second shift and a second resident always exist, and adding a `kind` so that
-- nothing has to *infer* which shape a row is. Inferring it from
-- `destination_shift_id IS NULL` would work today and would silently
-- misclassify the first row some future feature writes with a null for its own
-- reasons. The invariant reads `kind`.
-- ---------------------------------------------------------------------------

CREATE TYPE trade_kind AS ENUM ('switch', 'giveaway');

-- ---------------------------------------------------------------------------
-- Postings and completions carry their kind
-- ---------------------------------------------------------------------------

ALTER TABLE trade_requests
  ADD COLUMN kind trade_kind NOT NULL DEFAULT 'switch';

ALTER TABLE completed_trades
  ADD COLUMN kind trade_kind NOT NULL DEFAULT 'switch';

/* A giveaway has no second shift and no second resident. Existing rows are all
   switches and keep both, so the default above leaves every historical record
   describing exactly what it described before. */
ALTER TABLE completed_trades ALTER COLUMN destination_shift_id DROP NOT NULL;
ALTER TABLE completed_trades ALTER COLUMN resident_b DROP NOT NULL;

/* A switch must still have both halves. Dropping a NOT NULL without putting
   this back would let a torn switch be written as a legal row, which is the
   opposite of what the invariant is for. */
ALTER TABLE completed_trades
  ADD CONSTRAINT completed_trades_switch_has_both_halves
  CHECK (
    kind <> 'switch'
    OR (destination_shift_id IS NOT NULL AND resident_b IS NOT NULL)
  );

/* And a giveaway must not pretend to have them. A row claiming to be one-way
   while naming a second shift is a bug that would otherwise be invisible. */
ALTER TABLE completed_trades
  ADD CONSTRAINT completed_trades_giveaway_has_one_half
  CHECK (
    kind <> 'giveaway'
    OR (destination_shift_id IS NULL AND resident_b IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Taking a shift is an offer of nothing
-- ---------------------------------------------------------------------------

/* Reusing `trade_offers` rather than adding a `giveaway_takes` table: the row
   answers the same question ("who put their hand up, and what became of it"),
   carries the same seven statuses, and is already what `completed_trades`
   points at, what the audit trail names, and what invalidation sweeps. A
   parallel table would need every one of those paths written twice, and the
   second copy is where the divergence starts. */
ALTER TABLE trade_offers ALTER COLUMN offered_shift_id DROP NOT NULL;

/* "An offer on a switch must name a shift" is deliberately *not* a CHECK here.
   It depends on another table, and PostgreSQL does not allow a subquery in a
   CHECK — a constraint written that way is rejected at apply time, and one
   written as a trigger to get around that is a second place where the rule
   lives. It is enforced where the row is written, and asserted by
   `assertDatabaseConsistent()`, which is where the other cross-table trade
   invariants already are. */

/* The existing unique index is on (trade_request_id, offered_shift_id), and
   PostgreSQL treats NULLs as distinct — so it stops nobody from offering
   nothing twice. One live hand up per resident per posting, instead. */
CREATE UNIQUE INDEX trade_offers_one_live_take_per_resident
  ON trade_offers (trade_request_id, offering_resident_id)
  WHERE offered_shift_id IS NULL AND status IN ('pending', 'accepted');

-- ---------------------------------------------------------------------------
-- What a resident was told, and took anyway
--
-- Taking a shift without giving one away is precisely the case rest and
-- workload limits exist for, and the product does not refuse it — a resident
-- decides. What it does is make the decision legible afterwards: the exact
-- sentences shown, who they were shown to, and what they did next.
--
-- The sentences are stored rather than the rule ids, because a rule's numbers
-- can be edited by a programme and a chief reading this in March needs to know
-- what the resident actually saw in January, not what the same rule would say
-- today.
-- ---------------------------------------------------------------------------

CREATE TABLE trade_warning_acknowledgements (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         uuid        NOT NULL REFERENCES programs (id) ON DELETE CASCADE,
  trade_request_id   uuid        NOT NULL REFERENCES trade_requests (id) ON DELETE CASCADE,
  trade_offer_id     uuid        REFERENCES trade_offers (id) ON DELETE SET NULL,
  completed_trade_id uuid        REFERENCES completed_trades (id) ON DELETE SET NULL,
  resident_id        uuid        NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  acknowledged_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
  -- The rendered sentences, each with its rule key and the numbers in it.
  warnings           jsonb       NOT NULL,
  acknowledged_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trade_warning_ack_program_idx
  ON trade_warning_acknowledgements (program_id, acknowledged_at DESC);
CREATE INDEX trade_warning_ack_resident_idx
  ON trade_warning_acknowledgements (resident_id, acknowledged_at DESC);

-- ---------------------------------------------------------------------------
-- Notifications become a choice
--
-- The old table was per-*category* — four coarse buckets — and carried two
-- channels. Three changes:
--
--   1. The key becomes the event, not the bucket. "Someone posted a shift you
--      could take" and "your switch needs a chief" were both `offers`, and a
--      resident who wanted the second and not the first had no way to say so.
--   2. Email joins push and in-app as a channel.
--   3. Defaults stop being "everything on". A row's absence used to mean send;
--      now the default lives in code per event, so an ambient event is off
--      until asked for and an actionable one is on until refused.
--
-- Existing rows are expanded rather than dropped: somebody who turned off
-- `offers` gets every event in that bucket turned off, which is what they
-- asked for with the vocabulary they had.
-- ---------------------------------------------------------------------------

ALTER TABLE notification_preferences
  ADD COLUMN email boolean NOT NULL DEFAULT false;

INSERT INTO notification_preferences (user_id, category, push, in_app, email)
SELECT p.user_id, e.event_key, p.push, p.in_app, false
  FROM notification_preferences p
  JOIN (VALUES
        ('offers',    'offer.created'),
        ('offers',    'offer.rejected'),
        ('offers',    'offer.invalidated'),
        ('offers',    'trade.expired'),
        ('offers',    'trade.cancelled'),
        ('offers',    'giveaway.posted'),
        ('approvals', 'approval.required'),
        ('approvals', 'approval.granted'),
        ('approvals', 'approval.rejected'),
        ('schedule',  'shift.changed'),
        ('schedule',  'schedule.published'),
        ('schedule',  'schedule.corrected'),
        ('switches',  'offer.accepted'),
        ('switches',  'switch.completed'),
        ('switches',  'giveaway.taken'),
        ('switches',  'email.generated')
       ) AS e (bucket, event_key)
    ON e.bucket = p.category
 WHERE p.category IN ('offers', 'approvals', 'schedule', 'switches')
    ON CONFLICT (user_id, category) DO NOTHING;

/* The four bucket rows are left in place rather than deleted. They are now
   unread by any code path — the keys no longer match an event — and removing
   them would be a `DELETE` this migration does not need to risk. They cost
   four rows per user who ever set a preference. */

-- ---------------------------------------------------------------------------
-- Quiet hours
--
-- Per user, in the programme's timezone, and deliberately not per programme: a
-- night-float resident sleeps at ten in the morning, and a rule set by a chief
-- would be wrong for exactly the people it most affects.
--
-- Null means no quiet hours. The pair is meaningless half-set, so a check
-- keeps them together.
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN quiet_hours_start time,
  ADD COLUMN quiet_hours_end   time;

ALTER TABLE users
  ADD CONSTRAINT users_quiet_hours_both_or_neither
  CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL));

-- ---------------------------------------------------------------------------
-- Shift reminders
--
-- A reminder is the one notification with no triggering action, so it needs a
-- record of having been sent — otherwise every sweep sends it again.
-- ---------------------------------------------------------------------------

CREATE TABLE shift_reminders (
  shift_id    uuid        NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  resident_id uuid        NOT NULL REFERENCES residents (id) ON DELETE CASCADE,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shift_id, resident_id)
);
