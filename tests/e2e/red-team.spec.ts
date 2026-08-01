import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn, signInApi, signOut } from "./helpers";

/**
 * Attacking the API the way somebody would who has a valid account and wants
 * more than it grants.
 *
 * `security.spec.ts` checks that the guards are wired up. This checks the
 * things a guard alone does not cover: identifiers belonging to another
 * program, payload fields the UI never sends, sessions that should have stopped
 * working, and the difference between "refused" and "refused without telling
 * you anything".
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetFixture();
});

test("deactivating an account kills the session it is already holding", async ({
  browser,
}) => {
  /* Two independent browser contexts: one is the resident, already signed in;
     the other is the administrator who switches them off. The point is that the
     resident's *existing* session stops working immediately — authorization is
     read from the database on every request, not baked into the cookie at
     sign-in. */
  const resident = await browser.newContext();
  const admin = await browser.newContext();
  try {
    const residentPage = await resident.newPage();
    const adminPage = await admin.newPage();
    await signIn(residentPage, ACCOUNTS.alice);
    await signIn(adminPage, ACCOUNTS.admin);

    expect((await residentPage.request.get("/api/schedule")).ok()).toBe(true);

    const session = await (await adminPage.request.get("/api/session")).json();
    const users = await (await adminPage.request.get("/api/admin/users")).json();
    const alice = users.users.find((u: { email: string }) => u.email === ACCOUNTS.alice);

    const deactivated = await adminPage.request.patch(`/api/admin/users/${alice.id}`, {
      data: { active: false, role: "resident", programId: session.program.id },
    });
    expect(deactivated.ok()).toBe(true);

    /* Same cookie, same session row — and now refused. It is 401 rather than
       403 because the session query itself declines to resolve a deactivated
       account, so the request looks unauthenticated rather than unauthorised.
       Either is a denial; what matters is that an existing session stops
       working immediately, without waiting for it to expire. */
    const after = await residentPage.request.get("/api/schedule");
    expect(after.status()).toBe(401);

    // And signing in again is refused with the reason, so the person is not
    // left in a loop wondering why they were logged out.

    expect(
      (
        await residentPage.request.post("/api/auth/test-login", {
          data: { email: ACCOUNTS.alice },
        })
      ).status(),
    ).toBe(403);

    /* Restore. The old session is gone for good — deactivating deletes every
       session the user held, so reactivating does not silently hand back a
       cookie that was live during the period they were switched off. They sign
       in again, which is the correct outcome. */
    await adminPage.request.patch(`/api/admin/users/${alice.id}`, {
      data: { active: true, role: "resident", programId: session.program.id },
    });
    expect((await residentPage.request.get("/api/schedule")).status()).toBe(401);

    await signIn(residentPage, ACCOUNTS.alice);
    expect((await residentPage.request.get("/api/schedule")).ok()).toBe(true);
  } finally {
    await resident.close();
    await admin.close();
  }
});

test("an account deactivated from the start cannot sign in at all", async ({ page }) => {
  const attempt = await page.request.post("/api/auth/test-login", {
    data: { email: ACCOUNTS.deactivated },
  });
  expect(attempt.status()).toBe(403);
  expect((await attempt.json()).error.message).toMatch(/deactivated/i);
});

