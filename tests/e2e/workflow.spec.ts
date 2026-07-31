import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn, signOut } from "./helpers";

/**
 * The highest-priority workflow in the product, end to end, in a browser:
 *
 *   sign in → see next shift → post for trade → other resident finds it →
 *   offers a shift → poster accepts → schedules swap → program email is
 *   generated with the right recipients and marked sent.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetFixture();
});

test("resident posts a shift, a colleague offers, the switch completes and the program is notified", async ({
  page,
}) => {
  // --- Alice signs in and sees her next shift -------------------------------
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /hello, alice/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Next shift" })).toBeVisible();

  // --- Alice posts a shift for trade ---------------------------------------
  await page.getByRole("button", { name: /post this shift for trade/i }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/which shift\?/i)).toBeVisible();
  await sheet.getByLabel(/note for your colleagues/i).fill("Family event — happy to swap.");
  await sheet.getByRole("button", { name: /^post for trade$/i }).click();

  await page.waitForURL(/\/trades\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /your posted shift/i })).toBeVisible();
  await expect(page.getByText(/no offers yet/i)).toBeVisible();
  const tradeUrl = page.url();

  // The shift now shows as posted on Alice's schedule.
  await page.goto("/schedule");
  await expect(page.getByText("Posted for trade").first()).toBeVisible();

  // --- Bob finds the trade and offers one of his shifts --------------------
  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  await page.goto("/trades");
  await expect(page.getByRole("heading", { name: "Trades" })).toBeVisible();
  await expect(page.getByText(/family event/i)).toBeVisible();
  await expect(page.getByText(/% match/).first()).toBeVisible();

  await page.goto(tradeUrl);
  await page.getByRole("button", { name: /offer my shift/i }).click();
  const offerSheet = page.getByRole("dialog");
  // The sheet shows a loading state while eligibility is checked, then the
  // ranked list of shifts the resident is actually allowed to offer.
  await expect(offerSheet.getByText(/% match/).first()).toBeVisible({ timeout: 20_000 });
  // The rules engine result is shown before committing.
  await expect(offerSheet.getByText(/validation checks/i)).toBeVisible();
  await offerSheet.getByRole("button", { name: /send offer/i }).click();
  await expect(page.getByText(/waiting for alice/i)).toBeVisible();

  // --- Alice accepts -------------------------------------------------------
  await signOut(page);
  await signIn(page, ACCOUNTS.alice);
  await page.goto(tradeUrl);
  await expect(page.getByText(/offers you/i)).toBeVisible();
  await page.getByRole("button", { name: /^accept$/i }).click();

  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("You give")).toBeVisible();
  await expect(confirm.getByText("You receive")).toBeVisible();
  await expect(
    confirm.getByText(/this action will permanently update both schedules/i),
  ).toBeVisible();
  await confirm.getByRole("button", { name: /complete switch/i }).click();

  // --- Switch completed ----------------------------------------------------
  await page.waitForURL(/\/switches\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /switch completed/i })).toBeVisible();
  await expect(page.getByText(/both schedules were updated/i)).toBeVisible();

  // --- Notify the program --------------------------------------------------
  await page.getByRole("button", { name: /notify program/i }).click();
  await expect(page.locator("#email-to")).toHaveValue(/coordinator@hospital\.org/, {
    timeout: 20_000,
  });
  await expect(page.locator("#email-cc")).toHaveValue(/chief@hospital\.org/);
  await expect(page.locator("#email-subject")).toHaveValue(/^Shift Switch – /);
  const body = await page.locator("#email-body").inputValue();
  expect(body).toContain("Alice Adeyemi and Bob Brennan have completed a shift switch.");
  expect(body).toContain("Original assignment:");
  expect(body).toContain("New assignment:");

  // The mailto link is properly encoded.
  const mailto = await page
    .getByRole("link", { name: /open in email/i })
    .getAttribute("href");
  expect(mailto).toMatch(/^mailto:coordinator%40hospital\.org\?/);
  expect(mailto).toContain("cc=chief%40hospital.org");
  expect(mailto).toContain("subject=Shift%20Switch");

  await page.getByRole("button", { name: /mark as sent/i }).click();
  await expect(page.getByText("Marked as sent")).toBeVisible();

  // --- Both schedules really changed --------------------------------------
  await page.goto("/schedule");
  await expect(page.getByText("Night Float").or(page.getByText("Floor")).first()).toBeVisible();
  const aliceSchedule = await page.request.get("/api/schedule");
  const aliceShifts = (await aliceSchedule.json()).shifts as Array<{ id: string }>;

  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  const bobSchedule = await page.request.get("/api/schedule");
  const bobShifts = (await bobSchedule.json()).shifts as Array<{ id: string }>;

  const aliceIds = new Set(aliceShifts.map((shift) => shift.id));
  const bobIds = new Set(bobShifts.map((shift) => shift.id));
  // No shift is held by both residents.
  for (const id of aliceIds) expect(bobIds.has(id)).toBe(false);
});

test("a switch that needs approval waits for a chief and then completes", async ({
  page,
}) => {
  resetFixture();

  // Carol posts a shift that the program flagged as approval-required.
  await signIn(page, ACCOUNTS.carol);
  await page.goto("/schedule");
  await page.getByRole("button", { name: /post a shift for trade/i }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByText(/chief approval/i).first().waitFor();
  await sheet.getByRole("button", { name: /^post for trade$/i }).click();
  await page.waitForURL(/\/trades\/[0-9a-f-]{36}$/);
  const tradeUrl = page.url();

  // Bob offers.
  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  await page.goto(tradeUrl);
  await page.getByRole("button", { name: /offer my shift/i }).click();
  const offerSheet = page.getByRole("dialog");
  await expect(offerSheet.getByText(/needs chief approval/i).first()).toBeVisible({
    timeout: 20_000,
  });
  await offerSheet.getByRole("button", { name: /send offer/i }).click();
  await expect(page.getByText(/waiting for carol/i)).toBeVisible();

  // Carol accepts — this goes to the approval queue rather than completing.
  await signOut(page);
  await signIn(page, ACCOUNTS.carol);
  await page.goto(tradeUrl);
  await page.getByRole("button", { name: /^accept$/i }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText(/chief approval required/i)).toBeVisible();
  await confirm.getByRole("button", { name: /send for approval/i }).click();
  await expect(page.getByText(/waiting for chief approval/i)).toBeVisible({
    timeout: 20_000,
  });

  // The chief reviews the validation results and approves.
  await signOut(page);
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/approvals");
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(page.getByText("Passes rules").first()).toBeVisible();
  await expect(page.getByText(/validation results/i).first()).toBeVisible();
  await page.getByRole("button", { name: /approve switch/i }).first().click();
  await expect(page.getByText(/nothing waiting for approval/i)).toBeVisible({
    timeout: 30_000,
  });

  // Carol sees the completed switch in her history.
  await signOut(page);
  await signIn(page, ACCOUNTS.carol);
  await page.goto("/trades?tab=history");
  await expect(page.getByText(/notify program/i).first()).toBeVisible();
});
