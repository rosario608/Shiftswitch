-- Persist where a notification leads.
--
-- A notification already knew its destination: `notify()` computed a `route`
-- and handed it to the push payload, so tapping a phone notification opened the
-- right screen. The in-app list did not get that value — it was never stored —
-- so `notifications/page.tsx` re-derived a link from the related entity with
-- its own switch statement.
--
-- Two derivations of the same thing is one too many, and they had already
-- diverged. Neither knew what to do with a `trade_offer`, which is the entity
-- on the three notifications a resident is most likely to tap:
--
--   "Your offer was declined"
--   "An offer is no longer available"
--   "New offer on your posted shift"
--
-- The push side papered over it because those callers pass an explicit route.
-- The in-app side fell through to a `default` and sent the resident to the
-- trades board — the generic list of everyone else's postings, with no trace of
-- the offer they were just told about. A resident who tapped "your offer was
-- declined" landed somewhere that did not mention their offer at all.
--
-- Storing the route fixes that at the root: one value, computed once where the
-- notification is written and the surrounding context is actually in scope, and
-- read by both surfaces. A screen can no longer disagree with a phone.
--
-- Existing rows are backfilled with the same mapping `routeFor` applies, so
-- nothing that has already been delivered loses its destination. The column is
-- NOT NULL with a '' default rather than nullable: an empty route means "no
-- particular destination", which is a real state, and leaves the read path with
-- one case to handle instead of two.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT '';

UPDATE notifications
   SET route = CASE
     WHEN related_entity_id IS NULL THEN '/notifications'
     WHEN related_entity_type = 'trade_request'   THEN '/trades/'   || related_entity_id
     WHEN related_entity_type = 'completed_trade' THEN '/switches/' || related_entity_id
     WHEN related_entity_type = 'shift'           THEN '/schedule/' || related_entity_id
     ELSE '/notifications'
   END
 WHERE route = '';