test("another program's administrator cannot reach this program's data", async ({
  page,
}) => {
  // Collect real identifiers from inside the program first.
  await signIn(page, ACCOUNTS.admin);
  const mine = {
    session: await (await page.request.get("/api/session")).json(),
    users: (await (await page.request.get("/api/admin/users")).json()).users,
    shifts: (await (await page.request.get("/api/admin/shifts")).json()).shifts,
    services: (await (await page.request.get("/api/admin/services")).json()).services,
  };
  const myUser = mine.users.find((u: { email: string }) => u.email === ACCOUNTS.bob);
  const myShift = mine.shifts[0];
  const myService = mine.services[0];
  expect(myUser && myShift && myService).toBeTruthy();

  // Now attack with a valid administrator session from the other program.
  await signOut(page);
  await signIn(page, ACCOUNTS.otherAdmin);

  // Reading: their own program only.
  const theirUsers = (await (await page.request.get("/api/admin/users")).json()).users;
  expect(
    theirUsers.some((u: { email: string }) => u.email === ACCOUNTS.bob),
    "another program's users must not be listed",
  ).toBe(false);

  const theirShifts = (await (await page.request.get("/api/admin/shifts")).json()).shifts;
  expect(theirShifts.some((s: { id: string }) => s.id === myShift.id)).toBe(false);

  const theirServices = (await (await page.request.get("/api/admin/services")).json())
    .services;
  expect(theirServices.some((s: { id: string }) => s.id === myService.id)).toBe(false);

  // Writing, by guessing an identifier: refused every time.
  expect(
    (
      await page.request.patch(`/api/admin/users/${myUser.id}`, {
        data: { role: "admin", programId: mine.session.program.id },
      })
    ).status(),
  ).toBe(403);

  expect(
    (
      await page.request.patch(`/api/admin/shifts/${myShift.id}`, {
        data: { location: "Taken over" },
      })
    ).status(),
  ).toBe(403);

  expect((await page.request.delete(`/api/admin/shifts/${myShift.id}`)).status()).toBe(
    403,
  );

  // A service in another program is "not found" rather than "forbidden", so the
  // identifier cannot be used to confirm the row exists somewhere.
  expect(
    (
      await page.request.patch(`/api/admin/services/${myService.id}`, {
        data: { kind: "service", name: "Renamed by an outsider" },
      })
    ).status(),
  ).toBe(404);

  // Reading one shift by id.
  expect((await page.request.get(`/api/shifts/${myShift.id}`)).status()).toBe(403);

  // And nothing actually changed.
  await signOut(page);
  await signIn(page, ACCOUNTS.admin);
  const after = (await (await page.request.get("/api/admin/shifts")).json()).shifts;
  const untouched = after.find((s: { id: string }) => s.id === myShift.id);
  expect(untouched.location).toBe(myShift.location);
});

test("a payload cannot move a user into another program", async ({ page }) => {
  await signIn(page, ACCOUNTS.otherAdmin);
  const theirSession = await (await page.request.get("/api/session")).json();

  await signOut(page);
  await signIn(page, ACCOUNTS.admin);
  const users = await (await page.request.get("/api/admin/users")).json();
  const bob = users.users.find((u: { email: string }) => u.email === ACCOUNTS.bob);

  // The UI never sends a foreign programId; the server refuses it anyway.
  const attempt = await page.request.patch(`/api/admin/users/${bob.id}`, {
    data: { role: "resident", programId: theirSession.program.id },
  });
  expect(attempt.status()).toBe(403);

  const after = await (await page.request.get("/api/admin/users")).json();
  expect(
    after.users.some((u: { email: string }) => u.email === ACCOUNTS.bob),
    "Bob must still belong to this program",
  ).toBe(true);
});

test("a resident cannot escalate by editing their own record", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);
  const session = await (await page.request.get("/api/session")).json();

  // The obvious attempt: patch yourself to administrator.
  expect(
    (
      await page.request.patch(`/api/admin/users/${session.user.id}`, {
        data: { role: "admin", programId: session.program.id },
      })
    ).status(),
  ).toBe(403);

  // And the account is unchanged.
  const after = await (await page.request.get("/api/session")).json();
  expect(after.user.role).toBe("resident");
});

test("an unconfigured account is refused everywhere, not just on the home page", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.pending);
  for (const path of [
    "/api/schedule",
    "/api/trades",
    "/api/admin/users",
    "/api/admin/services",
    "/api/approvals",
  ]) {
    const response = await page.request.get(path);
    expect([403], path).toContain(response.status());
  }
});

