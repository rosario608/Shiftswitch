import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { ProgramRow, ResidentRow, UserRow } from "@/server/db/types";
import type { AuthedContext } from "@/server/auth/guards";
import { addLocalDays, zonedWallTimeToInstant } from "@/server/domain/time";
import { createAbsence, type AbsenceKind } from "@/server/domain/availability";
import { postShiftForTrade } from "@/server/domain/trades";
import { createInvitation, revokeInvitation } from "@/server/domain/invitations";
import {
  anchorMonday,
  buildDemoPlan,
  DEMO_INSTITUTION,
  DEMO_PEOPLE,
  DEMO_PROGRAM_NAME,
  DEMO_ROTATIONS,
  DEMO_RULES,
  DEMO_SERVICES,
  DEMO_TIMEZONE,
} from "./plan";
import { assertDemoAllowed } from "./guard";

/**
 * Seeding and removing the demo program.
 *
 * Idempotence is achieved the blunt way: a seed removes the demo program
 * entirely and rebuilds it. That is deliberate. A merge-style seeder has to
 * decide what to do about a shift somebody edited, an offer somebody made, or a
 * resident somebody deactivated — and every answer to that is a source of
 * "the demo is in a weird state" bugs. Rebuilding means the demo is either
 * exactly as designed or absent, with nothing in between.
 *
 * Every statement that deletes anything is scoped by the demo program's name or
 * id. Nothing here can reach another program's rows.
 */

export interface SeedResult {
  programId: string;
  anchor: string;
  users: number;
  residents: number;
  services: number;
  rotations: number;
  shifts: number;
  posts: number;
  invitations: number;
  completedSwitches: number;
  pendingApprovals: number;
  liveOffers: number;
  declinedOffers: number;
  sites: number;
  coverageRequirements: number;
  cohorts: number;
  cohortMembers: number;
  blockOverrides: number;
  blocks: number;
  draftShifts: number;
  phones: number;
  absences: number;
  notifications: number;
  /** Plan ref -> shift id, so tests and tooling can address one exact shift. */
  shiftRefs: Record<string, string>;
}

async function findDemoProgram(): Promise<ProgramRow | null> {
  return queryOne<ProgramRow>("SELECT * FROM programs WHERE name = $1", [
    DEMO_PROGRAM_NAME,
  ]);
}

/**
 * Removes the demo program and everything hanging off it.
 *
 * The order matters and is not the obvious one. Three foreign keys refuse to
 * get out of the way on their own:
 *
 *   - `completed_trades` and `trade_legs` reference `shifts` with ON DELETE
 *     RESTRICT, so a demo in which somebody completed a switch cannot have its
 *     shifts removed until those are gone;
 *   - `shift_assignments` references `residents` with ON DELETE RESTRICT, so
 *     the shifts have to go before the people do;
 *   - `users.program_id` is ON DELETE SET NULL, and a user with a role and no
 *     program violates a check constraint — so users are removed before the
 *     program, not left to be nulled by it.
 *
 * Which gives: trades, then shifts, then people, then the program. Everything
 * else (`services`, `rotations`, `rules`, `program_contacts`, `sessions`,
 * `email_records`) cascades from one of those four.
 */
export async function resetDemoProgram(): Promise<boolean> {
  assertDemoAllowed();
  const program = await findDemoProgram();
  if (!program) return false;

  await withTransaction(async (client) => {
    const scoped = [program.id];

    // 1. Trade history, which holds shifts hostage.
    await query(
      `DELETE FROM trade_legs
        WHERE completed_trade_id IN (SELECT id FROM completed_trades WHERE program_id = $1)`,
      scoped,
      client,
    );
    await query("DELETE FROM completed_trades WHERE program_id = $1", scoped, client);
    await query(
      `DELETE FROM trade_offers
        WHERE trade_request_id IN (SELECT id FROM trade_requests WHERE program_id = $1)`,
      scoped,
      client,
    );
    await query("DELETE FROM trade_requests WHERE program_id = $1", scoped, client);

    // 2. Everything else that points at a user or the program directly.
    await query("DELETE FROM audit_logs WHERE program_id = $1", scoped, client);
    await query(
      `DELETE FROM notifications
        WHERE recipient_user_id IN (SELECT id FROM users WHERE program_id = $1)`,
      scoped,
      client,
    );
    await query("DELETE FROM invitations WHERE program_id = $1", scoped, client);

    // 3. Shifts — cascading their assignments, which is what frees the
    //    residents to be deleted at all.
    await query("DELETE FROM shifts WHERE program_id = $1", scoped, client);

    // 4. People, then the program itself.
    await query("DELETE FROM users WHERE program_id = $1", scoped, client);
    await query("DELETE FROM programs WHERE id = $1", scoped, client);
  });

  return true;
}

