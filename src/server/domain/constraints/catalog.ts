import { HARD_CONSTRAINTS } from "./hard";
import { SOFT_CONSTRAINTS } from "./soft";
import type { Constraint } from "./types";

/**
 * Every scheduling constraint the configuration can express, in one list.
 *
 * The list is the model. A screen that wants to explain what makes a schedule
 * valid reads it; the validator runs it; the test suite iterates it and fails
 * if any entry has no test. Nothing anywhere else is allowed to decide that
 * something is a constraint.
 *
 * ## What is deliberately not here
 *
 * **Per-resident rotation quotas** — "every PGY-1 does at least two blocks of
 * MICU". The configuration cannot express this today. A programme says what a
 * *cohort* does in a block (`cohort_block_assignments`) and what one person
 * does differently (`resident_block_overrides`), and `block-structure` and
 * `block-override` check both. A quota table would be the next thing to add,
 * and until it exists inventing a default here would mean the validator
 * enforcing a curriculum no programme agreed to.
 *
 * **Travel time between sites.** Two non-overlapping shifts at two hospitals
 * an hour apart is a real problem and nothing in the configuration records the
 * hour. `overlapping-assignments` catches the case where they actually
 * collide.
 *
 * **Trade policy.** Minimum notice, holiday tradeability, trades per month,
 * open offers, non-tradeable services. These govern switching, not scheduling
 * — see `rule-bridge.ts`.
 */
export const CONSTRAINTS: Constraint[] = [...HARD_CONSTRAINTS, ...SOFT_CONSTRAINTS];

export const CONSTRAINTS_BY_ID = new Map(CONSTRAINTS.map((c) => [c.id, c]));

/* Two constraints sharing an id would silently shadow each other in the
   breakdown and in every test that looks one up. Checked at import, because a
   duplicate is a mistake nobody makes twice but everybody makes once. */
if (CONSTRAINTS_BY_ID.size !== CONSTRAINTS.length) {
  const seen = new Set<string>();
  const duplicate = CONSTRAINTS.find((c) => !seen.add(c.id))?.id;
  throw new Error(`Two constraints share the id "${duplicate}".`);
}

export { HARD_CONSTRAINTS, SOFT_CONSTRAINTS };
