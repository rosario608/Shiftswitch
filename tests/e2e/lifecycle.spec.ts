import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn, signOut } from "./helpers";

/**
 * The whole product, once, through the browser and the real API.
 *
 * The other suites each prove one thing well. This one proves the parts join
 * up: an administrator sets a program up and a resident uses it, in that order,
 * with nothing reset in between. It is the test that would have caught a
 * feature that works in isolation and is unreachable in sequence.
 *
 * Failure paths are checked alongside the success ones at each step, because
 * "the happy path works" is not the same claim as "the thing is usable".
 */
test.describe.configure({ mode: "serial" });

const FUTURE = (() => {
  // Far enough out that nothing in the fixture collides, and stable across the
  // run: computed once.
  const base = new Date(Date.now() + 60 * 86_400_000);
  const day = (offset: number) =>
    new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  return { day };
})();

const NEW_RESIDENT = "e2e.lifecycle.newcomer@hospital.org";

let inviteUrl = "";
let importedShiftId = "";

test.beforeAll(() => {
  resetFixture();
});

test("an administrator can see the program they administer", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);

  const session = await (await page.request.get("/api/session")).json();
  expect(session.authenticated).toBe(true);
  expect(session.user.role).toBe("admin");

  const users = await (await page.request.get("/api/admin/users")).json();
  expect(users.users.length).toBeGreaterThan(0);

  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /invitations/i })).toBeVisible();
});

test("the administrator invites somebody and the link is usable exactly once", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);

  const created = await page.request.post("/api/admin/invitations", {
    data: { emails: [NEW_RESIDENT], role: "resident", pgyLevel: 1 },
  });
  expect(created.status()).toBe(201);
  const body = await created.json();
  expect(body.created).toHaveLength(1);
  expect(body.failed).toHaveLength(0);
  inviteUrl = body.created[0].url as string;

  // It shows up as pending, and inviting the same address again supersedes
  // rather than duplicating.
  const again = await page.request.post("/api/admin/invitations", {
    data: { emails: [NEW_RESIDENT], role: "resident", pgyLevel: 1 },
  });
  expect(again.status()).toBe(201);
  const secondUrl = (await again.json()).created[0].url as string;

  const list = await (await page.request.get("/api/admin/invitations")).json();
  const live = (list.invitations as Array<{ email: string; status: string }>).filter(
    (invitation) => invitation.email === NEW_RESIDENT && invitation.status === "pending",
  );
  expect(live).toHaveLength(1);

  // The superseded link is dead; the current one works.
  await signOut(page);
  await page.goto(inviteUrl);
  await expect(page.getByText(/may have expired, been cancelled/i)).toBeVisible();

  await page.goto(secondUrl);
  await expect(page.getByRole("link", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByText(NEW_RESIDENT).first()).toBeVisible();
  inviteUrl = secondUrl;

  // Inviting an existing member is refused with an explanation.
  await signIn(page, ACCOUNTS.admin);
  const duplicate = await page.request.post("/api/admin/invitations", {
    data: { emails: [ACCOUNTS.alice], role: "resident" },
  });
  const duplicateBody = await duplicate.json();
  expect(duplicateBody.created).toHaveLength(0);
  expect(duplicateBody.failed[0].reason).toMatch(/already a member/i);
});

test("the administrator imports a block, reviews it, and can back out", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);

  const template = await page.request.get("/api/admin/import/template");
  expect(template.ok()).toBe(true);
  expect(template.headers()["content-type"]).toContain("text/csv");
  const templateText = await template.text();
  expect(templateText.split("\r\n")[0]).toContain("Email");

  const csv = [
    "Email,Date,Start time,End time,Ends next day,Service,Shift type,Location",
    `${ACCOUNTS.alice},${FUTURE.day(0)},07:00,19:00,no,MICU,day,ICU Tower 4`,
    `${ACCOUNTS.bob},${FUTURE.day(1)},19:00,07:00,yes,Night Float,night,Ward 6 East`,
  ].join("\n");

  const preview = await page.request.post("/api/admin/import", {
    multipart: {
      file: { name: "block.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
    },
  });
  expect(preview.ok()).toBe(true);
  const { preview: previewBody } = await preview.json();
  expect(previewBody.issues).toHaveLength(0);
  expect(previewBody.summary.totalRows).toBe(2);
  expect(previewBody.rows).toHaveLength(2);

  // Previewing wrote nothing: backing out at this point is free.
  const beforeCommit = await (
    await page.request.get(
      `/api/admin/shifts?from=${FUTURE.day(0)}&to=${FUTURE.day(2)}`,
    )
  ).json();
  expect(beforeCommit.shifts).toHaveLength(0);

  const committed = await page.request.post("/api/admin/import", {
    data: { rows: previewBody.rows },
  });
  expect(committed.ok()).toBe(true);
  expect((await committed.json()).result.createdShifts).toBe(2);

  const after = await (
    await page.request.get(
      `/api/admin/shifts?from=${FUTURE.day(0)}&to=${FUTURE.day(2)}`,
    )
  ).json();
  expect(after.shifts).toHaveLength(2);
  const alicesShift = after.shifts.find((shift: { resident_name: string | null }) =>
    shift.resident_name?.includes("Alice"),
  );
  expect(alicesShift, "Alice's imported shift should be listed").toBeDefined();
  importedShiftId = alicesShift.id;

  // The overnight row is one shift, not two.
  const overnight = after.shifts.find(
    (shift: { shift_type: string }) => shift.shift_type === "night",
  );
  expect(overnight).toBeDefined();
  const hours =
    (new Date(overnight.end_datetime).getTime() -
      new Date(overnight.start_datetime).getTime()) /
    3_600_000;
  expect(hours).toBe(12);
});