export async function seedDemoProgram(
  options: { anchor?: string; now?: Date } = {},
): Promise<SeedResult> {
  assertDemoAllowed();

  const anchor = options.anchor ?? anchorMonday(options.now ?? new Date());
  const plan = buildDemoPlan(anchor);

  await resetDemoProgram();

  const program = (await queryOne<ProgramRow>(
    `INSERT INTO programs (name, institution, timezone, approved_email_domains,
                           default_trade_approval_required)
     VALUES ($1, $2, $3, '{}', false)
     RETURNING *`,
    [DEMO_PROGRAM_NAME, DEMO_INSTITUTION, DEMO_TIMEZONE],
  ))!;

  const services = new Map<string, string>();
  for (const service of DEMO_SERVICES) {
    const row = (await queryOne<{ id: string }>(
      `INSERT INTO services (program_id, name, tradeable, active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [program.id, service.name, service.tradeable],
    ))!;
    services.set(service.name, row.id);
  }

  const rotations = new Map<string, string>();
  for (const name of DEMO_ROTATIONS) {
    const row = (await queryOne<{ id: string }>(
      "INSERT INTO rotations (program_id, name) VALUES ($1, $2) RETURNING id",
      [program.id, name],
    ))!;
    rotations.set(name, row.id);
  }

  // `rules.rule_type` is plain text with no foreign key: a wrong identifier
  // inserts happily and is then never evaluated, leaving a program that looks
  // governed and is not. Fail loudly instead.
  const { RULE_HANDLERS_BY_TYPE } = await import("@/server/domain/rules/handlers");
  for (const rule of DEMO_RULES) {
    if (!RULE_HANDLERS_BY_TYPE.has(rule.type)) {
      throw new Error(`No rule handler is registered for "${rule.type}".`);
    }
    await query(
      `INSERT INTO rules (program_id, rule_type, name, params)
       VALUES ($1, $2, $2, $3::jsonb)`,
      [program.id, rule.type, JSON.stringify(rule.params)],
    );
  }

  await query(
    `INSERT INTO program_contacts (program_id, name, email, contact_type, notify_role, active)
     VALUES ($1, 'Demo Coordinator', 'coordinator@demo.invalid', 'program_coordinator', 'to', true),
            ($1, 'Demo Chief', 'chiefs@demo.invalid', 'chief_resident', 'cc', true)`,
    [program.id],
  );

  const users = new Map<string, UserRow>();
  const residents = new Map<string, ResidentRow>();
  for (const entry of DEMO_PEOPLE) {
    // No `auth_user_id`: none of these accounts has a sign-in identity, so
    // nobody can authenticate as one through Google. In a development
    // environment with ALLOW_TEST_LOGIN the test-login endpoint will attach to
    // them, which is the whole point of having them.
    const user = (await queryOne<UserRow>(
      `INSERT INTO users (email, full_name, role, program_id, active)
       VALUES ($1, $2, $3, $4, true) RETURNING *`,
      [entry.email, entry.fullName, entry.role, program.id],
    ))!;
    users.set(entry.key, user);

    if (entry.pgy !== null) {
      const resident = (await queryOne<ResidentRow>(
        `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials, active)
         VALUES ($1, $2, $3, $4, '{BLS,ACLS}', true) RETURNING *`,
        [user.id, program.id, entry.pgy, 2027 + (4 - entry.pgy)],
      ))!;
      residents.set(entry.key, resident);
    }
  }

  const shiftIdByRef = new Map<string, string>();
  for (const planned of plan.shifts) {
    const start = zonedWallTimeToInstant(planned.date, planned.startTime, DEMO_TIMEZONE);
    const endDate = planned.endsNextDay
      ? new Date(new Date(`${planned.date}T00:00:00Z`).getTime() + 86_400_000)
          .toISOString()
          .slice(0, 10)
      : planned.date;
    const end = zonedWallTimeToInstant(endDate, planned.endTime, DEMO_TIMEZONE);

    const shift = (await queryOne<{ id: string }>(
      `INSERT INTO shifts (program_id, service_id, rotation_id, date, start_datetime,
                           end_datetime, location, shift_type, required_pgy_min,
                           required_pgy_max, tradeable, approval_required, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'scheduled')
       RETURNING id`,
      [
        program.id,
        services.get(planned.service),
        rotations.get(planned.rotation) ?? null,
        planned.date,
        start,
        end,
        planned.location,
        planned.shiftType,
        planned.requiredPgyMin,
        planned.requiredPgyMax,
        planned.tradeable,
        planned.approvalRequired,
      ],
    ))!;
    shiftIdByRef.set(planned.ref, shift.id);

    await query(
      `INSERT INTO shift_assignments (shift_id, resident_id, assignment_status)
       VALUES ($1, $2, 'active')`,
      [shift.id, residents.get(planned.residentKey)!.id],
    );
  }

  // Posting goes through the real domain function rather than an INSERT, so the
  // demo contains exactly the state a resident tapping "post" would produce —
  // including the shift status transition and the audit entry.
  let posts = 0;
  for (const post of plan.posts) {
    const planned = plan.shifts.find((shift) => shift.ref === post.ref)!;
    await postShiftForTrade(contextFor(program, users, residents, planned.residentKey), {
      shiftId: shiftIdByRef.get(post.ref)!,
      notes: post.notes,
    });
    posts += 1;
  }

  /* The trade lifecycle, driven through the real domain functions.
   *
   * Every state an evaluator needs to see — an offer waiting on a decision, a
   * switch that completed, one waiting on a chief, one that was declined — is
   * produced by the same code a resident's taps would run. Nothing is inserted
   * directly, so the notifications, the audit entries, the assignment swaps and
   * the generated program email are all the real ones. A demo assembled by
   * INSERT would show the right rows and none of the behaviour.
   */
  const { createOffer, acceptOffer, rejectOffer } = await import(
    "@/server/domain/trades"
  );

  async function post(ref: string, notes: string) {
    const planned = plan.shifts.find((shift) => shift.ref === ref)!;
    const request = await postShiftForTrade(
      contextFor(program, users, residents, planned.residentKey),
      { shiftId: shiftIdByRef.get(ref)!, notes },
    );
    posts += 1;
    return request;
  }

  async function offer(requestId: string, ref: string) {
    const planned = plan.shifts.find((shift) => shift.ref === ref)!;
    return createOffer(contextFor(program, users, residents, planned.residentKey), {
      tradeRequestId: requestId,
      offeredShiftId: shiftIdByRef.get(ref)!,
    });
  }

  let completedSwitches = 0;
  let pendingApprovals = 0;
  let liveOffers = 0;
  let declinedOffers = 0;

  // 1. An offer sitting on a posting, waiting for the poster to decide.
  {
    const request = plan.posts.find((entry) => entry.ref === "sc-offered-source")!;
    const posted = await queryOne<{ id: string }>(
      "SELECT id FROM trade_requests WHERE source_shift_id = $1",
      [shiftIdByRef.get(request.ref)!],
    );
    await offer(posted!.id, "sc-offered-offer");
    liveOffers += 1;
  }

  // 2. A switch that completed, so History and the program email are populated.
  {
    const posted = await post(
      "sc-done-source",
      "Swapped last week — leaving this here as an example.",
    );
    const made = await offer(posted.id, "sc-done-offer");
    const result = await acceptOffer(
      contextFor(program, users, residents, "brennan"),
      made.offer.id,
    );
    if (result.status === "completed") completedSwitches += 1;
    else pendingApprovals += 1;
  }

  // 3. A switch waiting on a chief. The two residents are at different training
  //    levels, and this program's approval rule fires on exactly that.
  {
    const posted = await post("sc-approval-source", "Family event — any help appreciated.");
    const made = await offer(posted.id, "sc-approval-offer");
    const result = await acceptOffer(
      contextFor(program, users, residents, "duong"),
      made.offer.id,
    );
    if (result.status === "pending_approval") pendingApprovals += 1;
    else completedSwitches += 1;
  }

  // 4. An offer the poster turned down, so the declined state is visible.
  {
    const request = plan.posts.find((entry) => entry.ref === "sc-rejected-source")!;
    const posted = await queryOne<{ id: string }>(
      "SELECT id FROM trade_requests WHERE source_shift_id = $1",
      [shiftIdByRef.get(request.ref)!],
    );
    const made = await offer(posted!.id, "sc-rejected-offer");
    await rejectOffer(
      contextFor(program, users, residents, "mbeki"),
      made.offer.id,
      "Thanks — I need something earlier in the week.",
    );
    declinedOffers += 1;
  }

  // Invitations likewise: created through `createInvitation`, so the tokens are
  // real, hashed and expiring exactly as a live one would be.
  const adminContext = contextFor(program, users, residents, "admin");
  let invitations = 0;
  for (const invitation of plan.invitations) {
    const created = await createInvitation(adminContext, {
      email: invitation.email,
      role: invitation.role,
      pgyLevel: invitation.pgy,
      expiresInDays: invitation.expiresInDays,
    });
    if (invitation.revoked) {
      await revokeInvitation(adminContext, created.invitation.id);
    }
    invitations += 1;
  }


  /* The scheduling foundation: sites, service configuration, coverage, cohorts,
     a block year, and a draft schedule.
     Driven through the same domain functions the scheduler screens call, so a
     coordinator opening the demo meets a programme that is genuinely configured
     rather than one whose tables happen to have rows in them. */
  const { createSite, updateSchedulingData, setSiteEligibility } = await import(
    "@/server/domain/roster"
  );
  const { createCoverage } = await import("@/server/domain/coverage");
  const { createBlockStructure, generateBlocks, listBlocks } = await import(
    "@/server/domain/blocks"
  );
  const { createCohort, addCohortMember, assignCohortToBlock } = await import(
    "@/server/domain/cohorts"
  );
  const { createScheduleVersion } = await import("@/server/domain/schedule-versions");

  const chiefContext = contextFor(program, users, residents, "whitfield");

  // Two sites, because site eligibility is only meaningful with more than one.
  const mainSite = await createSite(adminContext, {
    name: "Demo University Hospital",
    abbreviation: "DUH",
    notes: "Main teaching hospital",
  });
  const vaSite = await createSite(adminContext, {
    name: "Demo VA Medical Center",
    abbreviation: "VA",
    notes: "Separate credentialing — check site eligibility before scheduling",
  });

  /* Service configuration on the services the plan already created, so the
     Services screen shows a configured programme rather than bare names. */
  const serviceConfig: Record<
    string,
    { site: string; pgyMin: number; pgyMax: number; hours: number | null; mandatory: boolean }
  > = {
    /* PGY-1 upward, because the seeded schedule genuinely puts interns on the
       MICU with a senior. A floor of 2 would have described a different
       programme, and the validator would have been right to say so. */
    "Demo MICU": { site: mainSite.id, pgyMin: 1, pgyMax: 3, hours: 12, mandatory: true },
    "Demo Wards": { site: mainSite.id, pgyMin: 1, pgyMax: 3, hours: 12, mandatory: true },
    "Demo Night Float": { site: mainSite.id, pgyMin: 1, pgyMax: 3, hours: 12, mandatory: true },
    "Demo Clinic": { site: mainSite.id, pgyMin: 1, pgyMax: 3, hours: 9, mandatory: false },
    "Demo Emergency": { site: vaSite.id, pgyMin: 1, pgyMax: 2, hours: 9, mandatory: true },
    "Demo Scenario Ward": { site: mainSite.id, pgyMin: 1, pgyMax: 3, hours: 12, mandatory: false },
  };

  let coverageCount = 0;
  for (const [name, config] of Object.entries(serviceConfig)) {
    const serviceId = services.get(name);
    if (!serviceId) continue;
    await query(
      `UPDATE services
          SET site_id = $2, pgy_min = $3, pgy_max = $4, typical_shift_hours = $5,
              coverage_mandatory = $6
        WHERE id = $1`,
      [serviceId, config.site, config.pgyMin, config.pgyMax, config.hours, config.mandatory],
    );
  }

  /* Coverage requirements that exercise every scope: an ordinary week, a
     weekend, a named holiday and a special period. A demo showing only weekday
     coverage would not demonstrate that the other three exist.

     The numbers describe the schedule this seed actually produces, checked
     against it rather than chosen as a plausible-looking ideal. An earlier
     version asked for two to three people on the MICU while the plan rostered
     up to five, so validating the demo reported 241 problems — every one of
     them true, and all of them saying the same thing: the configuration was
     written about a different programme. A demo whose own validator condemns
     it teaches nobody anything.

     The PGY mixes live on the named date and the winter period, both outside
     the four weeks the seed schedules. That is deliberate: the mix is
     configured, visible on the Services screen and exercised by the model,
     without asserting a daily composition this hand-built month does not
     have. */
  const micuId = services.get("Demo MICU");
  if (micuId) {
    await createCoverage(adminContext, {
      serviceId: micuId,
      scope: "weekday",
      label: "Weekday day",
      daysOfWeek: [1, 2, 3, 4, 5],
      startTime: "07:00",
      endTime: "19:00",
      minStaff: 1,
      maxStaff: 5,
    });
    coverageCount += 1;
    await createCoverage(adminContext, {
      serviceId: micuId,
      scope: "weekday",
      /* Saturday only. The plan runs a six-day MICU week, and a requirement
         naming Sunday would report a gap every Sunday for a service this
         programme does not staff on Sundays. "Weekend" being a set of days
         rather than a scope is exactly what makes that expressible. */
      label: "Saturday",
      daysOfWeek: [6],
      minStaff: 1,
      maxStaff: 5,
    });
    coverageCount += 1;
  }

  const wardsId = services.get("Demo Wards");
  if (wardsId) {
    await createCoverage(adminContext, {
      serviceId: wardsId,
      scope: "weekday",
      label: "Monday to Saturday",
      daysOfWeek: [1, 2, 3, 4, 5, 6],
      minStaff: 4,
      maxStaff: 5,
    });
    coverageCount += 1;
    // A named date and a period, so both precedence tiers are visible.
    await createCoverage(adminContext, {
      serviceId: wardsId,
      scope: "date",
      label: "Thanksgiving",
      specificDate: `${new Date(anchor).getFullYear()}-11-26`,
      minStaff: 1,
      maxStaff: 2,
      // A senior on the holiday, which is where the mix is worth demonstrating.
      pgyMix: [{ pgy: 3, min: 1, max: null }],
    });
    coverageCount += 1;
    await createCoverage(adminContext, {
      serviceId: wardsId,
      scope: "period",
      label: "Winter holiday block",
      periodStart: `${new Date(anchor).getFullYear()}-12-24`,
      periodEnd: `${new Date(anchor).getFullYear() + 1}-01-01`,
      minStaff: 2,
      maxStaff: 2,
    });
    coverageCount += 1;
  }

  const nightId = services.get("Demo Night Float");
  if (nightId) {
    await createCoverage(adminContext, {
      serviceId: nightId,
      scope: "weekday",
      label: "Overnight, weeknights",
      daysOfWeek: [1, 2, 3, 4, 5],
      startTime: "19:00",
      endTime: "07:00",
      minStaff: 4,
      maxStaff: 5,
    });
    coverageCount += 1;
  }

  /* A 4+4 block year, generated rather than declared: `weeks: 4` with two
     alternating kinds. Changing either argument gives a different programme's
     year, which is the property worth demonstrating. */
  const structure = await createBlockStructure(chiefContext, {
    name: `${new Date(anchor).getFullYear()}–${String(new Date(anchor).getFullYear() + 1).slice(2)} 4+4`,
    academicYear: new Date(anchor).getFullYear(),
    description: "Four weeks inpatient paired with four ambulatory. Generated, then editable.",
    blocks: generateBlocks({
      startDate: anchor,
      weeks: 4,
      count: 13,
      kinds: ["Inpatient", "Ambulatory"],
    }),
  });
  const blockRows = await listBlocks(program.id, structure.id);

  /* Paired cohorts per PGY class — the structure that makes 4+4 work. Residents
     are distributed by their actual PGY level, so the cohorts reflect the
     roster rather than a fixed split. */
  const residentsByPgy = new Map<number, Array<{ key: string; id: string }>>();
  for (const person of DEMO_PEOPLE) {
    if (person.pgy === null) continue;
    const resident = residents.get(person.key);
    if (!resident) continue;
    const list = residentsByPgy.get(person.pgy) ?? [];
    list.push({ key: person.key, id: resident.id });
    residentsByPgy.set(person.pgy, list);
  }

  let cohortCount = 0;
  let cohortMembers = 0;
  const cohortIds: string[] = [];
  for (const [pgy, members] of [...residentsByPgy.entries()].sort((a, b) => a[0] - b[0])) {
    const first = await createCohort(chiefContext, {
      label: `PGY-${pgy} Cohort A`,
      pgyLevel: pgy,
      notes: "Alternates with Cohort B",
    });
    const second = await createCohort(chiefContext, {
      label: `PGY-${pgy} Cohort B`,
      pgyLevel: pgy,
      pairedCohortId: first.id,
      notes: "Alternates with Cohort A",
    });
    cohortCount += 2;
    cohortIds.push(first.id, second.id);

    members.forEach(() => undefined);
    for (const [index, member] of members.entries()) {
      const target = index % 2 === 0 ? first.id : second.id;
      await addCohortMember(chiefContext, target, member.id);
      cohortMembers += 1;
    }

    /* The alternation itself: A on wards while B is in clinic, swapping each
       block. This is what a paired cohort structure produces, and seeing it in
       the grid is how a scheduler understands the feature.

       It starts at the *second* block, because the first is the four weeks
       this seed has already scheduled by hand — the situation of every
       programme adopting a tool mid-year. Claiming the grid governs a month
       that was built before it would make the validator report sixty-two
       people on "the wrong service", all of them working exactly where the
       programme put them. What block 1 gets instead is the softer and truer
       signal: nobody said what these cohorts are doing, and they are
       scattered. */
    const inpatient = services.get("Demo Wards");
    const ambulatory = services.get("Demo Clinic");
    for (const [index, block] of blockRows.entries()) {
      if (index === 0) continue;
      const aInpatient = index % 2 === 0;
      await assignCohortToBlock(chiefContext, {
        cohortId: first.id,
        blockId: block.id,
        serviceId: (aInpatient ? inpatient : ambulatory) ?? null,
      });
      await assignCohortToBlock(chiefContext, {
        cohortId: second.id,
        blockId: block.id,
        serviceId: (aInpatient ? ambulatory : inpatient) ?? null,
      });
    }
  }

  /* One resident doing something other than their cohort, for one block.
     Every programme has these; a seed without one makes the exceptions section
     look like a feature nobody uses, when it is the thing that decides whether
     a scheduler keeps a spreadsheet alongside this. */
  let overrides = 0;
  const secondBlock = blockRows[1];
  const exceptional = residentsByPgy.get(2)?.[0] ?? residentsByPgy.get(1)?.[0];
  if (secondBlock && exceptional) {
    const { setResidentOverride } = await import("@/server/domain/cohorts");
    /* Recorded against the *second* block, which is where the cohort grid
       starts and therefore the first block an exception can be an exception
       *to*. It is also outside the four weeks this seed schedules, so it is an
       exception waiting to be honoured rather than one already broken — the
       validator would otherwise open the demo by reporting it. */
    await setResidentOverride(chiefContext, {
      residentId: exceptional.id,
      blockId: secondBlock.id,
      serviceId: services.get("Demo Clinic") ?? null,
      reason: "Make-up ambulatory block for time missed during orientation.",
    });
    overrides = 1;
  }

  /* Resident scheduling data: phone numbers, one person off the schedule, and
     VA eligibility recorded for a few. Enough that the roster screen shows
     something other than defaults. */
  let phones = 0;
  for (const [index, person] of DEMO_PEOPLE.filter((p) => p.pgy !== null).entries()) {
    const resident = residents.get(person.key);
    if (!resident) continue;
    await updateSchedulingData(chiefContext, resident.id, {
      phone: `919555${String(1000 + index).padStart(4, "0")}`,
      // One resident on leave, so "active but not schedulable" is visible.
      schedulable: person.key !== "varga",
      schedulingNotes:
        person.key === "varga" ? "On parental leave until the end of the block." : "",
    });
    phones += 1;
    // Two residents without VA credentialing, which is the point of the field.
    if (person.key === "abiodun" || person.key === "sorensen") {
      await setSiteEligibility(
        chiefContext,
        resident.id,
        vaSite.id,
        false,
        "VA credentialing not yet complete",
      );
    }
  }

  /* Structured availability, in all three of the states it comes in: a
     confirmed absence the validator enforces, a request nobody has agreed to
     yet, and a long leave that explains a resident who is off the roster. A
     demo whose availability screen is empty teaches nothing about the one
     distinction that matters — confirmed binds a schedule, requested does not. */
  let absences = 0;
  const AWAY: Array<{
    key: string;
    kind: AbsenceKind;
    fromDay: number;
    toDay: number;
    hard: boolean;
    notes: string;
  }> = [
    {
      /* One day, over a shift Mbeki actually works, so the report carries a
         line a reader can act on: the person, the day, the service, the
         reason. Deliberately *not* given to Varga, whose leave is already
         expressed by `schedulable = false` — recording it twice would report
         her nine shifts twice and teach a chief to skim the report. */
      key: "mbeki",
      kind: "vacation",
      fromDay: 16,
      toDay: 16,
      hard: true,
      notes: "Approved before the block was built.",
    },
    {
      /* After the seeded weeks end, so it demonstrates the enforced kind
         without colliding with a schedule that already exists. This is what a
         scheduler sees when they generate the *next* block. */
      key: "lindqvist",
      kind: "vacation",
      fromDay: 35,
      toDay: 41,
      hard: true,
      notes: "Approved annual leave.",
    },
    {
      /* Deliberately over days Okonkwo works. Soft, so the schedule stays
         valid and the conflict appears as a preference the schedule did not
         honour — which is the whole distinction, shown rather than described. */
      key: "okonkwo",
      kind: "conference",
      fromDay: 9,
      toDay: 11,
      hard: false,
      notes: "Abstract accepted — not yet confirmed by the program.",
    },
  ];
  for (const away of AWAY) {
    const resident = residents.get(away.key);
    if (!resident) continue;
    await createAbsence(chiefContext, {
      residentId: resident.id,
      kind: away.kind,
      startDate: addLocalDays(anchor, away.fromDay),
      endDate: addLocalDays(anchor, away.toDay),
      hard: away.hard,
      notes: away.notes,
    });
    absences += 1;
  }

  /* A draft schedule over the coming fortnight, copied from the live one, so
     the diff has something to show and "publish" is not an empty gesture. */
  const draftStart = anchor;
  const draftEndDate = new Date(`${anchor}T00:00:00Z`);
  draftEndDate.setUTCDate(draftEndDate.getUTCDate() + 13);
  const draft = await createScheduleVersion(chiefContext, {
    name: "Next fortnight — draft",
    periodStart: draftStart,
    periodEnd: draftEndDate.toISOString().slice(0, 10),
    blockStructureId: structure.id,
    notes: "Copied from the published schedule. Check the diff before publishing.",
    copyFromPublished: true,
  });

  return {
    programId: program.id,
    anchor,
    users: users.size,
    residents: residents.size,
    services: services.size,
    rotations: rotations.size,
    shifts: plan.shifts.length,
    posts,
    invitations,
    completedSwitches,
    pendingApprovals,
    liveOffers,
    declinedOffers,
    sites: 2,
    coverageRequirements: coverageCount,
    cohorts: cohortCount,
    cohortMembers,
    blockOverrides: overrides,
    blocks: blockRows.length,
    draftShifts: draft.shift_count,
    phones,
    absences,
    notifications: Number(
      (
        await queryOne<{ count: string }>(
          `SELECT count(*)::text AS count FROM notifications
            WHERE recipient_user_id IN (SELECT id FROM users WHERE program_id = $1)`,
          [program.id],
        )
      )?.count ?? 0,
    ),
    shiftRefs: Object.fromEntries(shiftIdByRef),
  };
}

/**
 * The context the domain functions expect. The demo has no HTTP request and no
 * session, so this is assembled directly — but from the rows that were actually
 * written, so authorization behaves exactly as it would for a signed-in person.
 */
function contextFor(
  program: ProgramRow,
  users: Map<string, UserRow>,
  residents: Map<string, ResidentRow>,
  key: string,
): AuthedContext & { resident: ResidentRow } {
  const user = users.get(key)!;
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      pictureUrl: null,
      role: user.role!,
      programId: program.id,
      active: user.active,
    },
    program,
    resident: residents.get(key) ?? null,
    sessionId: "demo-seed",
  } as AuthedContext & { resident: ResidentRow };
}

export { DEMO_PROGRAM_NAME };