test("identifiers from another program leak nothing through error messages", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.otherAdmin);

  // A well-formed id that exists in a different program, and one that exists
  // nowhere, must be indistinguishable.
  await signOut(page);
  await signIn(page, ACCOUNTS.admin);
  const services = (await (await page.request.get("/api/admin/services")).json()).services;
  const realElsewhere = services[0].id;

  await signOut(page);
  await signIn(page, ACCOUNTS.otherAdmin);

  const existing = await page.request.patch(`/api/admin/services/${realElsewhere}`, {
    data: { kind: "service", name: "Probe" },
  });
  /* A well-formed v4 UUID that exists nowhere. Deliberately not the nil UUID:
     that fails the id-shape check and produces the generic "we couldn't find
     that" before any lookup happens, which tells an attacker only that they
     typed a malformed id — something they already knew. The property worth
     asserting is that a *well-formed* id which exists in another program is
     indistinguishable from one that exists nowhere at all. */
  const invented = await page.request.patch(
    "/api/admin/services/3f2a91c4-5d7e-4b1a-9c83-2e6f04d7ab19",
    { data: { kind: "service", name: "Probe" } },
  );
  const existingBody = await existing.json();
  const inventedBody = await invented.json();

  /* Every response carries a request id so a resident can read it out and an
     operator can find the log line. It is per *request*, so two responses
     necessarily differ by it — and that difference says nothing about either
     resource. Asserted separately rather than ignored: an id that were somehow
     derived from the resource would be a leak, and this pins that it is not. */
  expect(existingBody.error.requestId, "a refusal must still carry a reference").toMatch(
    /^[a-z0-9]{6}$/,
  );
  expect(inventedBody.error.requestId).toMatch(/^[a-z0-9]{6}$/);
  expect(
    existingBody.error.requestId,
    "the reference must be per request, not per resource",
  ).not.toBe(inventedBody.error.requestId);

  const withoutReference = (body: { error: Record<string, unknown> }) => {
    const { requestId: _ignored, ...rest } = body.error;
    return rest;
  };
  expect(
    { status: existing.status(), body: withoutReference(existingBody) },
    "an id that exists elsewhere must be indistinguishable from one that exists nowhere",
  ).toEqual({ status: invented.status(), body: withoutReference(inventedBody) });
});

test("a bearer token from the native client carries the same limits", async ({
  request,
}) => {
  // The native path is a second front door; it must not be a weaker one.
  await signInApi(request, ACCOUNTS.bob);
  const login = await request.post("/api/auth/test-login", {
    data: { email: ACCOUNTS.bob, native: true },
  });
  const { token } = await login.json();
  expect(token).toBeTruthy();

  const headers = { authorization: `Bearer ${token}` };
  expect((await request.get("/api/schedule", { headers })).ok()).toBe(true);
  expect((await request.get("/api/admin/users", { headers })).status()).toBe(403);
  expect((await request.get("/api/admin/services", { headers })).status()).toBe(403);
  expect(
    (await request.post("/api/admin/maintenance", { headers })).status(),
  ).toBe(403);

  // A tampered token is not a token.
  const tampered = { authorization: `Bearer ${String(token).slice(0, -3)}xyz` };
  expect((await request.get("/api/schedule", { headers: tampered })).status()).toBe(401);
});

test("the invitation sandbox cannot be pointed at somebody else's invitation", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);
  const created = await page.request.post("/api/admin/invitations", {
    data: { emails: ["e2e.redteam.invitee@hospital.org"], role: "resident" },
  });
  const { url } = (await created.json()).created[0];
  const token = url.split("/invite/")[1];

  // The sandbox derives the identity from the invitation, so there is no field
  // to point it anywhere: supplying an email is simply ignored.
  const accepted = await page.request.post("/api/dev/accept-invitation", {
    data: { token, fullName: "Red Team", email: "attacker@hospital.org" },
  });
  expect(accepted.ok()).toBe(true);
  expect((await accepted.json()).user.email).toBe("e2e.redteam.invitee@hospital.org");

  // …and it becomes a resident of the inviting program, not of anywhere else.
  const session = await (await page.request.get("/api/session")).json();
  expect(session.user.role).toBe("resident");
  expect(session.user.email).toBe("e2e.redteam.invitee@hospital.org");
});