test("re-importing the same block changes nothing", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const csv = [
    "Email,Date,Start time,End time,Ends next day,Service,Shift type,Location",
    `${ACCOUNTS.alice},${FUTURE.day(0)},07:00,19:00,no,MICU,day,ICU Tower 4`,
  ].join("\n");

  const preview = await page.request.post("/api/admin/import", {
    multipart: {
      file: { name: "again.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
    },
  });
  const { preview: body } = await preview.json();
  const committed = await page.request.post("/api/admin/import", {
    data: { rows: body.rows },
  });
  const result = (await committed.json()).result;
  expect(result.createdShifts).toBe(0);
  expect(result.skippedExisting).toBe(1);

  const after = await (
    await page.request.get(
      `/api/admin/shifts?from=${FUTURE.day(0)}&to=${FUTURE.day(2)}`,
    )
  ).json();
  expect(after.shifts).toHaveLength(2);
});

test("a malformed file is refused with a reason and writes nothing", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);

  // Not a spreadsheet at all.
  const notASpreadsheet = await page.request.post("/api/admin/import", {
    multipart: {
      file: {
        name: "schedule.xlsx",
        mimeType: "application/vnd.ms-excel",
        buffer: Buffer.from("%PDF-1.7\nnot really a workbook"),
      },
    },
  });
  expect(notASpreadsheet.status()).toBe(422);
  expect((await notASpreadsheet.json()).error.message).toMatch(/could not be read/i);

  // Right format, wrong columns.
  const wrongColumns = await page.request.post("/api/admin/import", {
    multipart: {
      file: {
        name: "wrong.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("Person,When,Where\nAlice,Tuesday,ICU"),
      },
    },
  });
  expect(wrongColumns.ok()).toBe(true);
  const { preview } = await wrongColumns.json();
  expect(preview.issues.length).toBeGreaterThan(0);
  expect(preview.rows).toHaveLength(0);

  // A row naming somebody who is not in the program.
  const unknown = await page.request.post("/api/admin/import", {
    data: {
      rows: [
        {
          residentEmail: "ghost@hospital.org",
          date: FUTURE.day(3),
          startTime: "07:00",
          endTime: "19:00",
          service: "MICU",
        },
      ],
    },
  });
  expect(unknown.status()).toBe(422);
  expect((await unknown.json()).error.message).toMatch(/not in your program/i);

  const after = await (
    await page.request.get(
      `/api/admin/shifts?from=${FUTURE.day(3)}&to=${FUTURE.day(4)}`,
    )
  ).json();
  expect(after.shifts).toHaveLength(0);
});

