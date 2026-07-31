-- Indexes for the foreign keys the application actually filters on.
--
-- Found by auditing every single-column foreign key with no supporting index
-- and then checking which ones a real code path scans. Most unindexed foreign
-- keys here are fine and deliberately left alone: an index is not free, and
-- adding one to a column nothing filters on costs write throughput to make a
-- query nobody runs faster.
--
-- These five are different. Each one is scanned on a path that runs regularly:
--
--   shifts.rotation_id
--     The Services screen counts the shifts on each rotation. Without this the
--     count subquery sequentially scans `shifts` once per rotation — confirmed
--     with EXPLAIN, which showed a Seq Scan inside the SubPlan.
--
--   completed_trades.source_shift_id
--   completed_trades.destination_shift_id
--   trade_legs.shift_id
--     All three reference `shifts` with ON DELETE RESTRICT, so PostgreSQL must
--     check them before any shift is deleted, and `deleteShift` queries two of
--     them directly to produce a readable refusal. Deleting a shift in a program
--     with a long trade history scanned the whole table three times.
--
--   completed_trades.trade_request_id
--     Every completed switch is looked up from its originating post, which is
--     how a resident opens "what happened to the shift I posted".

CREATE INDEX IF NOT EXISTS shifts_rotation_idx
  ON shifts (rotation_id) WHERE rotation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS completed_trades_source_shift_idx
  ON completed_trades (source_shift_id);

CREATE INDEX IF NOT EXISTS completed_trades_destination_shift_idx
  ON completed_trades (destination_shift_id);

CREATE INDEX IF NOT EXISTS completed_trades_request_idx
  ON completed_trades (trade_request_id);

CREATE INDEX IF NOT EXISTS trade_legs_shift_idx
  ON trade_legs (shift_id);
