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
    "/api/trades",
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
  const post = await page.request.post("/api/trades", {
    data: { shiftId: aliceShiftId },
  });
  expect(post.status()).toBe(403);

  // Offering a shift Bob does not hold.
  await signOut(page);
  await signIn(page, ACCOUNTS.alice);
  const created = await page.request.post("/api/trades", {
    data: { shiftId: aliceShiftId },
  });
  expect(created.ok()).toBe(true);
  const tradeId = (await created.json()).tradeRequest.id as string;

  await signOut(page);
  await signIn(page, ACCOUNTS.carol);
  const offerSomebodyElses = await page.request.post(`/api/trades/${tradeId}/offers`, {
    data: { offeredShiftId: aliceShiftId },
  });
  expect(offerSomebodyElses.status()).toBe(403);

  // Accepting an offer on a post Carol did not create.
  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  const bobShifts = (await (await page.request.get("/api/schedule")).json())
    .shifts as Array<{ id: string }>;
  const offerResponse = await page.request.post(`/api/trades/${tradeId}/offers`, {
    data: { offeredShiftId: bobShifts[0].id },
  });
  expect(offerResponse.ok()).toBe(true);
  const offerId = (await offerResponse.json()).offer.id as string;

  const wrongAccepter = await page.request.post(`/api/offers/${offerId}/accept`);
  expect(wrongAccepter.status()).toBe(403);
});

test("malformed and unknown identifiers fail safely", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);

  const badUuid = await page.request.get("/api/trades/not-a-uuid");
  expect([404, 422, 500]).toContain(badUuid.status());
  expect(await badUuid.text()).not.toContain("PostgresError");

  const unknown = await page.request.get(
    "/api/trades/00000000-0000-0000-0000-000000000000",
  );
  expect(unknown.status()).toBe(404);
  const body = await unknown.json();
  expect(body.error.message).not.toMatch(/select|relation|syntax/i);

  const badBody = await page.request.post("/api/trades", {
    data: { shiftId: "nonsense" },
  });
  expect(badBody.status()).toBe(422);
  expect((await badBody.json()).error.code).toBe("validation_failed");

  const notJson = await page.request.post("/api/trades", {
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

test("security headers are present", async ({ page }) => {
  const response = await page.request.get("/login");
  const headers = response.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});
