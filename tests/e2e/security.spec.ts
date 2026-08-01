import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn, signOut } from "./helpers";

/**
 * Authorization is enforced on the server. These tests bypass the UI entirely
 * and call the API the way an attacker would — with a valid session for one
 * resident and identifiers belonging to somebody else.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetFixture();
});

test("unauthenticated requests are rejected and pages redirect to sign-in", async ({
  page,
}) => {
  for (const path of [
    "/api/schedule",
    "/api/switches",
    "/api/notifications",
    "/api/admin/users",
    "/api/admin/analytics",
  ]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthenticated");
  }

  await page.goto("/schedule");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("link", { name: /continue with google/i })).toBeVisible();
});

test("a resident cannot read another resident's schedule by changing the id", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.bob);
  const own = await page.request.get("/api/schedule");
  expect(own.ok()).toBe(true);
  const bobShifts = (await own.json()).shifts as Array<{ id: string }>;
  expect(bobShifts.length).toBeGreaterThan(0);

  // Alice's resident id, obtained the only way Bob legitimately could: not at
  // all. We use the session endpoint after signing in as Alice, then attack.
  await signOut(page);
  await signIn(page, ACCOUNTS.alice);
  const aliceSession = await (await page.request.get("/api/session")).json();
  const aliceResidentId = aliceSession.residentId as string;
  const aliceShifts = (await (await page.request.get("/api/schedule")).json())
    .shifts as Array<{ id: string }>;

  await signOut(page);
  await signIn(page, ACCOUNTS.bob);

  const attempt = await page.request.get(`/api/schedule?residentId=${aliceResidentId}`);
  expect(attempt.status()).toBe(403);
  expect((await attempt.json()).error.code).toBe("forbidden");

  // A single shift belonging to Alice is also not readable while it is private.
  const shiftAttempt = await page.request.get(`/api/shifts/${aliceShifts[0].id}`);
  expect(shiftAttempt.status()).toBe(403);
});

test("a resident cannot reach administrator or chief endpoints", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);
  for (const path of [
    "/api/admin/users",
    "/api/admin/rules",
    "/api/admin/audit",
    "/api/admin/analytics",
    "/api/admin/shifts",
    "/api/approvals",
  ]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(403);
  }

  const post = await page.request.post("/api/admin/maintenance");
  expect(post.status()).toBe(403);

  const contact = await page.request.post("/api/admin/contacts", {
    data: {
      name: "Sneaky",
      email: "sneaky@hospital.org",
      contactType: "other",
      notifyRole: "to",
      active: true,
    },
  });
  expect(contact.status()).toBe(403);

  // The admin UI is not reachable by URL either.
  await page.goto("/admin/users");
  await expect(page).not.toHaveURL(/\/admin\/users/);
});

test("a resident cannot import a schedule or invite anybody", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);

  // Reading the template would leak the program's timezone and column layout.
  expect((await page.request.get("/api/admin/import/template")).status()).toBe(403);
  expect((await page.request.get("/api/admin/invitations")).status()).toBe(403);

  // Previewing a file is a write-adjacent operation: it reads every resident in
  // the program to match email addresses.
  const preview = await page.request.post("/api/admin/import", {
    multipart: {
      file: {
        name: "schedule.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "Email,Date,Start time,End time,Service\ne2e.bob@hospital.org,2030-01-01,07:00,19:00,MICU\n",
        ),
      },
    },
  });
  expect(preview.status()).toBe(403);

  // Committing rows directly, skipping the preview.
  const commit = await page.request.post("/api/admin/import", {
    data: {
      rows: [
        {
          residentEmail: ACCOUNTS.bob,
          date: "2030-01-01",
          startTime: "07:00",
          endTime: "19:00",
          service: "MICU",
        },
      ],
    },
  });
  expect(commit.status()).toBe(403);

  const invite = await page.request.post("/api/admin/invitations", {
    data: { emails: ["intruder@hospital.org"], role: "admin" },
  });
  expect(invite.status()).toBe(403);

  // Acting on an invitation by guessing its id fails on authorization, before
  // the identifier is ever looked up.
  const fakeId = "00000000-0000-0000-0000-000000000000";
  expect((await page.request.post(`/api/admin/invitations/${fakeId}`)).status()).toBe(403);
  expect((await page.request.delete(`/api/admin/invitations/${fakeId}`)).status()).toBe(
    403,
  );

  // Neither screen is reachable by typing the URL.
  await page.goto("/admin/import");
  await expect(page).not.toHaveURL(/\/admin\/import/);
});

test("a chief cannot invite anybody either", async ({ page }) => {
  // Inviting creates an account, so it sits with the rest of user management:
  // administrator only. A chief who could invite a chief would be a quiet
  // privilege escalation.
  await signIn(page, ACCOUNTS.chief);

  expect((await page.request.get("/api/admin/invitations")).status()).toBe(403);
  for (const role of ["resident", "chief", "admin"]) {
    const attempt = await page.request.post("/api/admin/invitations", {
      data: { emails: [`e2e.new-${role}@hospital.org`], role },
    });
    expect(attempt.status(), role).toBe(403);
  }

  // …but the chief's own remit — running the schedule — still works.
  expect((await page.request.get("/api/admin/import/template")).ok()).toBe(true);
});

test("an invitation link is useless to anybody but its addressee", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  const response = await page.request.post("/api/admin/invitations", {
    data: { emails: ["e2e.invitee@hospital.org"], role: "resident" },
  });
  expect(response.status()).toBe(201);
  const { created } = (await response.json()) as {
    created: Array<{ id: string; url: string }>;
  };
  const url = created[0].url;

  await signOut(page);

  // The acceptance page is public — it has to be, the invitee is not signed in
  // yet — but it only reveals the program and the address it was sent to.
  await page.goto(url);
  await expect(page.getByRole("link", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByText("e2e.invitee@hospital.org").first()).toBeVisible();

  // A token that was never issued says the same thing as an expired one: no
  // oracle that distinguishes "wrong" from "used up".
  await page.goto("/invite/0000000000000000000000000000000000000000000");
  await expect(page.getByText(/may have expired, been cancelled/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /continue with google/i })).toHaveCount(0);

  // Revoking it takes the link out of service immediately.
  await signIn(page, ACCOUNTS.admin);
  await page.request.delete(`/api/admin/invitations/${created[0].id}`);
  await signOut(page);
  await page.goto(url);
  await expect(page.getByText(/may have expired, been cancelled/i)).toBeVisible();
});

test("a chief cannot reach administrator-only endpoints", async ({ page }) => {
  await signIn(page, ACCOUNTS.chief);
  expect((await page.request.get("/api/admin/users")).status()).toBe(403);
  expect((await page.request.get("/api/admin/rules")).status()).toBe(403);
  // …but chief-level endpoints work.
  expect((await page.request.get("/api/approvals")).ok()).toBe(true);
  expect((await page.request.get("/api/admin/audit")).ok()).toBe(true);
});

test("a resident cannot post, offer or accept on somebody else's behalf", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.alice);
  const aliceShifts = (await (await page.request.get("/api/schedule")).json())
    .shifts as Array<{ id: string }>;
  const aliceShiftId = aliceShifts[0].id;

  await signOut(page);
  await signIn(page, ACCOUNTS.bob);

  // Posting a shift Bob does not hold.
  const post = await page.request.post("/api/switches", {
    data: { shiftId: aliceShiftId },
  });
  expect(post.status()).toBe(403);

  // Offering a shift Bob does not hold.
  await signOut(page);
  await signIn(page, ACCOUNTS.alice);
  const created = await page.request.post("/api/switches", {
    data: { shiftId: aliceShiftId },
  });
  expect(created.ok()).toBe(true);
  const tradeId = (await created.json()).tradeRequest.id as string;

  await signOut(page);
  await signIn(page, ACCOUNTS.carol);
  const offerSomebodyElses = await page.request.post(`/api/switches/${tradeId}/offers`, {
    data: { offeredShiftId: aliceShiftId },
  });
  expect(offerSomebodyElses.status()).toBe(403);

  // Accepting an offer on a post Carol did not create.
  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  const bobShifts = (await (await page.request.get("/api/schedule")).json())
    .shifts as Array<{ id: string }>;
  const offerResponse = await page.request.post(`/api/switches/${tradeId}/offers`, {
    data: { offeredShiftId: bobShifts[0].id },
  });
  expect(offerResponse.ok()).toBe(true);
  const offerId = (await offerResponse.json()).offer.id as string;

  const wrongAccepter = await page.request.post(`/api/offers/${offerId}/accept`);
  expect(wrongAccepter.status()).toBe(403);
});

test("malformed and unknown identifiers fail safely", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);

  const badUuid = await page.request.get("/api/switches/not-a-uuid");
  expect([404, 422, 500]).toContain(badUuid.status());
  expect(await badUuid.text()).not.toContain("PostgresError");

  const unknown = await page.request.get(
    "/api/switches/00000000-0000-0000-0000-000000000000",
  );
  expect(unknown.status()).toBe(404);
  const body = await unknown.json();
  expect(body.error.message).not.toMatch(/select|relation|syntax/i);

  const badBody = await page.request.post("/api/switches", {
    data: { shiftId: "nonsense" },
  });
  expect(badBody.status()).toBe(422);
  expect((await badBody.json()).error.code).toBe("validation_failed");

  const notJson = await page.request.post("/api/switches", {
    data: "not json at all",
    headers: { "content-type": "application/json" },
  });
  expect([400, 422]).toContain(notJson.status());
});

test("an unconfigured account is told to contact its administrator", async ({ page }) => {
  await signIn(page, ACCOUNTS.pending);
  await page.goto("/");
  await expect(page).toHaveURL(/\/pending/);
  await expect(
    page.getByText(/your account is not yet configured/i),
  ).toBeVisible();
  await expect(
    page.getByText(/please contact your program administrator/i),
  ).toBeVisible();

  // The API is closed to it as well.
  const response = await page.request.get("/api/schedule");
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("not_configured");
});

test("signing out ends the session everywhere", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  expect((await page.request.get("/api/session")).ok()).toBe(true);
  await page.request.post("/api/auth/signout");
  const after = await (await page.request.get("/api/session")).json();
  expect(after.authenticated).toBe(false);
  const schedule = await page.request.get("/api/schedule");
  expect(schedule.status()).toBe(401);
});

test("the development invitation shortcut is gated, not open", async ({ page }) => {
  /* The sandbox exists so one person can test an invitation without a second
     Google account. It must never be a way *round* acceptance. */
  const fake = "0".repeat(43);

  // Unauthenticated, with a token that was never issued: refused, and the
  // refusal says nothing about whether any token would have worked.
  const anonymous = await page.request.post("/api/dev/accept-invitation", {
    data: { token: fake },
  });
  expect(anonymous.status()).toBe(404);

  // Signed in as a resident makes no difference — it is not an authorization
  // shortcut, it is a stand-in for Google.
  await signIn(page, ACCOUNTS.bob);
  expect(
    (await page.request.post("/api/dev/accept-invitation", { data: { token: fake } }))
      .status(),
  ).toBe(404);

  // A malformed token is rejected before anything is looked up.
  expect(
    (await page.request.post("/api/dev/accept-invitation", { data: { token: "short" } }))
      .status(),
  ).toBe(422);

  /* This suite runs with ALLOW_TEST_LOGIN=true, so the route is reachable here.
     That it is *unreachable* in production is enforced by `describeEnvironment`
     and covered in tests/unit/environment.test.ts, which asserts the flag is
     ignored entirely when NODE_ENV is production. */
});

test("security headers are present", async ({ page }) => {
  const response = await page.request.get("/login");
  const headers = response.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});
