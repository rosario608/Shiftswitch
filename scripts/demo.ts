#!/usr/bin/env tsx
/**
 * The demo program: seed it, reset it, or ask what is there.
 *
 *   npm run demo:seed     rebuild "ShiftSwitch Demo Residency" from scratch
 *   npm run demo:reset    remove it and leave nothing behind
 *   npm run demo:status   report what is currently seeded
 *
 * Development and staging only. See `scripts/demo/guard.ts` for the interlock
 * and `docs/DEMO_DATA.md` for the accounts and scenarios it creates.
 */
import { loadEnv } from "./load-env";
import { checkDemoAllowed } from "./demo/guard";
import {
  DEMO_EXISTING_MEMBER_EMAIL,
  DEMO_INVITATIONS,
  DEMO_PEOPLE,
  DEMO_PROGRAM_NAME,
} from "./demo/plan";

loadEnv();

async function main() {
  const command = process.argv[2] ?? "seed";
  const guard = checkDemoAllowed();

  if (command !== "status" && !guard.allowed) {
    console.error(`[demo] refusing to touch ${guard.target}:`);
    for (const reason of guard.reasons) console.error(`  - ${reason}`);
    process.exit(1);
  }

  const { closePool, queryOne } = await import("@/server/db/pool");

  if (command === "status") {
    const program = await queryOne<{ id: string; created_at: Date }>(
      "SELECT id, created_at FROM programs WHERE name = $1",
      [DEMO_PROGRAM_NAME],
    );
    if (!program) {
      console.log(`[demo] "${DEMO_PROGRAM_NAME}" is not seeded on ${guard.target}.`);
    } else {
      const counts = await queryOne<{
        users: string;
        shifts: string;
        posted: string;
        invitations: string;
        live_offers: string;
        awaiting_approval: string;
        completed: string;
        notifications: string;
      }>(
        `SELECT (SELECT count(*) FROM users WHERE program_id = $1)::text          AS users,
                (SELECT count(*) FROM shifts WHERE program_id = $1)::text         AS shifts,
                (SELECT count(*) FROM trade_requests WHERE program_id = $1)::text AS posted,
                (SELECT count(*) FROM invitations WHERE program_id = $1)::text    AS invitations,
                (SELECT count(*) FROM trade_offers o
                   JOIN trade_requests r ON r.id = o.trade_request_id
                  WHERE r.program_id = $1 AND o.status = 'pending')::text         AS live_offers,
                (SELECT count(*) FROM trade_requests
                  WHERE program_id = $1 AND status = 'pending_approval')::text    AS awaiting_approval,
                (SELECT count(*) FROM completed_trades WHERE program_id = $1)::text
                                                                                  AS completed,
                (SELECT count(*) FROM notifications
                  WHERE recipient_user_id IN
                        (SELECT id FROM users WHERE program_id = $1))::text       AS notifications`,
        [program.id],
      );
      console.log(
        `[demo] "${DEMO_PROGRAM_NAME}" on ${guard.target}\n` +
          `  seeded            ${program.created_at.toISOString()}\n` +
          `  users             ${counts!.users}\n` +
          `  shifts            ${counts!.shifts}\n` +
          `  posted            ${counts!.posted}\n` +
          `  invitations       ${counts!.invitations}\n` +
          `  live offers       ${counts!.live_offers}\n` +
          `  awaiting a chief  ${counts!.awaiting_approval}\n` +
          `  completed         ${counts!.completed}\n` +
          `  notifications     ${counts!.notifications}`,
      );
    }
    if (!guard.allowed) {
      console.log(
        "\n[demo] Seeding and resetting are blocked here:\n" +
          guard.reasons.map((reason) => `  - ${reason}`).join("\n"),
      );
    }
    await closePool();
    return;
  }

  if (command === "reset") {
    const { resetDemoProgram } = await import("./demo/seed");
    const removed = await resetDemoProgram();
    console.log(
      removed
        ? `[demo] removed "${DEMO_PROGRAM_NAME}" from ${guard.target}.`
        : `[demo] nothing to remove — "${DEMO_PROGRAM_NAME}" was not there.`,
    );
    await closePool();
    return;
  }

  if (command !== "seed") {
    console.error(`[demo] unknown command "${command}". Use seed, reset or status.`);
    process.exit(1);
  }

  const { seedDemoProgram } = await import("./demo/seed");
  const result = await seedDemoProgram();

  const admin = DEMO_PEOPLE.find((p) => p.role === "admin")!;
  const chief = DEMO_PEOPLE.find((p) => p.role === "chief")!;
  const scenarioPeople = DEMO_PEOPLE.filter((p) => p.note);

  console.log(`
[demo] "${DEMO_PROGRAM_NAME}" rebuilt on ${guard.target}.

  Week starting   ${result.anchor} (America/New_York)
  Users           ${result.users}  (${result.residents} with resident records)
  Services        ${result.services}   Rotations ${result.rotations}
  Shifts          ${result.shifts}
  Posted          ${result.posts}
  Invitations     ${result.invitations}

  Trade lifecycle, all of it driven through the real domain code:
  Live offers     ${result.liveOffers}  waiting on the poster to decide
  Declined        ${result.declinedOffers}  turned down, with a reason
  Awaiting chief  ${result.pendingApprovals}  sitting in the approvals queue
  Completed       ${result.completedSwitches}  switched, and in both residents' history
  Notifications   ${result.notifications}  already delivered in-app

  Scheduling foundation, configured through the scheduler screens' own code:
  Sites           ${result.sites}
  Coverage rules  ${result.coverageRequirements}  weekday, weekend, a named date and a holiday period
  Cohorts         ${result.cohorts}  paired per PGY class, ${result.cohortMembers} members
  Blocks          ${result.blocks}  a 4+4 year, generated from weeks + alternating kinds
  Exceptions      ${result.blockOverrides}  one resident off their cohort's block, with a reason
  Draft schedule  ${result.draftShifts} shifts  waiting to be diffed and published
  Phone numbers   ${result.phones}  validated, readable only with residents.contact_info
  Availability    ${result.absences}  one confirmed and clear of the schedule, one confirmed over a shift, one requested

  Onboarding a beta programme, in every state at once:
  Held rows       ${result.heldRowsImported}  imported for people with no account, of which ${result.claimedOnArrival} were claimed on arrival
  Still waiting   ${result.unmatchedPeople}  named by the file, has not signed in yet
  Pending member  ${result.pendingMembers}  joined with an outside address, sees only their own schedule
  Self-reported   ${result.selfReported}  shifts a resident entered themselves
  Unconfirmed     ${result.unconfirmedDefaults}  defaults shipped as a guess, generating nothing until checked

  Administrator   ${admin.email}
  Chief resident  ${chief.email}

  Scenario accounts:
${scenarioPeople.map((p) => `    ${p.email.padEnd(34)} ${p.note}`).join("\n")}

  Invitation scenarios:
${DEMO_INVITATIONS.map((i) => `    ${i.email.padEnd(34)} ${i.scenario}`).join("\n")}
    ${DEMO_EXISTING_MEMBER_EMAIL.padEnd(34)} inviting this address must be refused

  Everything above is invented, and every address is under .invalid, which can
  never be delivered to. Sign in as any of them with ALLOW_TEST_LOGIN=true.
  Full documentation: docs/DEMO_DATA.md
`);

  await closePool();
}

main().catch((error) => {
  console.error("[demo] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
