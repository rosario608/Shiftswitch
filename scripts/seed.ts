#!/usr/bin/env tsx
/**
 * Development / demo seed data.
 *
 * Everything here is synthetic: invented names, invented @hospital.org email
 * addresses, no patient information of any kind.
 *
 * The trade fixtures are produced by calling the real domain services, so the
 * seed doubles as a smoke test of the posting / offering / approval workflow.
 */
import { DateTime } from "luxon";
import { loadEnv } from "./load-env";

loadEnv();

async function main() {
  const { closePool, query, queryOne, withTransaction } = await import(
    "@/server/db/pool"
  );
  const { zonedWallTimeToInstant } = await import("@/server/domain/time");
  const { postShiftForTrade, createOffer, acceptOffer, approveTrade } =
    await import("@/server/domain/trades");
  const { generateSwitchEmail } = await import("@/server/domain/email");
  const { recordAudit } = await import("@/server/domain/audit");
  const { notify } = await import("@/server/domain/notifications");
  type ProgramRow = import("@/server/db/types").ProgramRow;
  type ShiftDetail = import("@/server/db/types").ShiftDetail;
  type AuthedContext = import("@/server/auth/guards").AuthedContext;

  console.log("[seed] clearing existing data");
  await query(`
    TRUNCATE audit_logs, email_records, notifications, trade_legs, completed_trades,
             trade_offers, trade_requests, shift_assignments, shifts, rules,
             program_contacts, residents, sessions, users, services, rotations, programs
    RESTART IDENTITY CASCADE
  `);

  // -------------------------------------------------------------------------
  // Programs
  // -------------------------------------------------------------------------
  const program = (await queryOne<ProgramRow>(
    `INSERT INTO programs (name, institution, timezone, approved_email_domains, default_trade_approval_required)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      "Internal Medicine Residency",
      "Riverside University Hospital",
      "America/New_York",
      [],
      false,
    ],
  ))!;

  const otherProgram = (await queryOne<ProgramRow>(
    `INSERT INTO programs (name, institution, timezone, approved_email_domains, default_trade_approval_required)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      "Emergency Medicine Residency",
      "Metro General Hospital",
      "America/Chicago",
      ["metrohealth.org"],
      true,
    ],
  ))!;

  const tz = program.timezone;

  // -------------------------------------------------------------------------
  // Services and rotations
  // -------------------------------------------------------------------------
  const serviceNames = [
    ["MICU", true],
    ["Floor", true],
    ["Night Float", true],
    ["Cardiology", true],
    ["Continuity Clinic", false],
  ] as const;
  const services = new Map<string, string>();
  for (const [name, tradeable] of serviceNames) {
    const row = (await queryOne<{ id: string }>(
      `INSERT INTO services (program_id, name, tradeable) VALUES ($1, $2, $3) RETURNING id`,
      [program.id, name, tradeable],
    ))!;
    services.set(name, row.id);
  }
  await query(
    `INSERT INTO services (program_id, name, tradeable) VALUES ($1, 'Emergency Department', true)`,
    [otherProgram.id],
  );

  const rotations = new Map<string, string>();
  for (const name of ["Wards", "Critical Care", "Ambulatory", "Nights"]) {
    const row = (await queryOne<{ id: string }>(
      `INSERT INTO rotations (program_id, name) VALUES ($1, $2) RETURNING id`,
      [program.id, name],
    ))!;
    rotations.set(name, row.id);
  }

  // -------------------------------------------------------------------------
  // Users and residents
  // -------------------------------------------------------------------------
  const FIRST_NAMES = [
    "Amara", "Devin", "Priya", "Marcus", "Elena", "Tomas", "Nadia", "Owen",
    "Leila", "Grant", "Sofia", "Hassan", "Iris", "Malik", "Rosa", "Ivan",
    "Chloe", "Andre", "Maya", "Felix", "Talia", "Jonah", "Bianca", "Yusuf",
    "Nora", "Emil", "Sana", "Cole", "Riya", "Aaron", "Hana", "Louis",
  ];
  const LAST_NAMES = [
    "Okafor", "Reyes", "Nair", "Delgado", "Petrova", "Vega", "Haddad", "Brennan",
    "Karim", "Whitfield", "Moreau", "Aziz", "Lindqvist", "Osei", "Guerrero", "Novak",
    "Fontaine", "Baptiste", "Sundaram", "Mercer", "Rosenfeld", "Adeyemi", "Costa", "Rahman",
    "Kowalski", "Bergman", "Iqbal", "Fitzgerald", "Menon", "Sokolov", "Yamada", "Chevalier",
  ];

  interface SeedResident {
    residentId: string;
    userId: string;
    name: string;
    email: string;
    pgy: number;
  }

  async function createUser(
    email: string,
    fullName: string,
    role: "resident" | "chief" | "admin",
    programId: string,
  ) {
    return (await queryOne<{ id: string }>(
      `INSERT INTO users (auth_user_id, email, full_name, role, program_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`seed-${email}`, email, fullName, role, programId],
    ))!;
  }

  async function createResident(
    userId: string,
    programId: string,
    pgy: number,
    credentials: string[] = ["BLS", "ACLS"],
  ) {
    return (await queryOne<{ id: string }>(
      `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, programId, pgy, 2026 + (5 - pgy), credentials],
    ))!;
  }

  const admin = await createUser(
    "admin@hospital.org",
    "Dana Whitfield",
    "admin",
    program.id,
  );
  const chiefUser = await createUser(
    "chief@hospital.org",
    "Jordan Blake",
    "chief",
    program.id,
  );
  const chiefResident = await createResident(chiefUser.id, program.id, 3);

  const residents: SeedResident[] = [];
  for (let index = 0; index < 32; index += 1) {
    const first = FIRST_NAMES[index % FIRST_NAMES.length];
    const last = LAST_NAMES[(index * 7) % LAST_NAMES.length];
    const name = `${first} ${last}`;
    const email = `resident${String(index + 1).padStart(2, "0")}@hospital.org`;
    const pgy = (index % 4) + 1;
    const user = await createUser(email, name, "resident", program.id);
    const credentials =
      pgy >= 2 ? ["BLS", "ACLS", "Critical Care"] : ["BLS", "ACLS"];
    const resident = await createResident(user.id, program.id, pgy, credentials);
    residents.push({
      residentId: resident.id,
      userId: user.id,
      name,
      email,
      pgy,
    });
  }

  // A user who has authenticated but has not been configured yet (spec §7).
  await query(
    `INSERT INTO users (auth_user_id, email, full_name, role, program_id)
     VALUES ('seed-unassigned', 'new.intern@hospital.org', 'Sam Rivera', NULL, NULL)`,
  );

  // A second program, used to prove cross-program isolation.
  const otherAdmin = await createUser(
    "admin@metrohealth.org",
    "Priya Raman",
    "admin",
    otherProgram.id,
  );
  const otherUser = await createUser(
    "resident01@metrohealth.org",
    "Chris Mbeki",
    "resident",
    otherProgram.id,
  );
  await createResident(otherUser.id, otherProgram.id, 2);
  void otherAdmin;

  // -------------------------------------------------------------------------
  // Program contacts
  // -------------------------------------------------------------------------
  await query(
    `INSERT INTO program_contacts (program_id, name, email, contact_type, notify_role)
     VALUES
       ($1, 'Rachel Whitmore', 'coordinator@hospital.org', 'program_coordinator', 'to'),
       ($1, 'Jordan Blake', 'chief@hospital.org', 'chief_resident', 'cc'),
       ($1, 'Dr. Alan Prescott', 'apd@hospital.org', 'associate_program_director', 'cc'),
       ($1, 'Dr. Miriam Foss', 'pd@hospital.org', 'program_director', 'none')`,
    [program.id],
  );
  await query(
    `INSERT INTO program_contacts (program_id, name, email, contact_type, notify_role)
     VALUES ($1, 'Metro Coordinator', 'coordinator@metrohealth.org', 'program_coordinator', 'to')`,
    [otherProgram.id],
  );

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------
  const rules: Array<[string, string, string, Record<string, unknown>, string?]> = [
    ["min_rest_hours", "Minimum rest between shifts", "ACGME-style rest requirement.", { hours: 10 }],
    ["max_consecutive_shifts", "Maximum consecutive days", "No more than six consecutive worked days.", { days: 6 }],
    ["max_consecutive_nights", "Maximum consecutive nights", "No more than four nights in a row.", { nights: 4 }],
    ["max_shifts_in_period", "Shift cap", "At most 24 shifts in any rolling 28 days.", { maxShifts: 24, windowDays: 28 }],
    ["no_overlapping_shifts", "No overlapping shifts", "A resident cannot hold two shifts at once.", {}],
    ["min_notice_hours", "Minimum notice", "Trades must be completed 24 hours before the shift.", { hours: 24 }],
    ["max_trades_per_month", "Monthly trade limit", "At most six completed trades per month.", { maxTrades: 6 }],
    ["max_open_pickups", "Pending offer limit", "At most five pending offers at once.", { maxOpenOffers: 5 }],
    ["pgy_requirement", "PGY requirements", "Shift PGY range plus a maximum two-level difference.", { maxPgyDifference: 2 }],
    [
      "approval_required",
      "Chief approval policy",
      "Chief approval when a shift starts within 48 hours.",
      { always: false, whenServiceDiffers: false, whenPgyDiffers: false, whenWithinHours: 48 },
    ],
    [
      "non_tradeable_service",
      "Non-tradeable services",
      "Continuity Clinic cannot be traded.",
      { serviceIds: [services.get("Continuity Clinic")] },
    ],
    [
      "holiday_restriction",
      "Holiday shifts",
      "Holiday shifts require chief approval.",
      {
        mode: "approval",
        dates: ["2026-11-26", "2026-12-25", "2027-01-01"],
      },
    ],
    [
      "blackout_dates",
      "Program blackout dates",
      "No trades during the program retreat.",
      { dates: ["2026-09-18", "2026-09-19"] },
    ],
    [
      "credential_requirement",
      "MICU credentials",
      "MICU coverage requires critical care credentialing.",
      { credentials: ["Critical Care"] },
    ],
  ];
  for (const [type, name, description, params] of rules) {
    const isServiceScoped = type === "credential_requirement";
    await query(
      `INSERT INTO rules (program_id, rule_type, name, description, params, scope, scope_id, overridable)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        program.id,
        type,
        name,
        description,
        JSON.stringify(params),
        isServiceScoped ? "service" : "program",
        isServiceScoped ? services.get("MICU") : null,
        type !== "no_overlapping_shifts",
      ],
    );
  }
  await query(
    `INSERT INTO rules (program_id, rule_type, name, description, params)
     VALUES ($1, 'min_rest_hours', 'Minimum rest', 'Emergency medicine rest rule.', '{"hours": 12}'::jsonb)`,
    [otherProgram.id],
  );

  // -------------------------------------------------------------------------
  // Shifts
  // -------------------------------------------------------------------------
  interface ShiftTemplate {
    service: string;
    rotation: string;
    startTime: string;
    endTime: string;
    overnight: boolean;
    type: string;
    location: string;
    pgyMin: number;
    pgyMax: number;
    weekdaysOnly?: boolean;
  }

  const templates: ShiftTemplate[] = [
    {
      service: "MICU",
      rotation: "Critical Care",
      startTime: "07:00",
      endTime: "19:00",
      overnight: false,
      type: "day",
      location: "ICU Tower 4",
      pgyMin: 2,
      pgyMax: 4,
    },
    {
      service: "MICU",
      rotation: "Critical Care",
      startTime: "19:00",
      endTime: "07:00",
      overnight: true,
      type: "night",
      location: "ICU Tower 4",
      pgyMin: 2,
      pgyMax: 4,
    },
    {
      service: "Floor",
      rotation: "Wards",
      startTime: "07:00",
      endTime: "19:00",
      overnight: false,
      type: "day",
      location: "Ward 6 East",
      pgyMin: 1,
      pgyMax: 3,
    },
    {
      service: "Night Float",
      rotation: "Nights",
      startTime: "19:00",
      endTime: "07:00",
      overnight: true,
      type: "night",
      location: "Ward 6 East",
      pgyMin: 1,
      pgyMax: 3,
    },
    {
      service: "Cardiology",
      rotation: "Wards",
      startTime: "08:00",
      endTime: "18:00",
      overnight: false,
      type: "day",
      location: "Heart Center",
      pgyMin: 2,
      pgyMax: 4,
    },
    {
      service: "Continuity Clinic",
      rotation: "Ambulatory",
      startTime: "08:00",
      endTime: "17:00",
      overnight: false,
      type: "clinic",
      location: "Riverside Clinic",
      pgyMin: 1,
      pgyMax: 4,
      weekdaysOnly: true,
    },
  ];

  const today = DateTime.now().setZone(tz).startOf("day");
  const firstDay = today.minus({ days: 21 });
  const lastDay = today.plus({ days: 60 });

  let rotationIndex = 0;
  const createdShifts: Array<{ id: string; residentId: string; date: string; service: string; type: string }> = [];

  for (let cursor = firstDay; cursor <= lastDay; cursor = cursor.plus({ days: 1 })) {
    const date = cursor.toISODate() as string;
    const isWeekend = cursor.weekday >= 6;
    for (const template of templates) {
      if (template.weekdaysOnly && isWeekend) continue;
      const start = zonedWallTimeToInstant(date, template.startTime, tz);
      const endDate = template.overnight
        ? (cursor.plus({ days: 1 }).toISODate() as string)
        : date;
      const end = zonedWallTimeToInstant(endDate, template.endTime, tz);

      // Round-robin assignment restricted to residents who satisfy the PGY range.
      let assigned: SeedResident | undefined;
      for (let attempt = 0; attempt < residents.length; attempt += 1) {
        const candidate = residents[(rotationIndex + attempt) % residents.length];
        if (candidate.pgy >= template.pgyMin && candidate.pgy <= template.pgyMax) {
          assigned = candidate;
          rotationIndex = (rotationIndex + attempt + 1) % residents.length;
          break;
        }
      }
      if (!assigned) continue;

      const tradeable = template.service !== "Continuity Clinic";
      const shift = (await queryOne<{ id: string }>(
        `INSERT INTO shifts
           (program_id, service_id, rotation_id, date, start_datetime, end_datetime,
            location, shift_type, required_pgy_min, required_pgy_max, tradeable, approval_required, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          program.id,
          services.get(template.service),
          rotations.get(template.rotation),
          date,
          start,
          end,
          template.location,
          template.type,
          template.pgyMin,
          template.pgyMax,
          tradeable,
          false,
          end.getTime() < Date.now() ? "completed" : "scheduled",
        ],
      ))!;
      await query(
        `INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)`,
        [shift.id, assigned.residentId],
      );
      createdShifts.push({
        id: shift.id,
        residentId: assigned.residentId,
        date,
        service: template.service,
        type: template.type,
      });
    }
  }

  // Daylight-saving demonstration shifts (America/New_York falls back on
  // 2026-11-01 and springs forward on 2027-03-14).
  for (const [date, startTime, endTime, nextDay] of [
    ["2026-10-31", "19:00", "07:00", true],
    ["2027-03-13", "19:00", "07:00", true],
  ] as const) {
    const start = zonedWallTimeToInstant(date, startTime, tz);
    const end = zonedWallTimeToInstant(
      nextDay
        ? (DateTime.fromISO(date).plus({ days: 1 }).toISODate() as string)
        : date,
      endTime,
      tz,
    );
    const assigned = residents[0];
    const shift = (await queryOne<{ id: string }>(
      `INSERT INTO shifts
         (program_id, service_id, rotation_id, date, start_datetime, end_datetime,
          location, shift_type, required_pgy_min, required_pgy_max, tradeable)
       VALUES ($1, $2, $3, $4, $5, $6, 'ICU Tower 4', 'night', 1, 4, true)
       RETURNING id`,
      [
        program.id,
        services.get("Night Float"),
        rotations.get("Nights"),
        date,
        start,
        end,
      ],
    ))!;
    await query(
      `INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)`,
      [shift.id, assigned.residentId],
    );
  }

  console.log(`[seed] created ${createdShifts.length} shifts`);

  // -------------------------------------------------------------------------
  // Trade fixtures, produced through the real services
  // -------------------------------------------------------------------------
  const programRow = program;

  function contextFor(seed: SeedResident): AuthedContext & { resident: { id: string } } {
    return {
      user: {
        id: seed.userId,
        email: seed.email,
        fullName: seed.name,
        pictureUrl: null,
        role: "resident",
        programId: programRow.id,
        active: true,
      },
      program: programRow,
      resident: { id: seed.residentId } as never,
      sessionId: "seed",
    };
  }

  const chiefContext: AuthedContext = {
    user: {
      id: chiefUser.id,
      email: "chief@hospital.org",
      fullName: "Jordan Blake",
      pictureUrl: null,
      role: "chief",
      programId: programRow.id,
      active: true,
    },
    program: programRow,
    resident: { id: chiefResident.id } as never,
    sessionId: "seed",
  };

  const upcoming = await query<ShiftDetail>(
    `SELECT s.*, sv.name AS service_name, NULL::text AS rotation_name,
            sa.resident_id, u.full_name AS resident_name, r.pgy_level AS resident_pgy,
            p.timezone AS program_timezone
       FROM shifts s
       JOIN services sv ON sv.id = s.service_id
       JOIN programs p ON p.id = s.program_id
       JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
       JOIN residents r ON r.id = sa.resident_id
       JOIN users u ON u.id = r.user_id
      WHERE s.program_id = $1
        AND s.status = 'scheduled'
        AND s.tradeable = true
        AND s.start_datetime > now() + interval '26 hours'
      ORDER BY s.start_datetime ASC`,
    [program.id],
  );

  const byResident = new Map<string, ShiftDetail[]>();
  for (const shift of upcoming) {
    if (!shift.resident_id) continue;
    const list = byResident.get(shift.resident_id) ?? [];
    list.push(shift);
    byResident.set(shift.resident_id, list);
  }

  function residentSeed(residentId: string): SeedResident | undefined {
    return residents.find((r) => r.residentId === residentId);
  }

  // A pair of shifts is only usable as a fixture if the real validation engine
  // approves the swap, so candidates are checked before anything is written.
  const { buildTradeContextByShiftIds } = await import("@/server/domain/trade-context");
  const { validateTrade } = await import("@/server/domain/validation");

  interface Pair {
    poster: SeedResident;
    posterShift: ShiftDetail;
    offerer: SeedResident;
    offererShift: ShiftDetail;
    requiresApproval: boolean;
  }

  async function findPair(
    exclude: Set<string>,
    options: { wantApproval?: boolean; posterShiftFilter?: (shift: ShiftDetail) => boolean } = {},
  ): Promise<Pair | null> {
    const residentIds = [...byResident.keys()].filter((id) => !exclude.has(id));
    for (const posterId of residentIds) {
      const poster = residentSeed(posterId);
      if (!poster) continue;
      const posterShifts = (byResident.get(posterId) ?? []).filter(
        (shift) => options.posterShiftFilter?.(shift) ?? true,
      );
      for (const posterShift of posterShifts.slice(0, 4)) {
        for (const offererId of residentIds) {
          if (offererId === posterId) continue;
          const offerer = residentSeed(offererId);
          if (!offerer) continue;
          for (const offererShift of (byResident.get(offererId) ?? []).slice(0, 4)) {
            if (offererShift.id === posterShift.id) continue;
            const context = await buildTradeContextByShiftIds(
              program,
              posterShift.id,
              offererShift.id,
            );
            const result = validateTrade(context);
            if (!result.valid) continue;
            if (options.wantApproval !== undefined && result.requiresApproval !== options.wantApproval) {
              continue;
            }
            return {
              poster,
              posterShift,
              offerer,
              offererShift,
              requiresApproval: result.requiresApproval,
            };
          }
        }
      }
    }
    return null;
  }

  const used = new Set<string>();

  // 1. Three open posts with no offers yet.
  let openPosts = 0;
  for (const [residentId, shifts] of byResident) {
    if (openPosts >= 3) break;
    if (used.has(residentId)) continue;
    const seed = residentSeed(residentId);
    if (!seed || shifts.length < 2) continue;
    used.add(residentId);
    await postShiftForTrade(contextFor(seed), {
      shiftId: shifts[0].id,
      notes:
        openPosts === 0
          ? "Family event that weekend — happy to take any night in return."
          : "Conference travel. Prefer a swap on the same service.",
      preferences: {
        preferredShiftTypes: openPosts === 0 ? ["night"] : [],
        preferredDates: [],
      },
    });
    openPosts += 1;
  }
  console.log(`[seed] created ${openPosts} open trade posts`);

  // 2. A post that already has a pending offer waiting for a decision.
  const pendingPair = await findPair(used, { wantApproval: false });
  if (pendingPair) {
    used.add(pendingPair.poster.residentId);
    used.add(pendingPair.offerer.residentId);
    const request = await postShiftForTrade(contextFor(pendingPair.poster), {
      shiftId: pendingPair.posterShift.id,
      notes: "Wedding — anything in the following week works.",
    });
    await createOffer(contextFor(pendingPair.offerer), {
      tradeRequestId: request.id,
      offeredShiftId: pendingPair.offererShift.id,
    });
    console.log("[seed] created a trade post with a pending offer");
  } else {
    console.warn("[seed] no valid pair found for the pending-offer fixture");
  }

  // 3. A completed switch plus its generated program-notification email.
  const completedPair = await findPair(used, { wantApproval: false });
  if (completedPair) {
    used.add(completedPair.poster.residentId);
    used.add(completedPair.offerer.residentId);
    const request = await postShiftForTrade(contextFor(completedPair.poster), {
      shiftId: completedPair.posterShift.id,
      notes: "Swapping so I can travel for a family visit.",
    });
    const { offer } = await createOffer(contextFor(completedPair.offerer), {
      tradeRequestId: request.id,
      offeredShiftId: completedPair.offererShift.id,
    });
    const outcome = await acceptOffer(contextFor(completedPair.poster), offer.id);
    if (outcome.status === "completed") {
      await generateSwitchEmail(contextFor(completedPair.poster), outcome.completedTradeId);
      console.log("[seed] completed a switch and generated its program email");
    }
  } else {
    console.warn("[seed] no valid pair found for the completed-trade fixture");
  }

  // 4. A switch waiting for chief approval. The shift is flagged as requiring
  //    approval first, which is exactly how a program marks a sensitive shift.
  const approvalPair = await findPair(used, { wantApproval: false });
  if (approvalPair) {
    used.add(approvalPair.poster.residentId);
    used.add(approvalPair.offerer.residentId);
    await query("UPDATE shifts SET approval_required = true WHERE id = $1", [
      approvalPair.posterShift.id,
    ]);
    const request = await postShiftForTrade(contextFor(approvalPair.poster), {
      shiftId: approvalPair.posterShift.id,
      notes: "Sudden conflict — need coverage.",
    });
    const { offer } = await createOffer(contextFor(approvalPair.offerer), {
      tradeRequestId: request.id,
      offeredShiftId: approvalPair.offererShift.id,
    });
    const outcome = await acceptOffer(contextFor(approvalPair.poster), offer.id);
    console.log(`[seed] approval fixture: ${outcome.status}`);
  } else {
    console.warn("[seed] no valid pair found for the pending-approval fixture");
  }

  void approveTrade;
  void chiefContext;

  // 5. A failed trade attempt, recorded for the analytics screen.
  await recordAudit({
    programId: program.id,
    actorUserId: residents[5].userId,
    actorLabel: residents[5].email,
    action: "offer.invalidated",
    entityType: "trade_offer",
    reason: "Resident would have insufficient rest before this shift.",
  });

  await notify({
    recipientUserId: admin.id,
    type: "shift.changed",
    title: "Welcome to ShiftSwitch",
    body: "Seed data has been loaded. Use the admin area to review users, rules and audit history.",
  });

  const counts = await queryOne<{
    users: string;
    shifts: string;
    requests: string;
    offers: string;
    completed: string;
  }>(`
    SELECT (SELECT count(*) FROM users)::text AS users,
           (SELECT count(*) FROM shifts)::text AS shifts,
           (SELECT count(*) FROM trade_requests)::text AS requests,
           (SELECT count(*) FROM trade_offers)::text AS offers,
           (SELECT count(*) FROM completed_trades)::text AS completed
  `);
  console.log("[seed] done", counts);
  await withTransaction(async () => undefined);
  await closePool();
}

main().catch((error) => {
  console.error("[seed] failed:", error);
  process.exit(1);
});
