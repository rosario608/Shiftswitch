import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn } from "./helpers";

/**
 * Store screenshots, taken from the running app.
 *
 * They are captured rather than mocked up, so what a reviewer sees in the
 * listing is what the app actually renders. Every name, service and shift comes
 * from `scripts/e2e-fixture.ts`, which is entirely fictional — no real
 * resident, real schedule or real institution appears in a store listing.
 *
 *   npx playwright test --config playwright.mobile.config.ts screenshots
 *
 * Output: release/screenshots/phone-*.png at 1080x1920, which satisfies both
 * the Play Console (min 320px, 16:9-ish, ≤8MB) and App Store Connect for the
 * 6.5"/6.7" iPhone sizes after the resize step noted in RELEASE_CHECKLIST.md.
 */

const OUTPUT = "release/screenshots";

/**
 * A presentable, entirely fictional program name for the listing. The people,
 * services, wards and shifts all come from the same fixture and are equally
 * invented — no real resident or institution appears in a store screenshot.
 */
const FIXTURE = { E2E_PROGRAM_NAME: "Internal Medicine Residency" };

test.use({
  viewport: { width: 540, height: 960 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

test.beforeAll(() => {
  mkdirSync(OUTPUT, { recursive: true });
  resetFixture(FIXTURE);
});

test.describe.configure({ mode: "serial" });

test("01 — home", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await expect(page.getByRole("heading", { name: /Hello, Alice/ })).toBeVisible();
  await expect(page.getByText("Your next shift")).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-01-home.png` });
});

test("02 — schedule", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.getByRole("link", { name: "Schedule" }).click();
  await expect(page.getByRole("heading", { name: "Your schedule" })).toBeVisible();
  await expect(page.getByText("MICU").first()).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-02-schedule.png` });
});

test("03 — posting a shift", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.getByRole("link", { name: "Schedule" }).click();
  await page.locator("button").filter({ hasText: "MICU" }).first().click();
  await page.getByRole("button", { name: "Post this shift for switch" }).click();
  await page
    .getByLabel("Note (optional)")
    .fill("Sister's wedding — happy to take any weekday in return.");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-03-post.png` });

  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Post for switch" })
    .click();
  await expect(page.getByRole("heading", { name: "Your post" })).toBeVisible();
});

test("04 — the switch board", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);
  await page.getByRole("link", { name: "Switches" }).click();
  await expect(page.getByRole("heading", { name: "Switches" })).toBeVisible();
  await expect(page.getByText(/wedding/)).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-04-board.png` });
});

test("05 — choosing a shift to offer, with the rules checked", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);
  await page.getByRole("link", { name: "Switches" }).click();
  await page.getByText(/wedding/).click();
  await page.getByRole("button", { name: "Offer one of my shifts" }).click();
  const sheet = page.getByRole("dialog", { name: "Choose a shift to offer" });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Offer this shift" }).first(),
  ).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-05-offer.png` });

  await sheet.getByRole("button", { name: "Offer this shift" }).first().click();
  await expect(page.getByRole("heading", { name: "Your offer" })).toBeVisible();
});

test("06 — reviewing an offer", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await expect(page.getByText(/offers? on your/).first()).toBeVisible();
  await page.getByText(/offers? on your/).first().click();
  await expect(page.getByRole("heading", { name: "Your post" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-06-review-offer.png` });
});

test("07 — the chief approval queue", async ({ page }) => {
  resetFixture(FIXTURE);

  // Build one switch that the rules escalate, so the queue is not empty.
  await signIn(page, ACCOUNTS.carol);
  await page.getByRole("link", { name: "Schedule" }).click();
  await page.locator("button").filter({ hasText: /MICU|Floor|Night/ }).first().click();
  await page.getByRole("button", { name: "Post this shift for switch" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Post for switch" })
    .click();
  await expect(page.getByRole("heading", { name: "Your post" })).toBeVisible();
  const tradeUrl = page.url();

  const bob = await page.context().browser()!.newContext();
  const bobPage = await bob.newPage();
  await signIn(bobPage, ACCOUNTS.bob);
  await bobPage.goto(tradeUrl);
  await bobPage.getByRole("button", { name: "Offer one of my shifts" }).click();
  await bobPage
    .getByRole("dialog", { name: "Choose a shift to offer" })
    .getByRole("button", { name: "Offer this shift" })
    .first()
    .click();
  await expect(bobPage.getByRole("heading", { name: "Your offer" })).toBeVisible();
  await bob.close();

  await page.goto(tradeUrl);
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Yes, accept" }).click();
  await expect(
    page.getByText("Waiting for chief approval", { exact: true }),
  ).toBeVisible();

  const chiefContext = await page.context().browser()!.newContext({
    viewport: { width: 540, height: 960 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const chief = await chiefContext.newPage();
  await signIn(chief, ACCOUNTS.chief);
  await chief.getByRole("link", { name: "Approvals" }).click();
  await expect(chief.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(chief.getByRole("button", { name: "Approve" }).first()).toBeVisible();
  await chief.screenshot({ path: `${OUTPUT}/phone-07-approvals.png` });
  await chiefContext.close();
});

test("08 — completed switch and the program email", async ({ page }) => {
  resetFixture(FIXTURE);

  await signIn(page, ACCOUNTS.alice);
  await page.getByRole("link", { name: "Schedule" }).click();
  await page.locator("button").filter({ hasText: "MICU" }).first().click();
  await page.getByRole("button", { name: "Post this shift for switch" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Post for switch" })
    .click();
  // Wait for the navigation before reading the URL, or it is still the shift.
  await expect(page.getByRole("heading", { name: "Your post" })).toBeVisible();
  const tradeUrl = page.url();

  const bobContext = await page.context().browser()!.newContext();
  const bob = await bobContext.newPage();
  await signIn(bob, ACCOUNTS.bob);
  await bob.goto(tradeUrl);
  await bob.getByRole("button", { name: "Offer one of my shifts" }).click();
  await bob
    .getByRole("dialog", { name: "Choose a shift to offer" })
    .getByRole("button", { name: "Offer this shift" })
    .first()
    .click();
  await expect(bob.getByRole("heading", { name: "Your offer" })).toBeVisible();
  await bobContext.close();

  await page.goto(tradeUrl);
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Yes, accept" }).click();
  await expect(
    page.getByRole("heading", { name: "Completed switch" }),
  ).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-08-completed.png` });

  await page.getByRole("button", { name: /Prepare the email/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Program notification" }),
  ).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-09-email.png` });
});

test("10 — notification settings", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.getByRole("link", { name: "You" }).click();
  await expect(page.getByText("Trade offers and responses")).toBeVisible();
  await page.screenshot({ path: `${OUTPUT}/phone-10-settings.png` });
});