test("the administrator edits, reassigns and deletes an imported shift", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);

  // Move it an hour earlier and change where it is.
  const moved = await page.request.patch(`/api/admin/shifts/${importedShiftId}`, {
    data: { startTime: "06:00", endTime: "18:00", location: "ICU Tower 5" },
  });
  expect(moved.ok()).toBe(true);
  expect((await moved.json()).shift.location).toBe("ICU Tower 5");

  // Hand it to somebody else.
  const users = await (await page.request.get("/api/admin/users")).json();
  const carol = users.users.find(
    (user: { email: string }) => user.email === ACCOUNTS.carol,
  );
  expect(carol?.resident_id, "Carol should have a resident record").toBeTruthy();
  const reassigned = await page.request.patch(`/api/admin/shifts/${importedShiftId}`, {
    data: { residentId: carol.resident_id },
  });
  expect(reassigned.ok()).toBe(true);

  const listed = await (
    await page.request.get(
      `/api/admin/shifts?from=${FUTURE.day(0)}&to=${FUTURE.day(2)}`,
    )
  ).json();
  const shift = listed.shifts.find((s: { id: string }) => s.id === importedShiftId);
  expect(shift.resident_name).toContain("Carol");

  // An impossible edit is refused rather than half-applied.
  const impossible = await page.request.patch(`/api/admin/shifts/${importedShiftId}`, {
    data: { startTime: "19:00", endTime: "07:00", endsNextDay: false },
  });
  expect(impossible.status()).toBe(422);

  // Creating one by hand, then removing it again.
  const serviceId = listed.shifts[0].service_id;
  const created = await page.request.post("/api/admin/shifts", {
    data: {
      serviceId,
      date: FUTURE.day(5),
      startTime: "07:00",
      endTime: "19:00",
      endsNextDay: false,
      location: "Ward 2",
      shiftType: "day",
      requiredPgyMin: 1,
      requiredPgyMax: 10,
      tradeable: true,
      approvalRequired: false,
      residentId: carol.resident_id,
    },
  });
  expect(created.status()).toBe(201);
  const createdId = (await created.json()).shift.id;

  const deleted = await page.request.delete(`/api/admin/shifts/${createdId}`);
  expect(deleted.ok()).toBe(true);
  const gone = await page.request.delete(`/api/admin/shifts/${createdId}`);
  expect(gone.status()).toBe(404);
});

test("a resident works their own schedule end to end", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);

  const schedule = await (await page.request.get("/api/schedule")).json();
  expect(schedule.shifts.length).toBeGreaterThan(0);
  const mine = schedule.shifts[0];

  // Post it.
  const posted = await page.request.post("/api/switches", { data: { shiftId: mine.id } });
  expect(posted.ok()).toBe(true);
  const tradeId = (await posted.json()).tradeRequest.id;

  // A colleague sees it on the board, is offered ranked candidates, and offers.
  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  const board = await (await page.request.get("/api/switches")).json();
  expect((board.trades as Array<{ id: string }>).some((t) => t.id === tradeId)).toBe(
    true,
  );

  const candidates = await (
    await page.request.get(`/api/switches/${tradeId}/candidates`)
  ).json();
  expect(candidates.candidates.length).toBeGreaterThan(0);
  const eligible = candidates.candidates.find(
    (candidate: { eligible: boolean }) => candidate.eligible,
  );
  expect(eligible, "at least one candidate should be offerable").toBeDefined();

  const offered = await page.request.post(`/api/switches/${tradeId}/offers`, {
    data: { offeredShiftId: eligible.shift.id },
  });
  expect(offered.ok()).toBe(true);
  const offerId = (await offered.json()).offer.id;

  // Only the person who posted can accept.
  await signOut(page);
  await signIn(page, ACCOUNTS.carol);
  expect((await page.request.post(`/api/offers/${offerId}/accept`)).status()).toBe(403);

  await signOut(page);
  await signIn(page, ACCOUNTS.alice);

  const notifications = await (await page.request.get("/api/notifications")).json();
  expect(
    (notifications.notifications as Array<{ type: string }>).some((n) =>
      n.type.startsWith("offer"),
    ),
  ).toBe(true);

  const accepted = await page.request.post(`/api/offers/${offerId}/accept`);
  expect(accepted.ok()).toBe(true);
  const outcome = await accepted.json();
  expect(["completed", "pending_approval"]).toContain(outcome.status);

  if (outcome.status === "completed") {
    // Both schedules moved.
    const after = await (await page.request.get("/api/schedule?includePast=true")).json();
    expect(
      (after.shifts as Array<{ id: string }>).some((s) => s.id === eligible.shift.id),
    ).toBe(true);
    expect((after.shifts as Array<{ id: string }>).some((s) => s.id === mine.id)).toBe(
      false,
    );
  }

  // The same offer cannot be accepted twice.
  expect([404, 409]).toContain((await page.request.post(`/api/offers/${offerId}/accept`)).status());
});

test("the invited resident is still pending, and nothing leaked to them", async ({
  page,
}) => {
  // Acceptance itself needs a real Google account, which no test can supply —
  // `acceptInvitation` is covered directly in the integration suite. What is
  // checked here is that an unaccepted invitation grants nothing at all.
  await page.goto(inviteUrl);
  await expect(page.getByRole("link", { name: /continue with google/i })).toBeVisible();

  // The page reveals the program and the invited address, and no schedule.
  await expect(page.getByText(/e2e internal medicine/i)).toBeVisible();
  const schedule = await page.request.get("/api/schedule");
  expect(schedule.status()).toBe(401);

  await signIn(page, ACCOUNTS.admin);
  const list = await (await page.request.get("/api/admin/invitations")).json();
  const invitation = (list.invitations as Array<{ email: string; status: string }>).find(
    (entry) => entry.email === NEW_RESIDENT,
  );
  expect(invitation!.status).toBe("pending");
});
