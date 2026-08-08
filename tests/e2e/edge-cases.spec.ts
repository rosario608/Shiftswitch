import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn, signOut } from "./helpers";

/**
 * Things that go wrong in real use: stale pages, double taps, offers that are
 * no longer valid, and shifts that change underneath a pending trade.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  resetFixture();
});

async function postAndOffer(page: import("@playwright/test").Page) {
  await signIn(page, ACCOUNTS.alice);
  const aliceShifts = (await (await page.request.get("/api/schedule")).json())
    .shifts as Array<{ id: string }>;
  const created = await page.request.post("/api/switches", {
    data: { shiftId: aliceShifts[0].id },
  });
  const tradeId = (await created.json()).tradeRequest.id as string;

  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  const bobShifts = (await (await page.request.get("/api/schedule")).json())
    .shifts as Array<{ id: string }>;
  const offerResponse = await page.request.post(`/api/switches/${tradeId}/offers`, {
    data: { offeredShiftId: bobShifts[0].id },
  });
  expect(offerResponse.ok()).toBe(true);
  const offerId = (await offerResponse.json()).offer.id as string;

  await signOut(page);
  await signIn(page, ACCOUNTS.alice);
  return { tradeId, offerId, aliceShiftId: aliceShifts[0].id, bobShiftId: bobShifts[0].id };
}

test("double-tapping accept creates exactly one switch", async ({ page }) => {
  const { offerId } = await postAndOffer(page);

  const [first, second] = await Promise.all([
    page.request.post(`/api/offers/${offerId}/accept`),
    page.request.post(`/api/offers/${offerId}/accept`),
  ]);
  const statuses = [first.status(), second.status()].sort();
  expect(statuses[0]).toBe(200);
  expect(statuses[1]).toBeGreaterThanOrEqual(400);

  const history = await page.request.get("/api/switches?limit=50");
  expect(history.ok()).toBe(true);
  // Exactly one switch is visible in the resident's history.
  await page.goto("/switches?tab=history");
  await expect(page.getByRole("link", { name: /↔/ })).toHaveCount(1);
});

test("an obsolete offer cannot be accepted from a stale page", async ({ page }) => {
  const { tradeId, offerId } = await postAndOffer(page);

  // The page is loaded while the offer is still pending.
  await page.goto(`/switches/${tradeId}`);
  await expect(page.getByRole("button", { name: /^accept$/i })).toBeVisible();

  // Meanwhile the offer is withdrawn by the other resident.
  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  await page.request.post(`/api/offers/${offerId}/withdraw`);
  await signOut(page);
  await signIn(page, ACCOUNTS.alice);

  // Accepting from the stale page is refused with a readable message.
  const response = await page.request.post(`/api/offers/${offerId}/accept`);
  expect(response.status()).toBe(409);
  const body = await response.json();
  expect(body.error.message).toMatch(/no longer available|already been completed/i);
});

test("an offer on a cancelled shift cannot be accepted", async ({ page }) => {
  const { offerId } = await postAndOffer(page);

  // An administrator cancels the shift while the trade is live. (True deadline
  // expiry is covered in the integration suite, which can move the clock.)
  await signOut(page);
  await signIn(page, ACCOUNTS.admin);
  const shifts = await (
    await page.request.get("/api/admin/shifts?limit=200")
  ).json();
  const target = (shifts.shifts as Array<{ id: string; status: string }>).find(
    (shift) => shift.status === "offer_pending",
  );
  expect(target).toBeTruthy();
  const patched = await page.request.patch(`/api/admin/shifts/${target!.id}`, {
    data: { status: "cancelled", reason: "Service closed" },
  });
  expect(patched.ok()).toBe(true);

  await signOut(page);
  await signIn(page, ACCOUNTS.alice);
  const response = await page.request.post(`/api/offers/${offerId}/accept`);
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect((await response.json()).error.message).toMatch(
    /no longer|cancelled|not active/i,
  );
});

test("a completed switch cannot be re-opened or re-accepted", async ({ page }) => {
  const { tradeId, offerId } = await postAndOffer(page);
  const accepted = await page.request.post(`/api/offers/${offerId}/accept`);
  expect(accepted.ok()).toBe(true);

  await page.goto(`/switches/${tradeId}`);
  await expect(page.getByText("Completed").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^accept$/i })).toHaveCount(0);

  const again = await page.request.post(`/api/offers/${offerId}/accept`);
  expect(again.status()).toBe(409);
});

test("a resident is told why an offer became unavailable", async ({ page }) => {
  const { tradeId } = await postAndOffer(page);

  // Alice cancels her post; Bob should be told why his offer disappeared.
  const cancelled = await page.request.post(`/api/switches/${tradeId}/cancel`, {
    data: { reason: "No longer needed" },
  });
  expect(cancelled.ok()).toBe(true);

  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  await page.goto("/notifications");
  await expect(
    page.getByText(/no longer available|was cancelled/i).first(),
  ).toBeVisible();

  // And the trade page itself explains the state.
  await page.goto(`/switches/${tradeId}`);
  await expect(page.getByText("Cancelled").first()).toBeVisible();
});

test("posting is refused for a shift that is no longer eligible", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  const shifts = (await (await page.request.get("/api/schedule")).json()).shifts as Array<{
    id: string;
  }>;
  const first = await page.request.post("/api/switches", {
    data: { shiftId: shifts[0].id },
  });
  expect(first.ok()).toBe(true);

  const second = await page.request.post("/api/switches", {
    data: { shiftId: shifts[0].id },
  });
  expect(second.status()).toBe(409);
  expect((await second.json()).error.message).toMatch(/already/i);
});

/**
 * PDF export was removed to fit the Cloudflare Worker size limit, and the
 * profile screen linked to `?format=pdf` for months. Those links are in
 * bookmarks and download histories, so they answer with the spreadsheet rather
 * than a validation error — a dead end in front of the one thing the resident
 * wanted is worse than a format they did not choose.
 */
test("a retired ?format=pdf export link still downloads the schedule", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);

  const legacy = await page.request.get("/api/admin/export?format=pdf&scope=mine");
  expect(legacy.ok()).toBe(true);
  expect(legacy.headers()["content-type"]).toContain("spreadsheetml.sheet");
  expect(legacy.headers()["content-disposition"]).toContain("my-schedule.xlsx");
  // XLSX files are ZIP archives; the magic bytes prove a real workbook came back.
  expect((await legacy.body()).subarray(0, 2).toString("utf8")).toBe("PK");

  const current = await page.request.get("/api/admin/export?format=xlsx&scope=mine");
  expect(current.ok()).toBe(true);

  // A format nobody ever offered is still refused, and says what to choose.
  const unknown = await page.request.get("/api/admin/export?format=docx&scope=mine");
  expect(unknown.ok()).toBe(false);
  expect((await unknown.json()).error.message).toMatch(/CSV or XLSX/i);
});
