import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  registeredDevices,
  resetFixture,
  signIn,
  signOutOfApp,
} from "./helpers";

/**
 * The complete switch, driven through the native client.
 *
 * Alice posts a shift, Bob offers one of his, Alice accepts, and the schedule
 * changes for both of them. Every request in this run crosses an origin
 * boundary and carries a bearer token, so a CORS or auth regression fails here
 * rather than on a reviewer's phone.
 */

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetFixture();
});

test("a resident signs in and sees their own schedule", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);

  await expect(page.getByRole("heading", { name: /Hello, Alice/ })).toBeVisible();
  await expect(page.getByText("E2E Internal Medicine")).toBeVisible();

  await page.getByRole("link", { name: "Schedule" }).click();
  await expect(page.getByRole("heading", { name: "Your schedule" })).toBeVisible();
  await expect(page.getByText("MICU").first()).toBeVisible();

  // Signing in registers this installation, so the server can reach it later
  // and so signing out can revoke it. Push itself is off — the browser has no
  // token to give — and the row records that honestly rather than claiming
  // notifications are enabled.
  await expect(async () => {
    const devices = registeredDevices(ACCOUNTS.alice);
    expect(devices).toHaveLength(1);
    expect(devices[0].platform).toBe("web");
    expect(devices[0].has_push_token).toBe(false);
  }).toPass({ timeout: 15_000 });
});

test("posting a shift, receiving an offer and accepting it completes the switch", async ({
  page,
  browser,
}) => {
  // --- Alice posts one of her shifts -------------------------------------
  await signIn(page, ACCOUNTS.alice);
  await page.getByRole("link", { name: "Schedule" }).click();

  await page.locator("button").filter({ hasText: "MICU" }).first().click();
  await expect(page.getByRole("heading", { name: "Shift" })).toBeVisible();

  await page.getByRole("button", { name: "Post this shift for switch" }).click();
  await page.getByLabel("Note (optional)").fill("Family event — any weekday works.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Post for switch" })
    .click();

  await expect(page.getByRole("heading", { name: "Your post" })).toBeVisible();
  await expect(page.getByText("No offers yet")).toBeVisible();
  const tradeUrl = page.url();

  // --- Bob offers one of his ---------------------------------------------
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await signIn(bob, ACCOUNTS.bob);

  await bob.getByRole("link", { name: "Switches" }).click();
  await expect(bob.getByRole("heading", { name: "Switches" })).toBeVisible();
  await bob.getByText("Family event").click();

  await expect(bob.getByRole("heading", { name: "Switch request" })).toBeVisible();
  await bob.getByRole("button", { name: "Offer one of my shifts" }).click();

  const sheet = bob.getByRole("dialog", { name: "Choose a shift to offer" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Offer this shift" }).first().click();

  await expect(bob.getByRole("heading", { name: "Your offer" })).toBeVisible();
  await expect(bob.getByText("Pending")).toBeVisible();

  // --- Alice accepts ------------------------------------------------------
  await page.goto(tradeUrl);
  await expect(page.getByText("1 offer")).toBeVisible();
  await expect(page.getByText("Bob")).toBeVisible();

  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Yes, accept" }).click();

  // The switch completes immediately: this pair needs no chief approval.
  await expect(
    page.getByRole("heading", { name: "Completed switch" }),
  ).toBeVisible();
  await expect(page.getByText("This switch is in effect")).toBeVisible();

  // --- And the program email is real --------------------------------------
  await page.getByRole("button", { name: /Prepare the email/ }).click();
  const email = page.getByRole("dialog", { name: "Program notification" });
  await expect(email).toBeVisible();
  await expect(email.getByText(/Shift switch/i).first()).toBeVisible();

  const mailto = await page
    .getByRole("button", { name: "Open in my mail app" })
    .isVisible();
  expect(mailto).toBe(true);

  await bobContext.close();
});

test("a chief approves a switch that the rules send for approval", async ({
  page,
  browser,
}) => {
  resetFixture();

  // Carol's shift is configured to require approval.
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

  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await signIn(bob, ACCOUNTS.bob);
  await bob.goto(tradeUrl);
  await bob.getByRole("button", { name: "Offer one of my shifts" }).click();
  const sheet = bob.getByRole("dialog", { name: "Choose a shift to offer" });
  await sheet.getByRole("button", { name: "Offer this shift" }).first().click();
  await expect(bob.getByRole("heading", { name: "Your offer" })).toBeVisible();

  await page.goto(tradeUrl);
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Yes, accept" }).click();
  await expect(
    page.getByText("Waiting for chief approval", { exact: true }),
  ).toBeVisible();

  // The chief sees it in their queue and approves it.
  const chiefContext = await browser.newContext();
  const chief = await chiefContext.newPage();
  await signIn(chief, ACCOUNTS.chief);

  await chief.getByRole("link", { name: "Approvals" }).click();
  await expect(chief.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(chief.getByText("Carol")).toBeVisible();

  await chief.getByRole("button", { name: "Approve" }).first().click();
  await chief
    .getByRole("dialog")
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(chief.getByText(/Approved\./)).toBeVisible();
  await expect(chief.getByText("Nothing waiting")).toBeVisible();

  await bobContext.close();
  await chiefContext.close();
});

test("an account with no program is told so instead of shown empty screens", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.pending);
  await expect(page.getByRole("heading", { name: "Almost there" })).toBeVisible();
  await expect(page.getByText(ACCOUNTS.pending)).toBeVisible();
  // No tab bar: there is nothing this account can do yet.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
});

test("settings shows real notification, calendar and account controls", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.alice);
  await page.getByRole("link", { name: "You" }).click();

  /* Every notification event the server defines is listed and switchable.
     This screen crashed on a shape mismatch once, and broke again when
     preferences moved from four coarse categories to one row per event — the
     screen kept reading `preferences` and `labels` from a response that no
     longer had either. The assertion stays, and it names an *event* now:
     "an offer on your shift" is a thing that happens to somebody, where
     "trade offers and responses" was a bucket. */
  await expect(page.getByText("An offer on your shift")).toBeVisible();
  const offers = page.getByRole("switch", { name: "An offer on your shift" });
  await expect(offers).toBeChecked();
  // The switch reflects what the server confirmed, not the tap, so this is a
  // click plus a retrying assertion rather than `uncheck()`.
  await offers.click();
  await expect(offers).not.toBeChecked();

  // The preference survives a reload, so it was actually saved.
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "An offer on your shift" }),
  ).not.toBeChecked();

  // The calendar link is issued once and shown once.
  await page.getByRole("button", { name: "Create my calendar link" }).click();
  await expect(page.getByText(/\/calendar\/.+\.ics/)).toBeVisible();

  // Deletion explains itself before it is possible to confirm.
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(
    page.getByRole("heading", { name: "Delete my account" }),
  ).toBeVisible();
  await expect(page.getByText("What gets deleted")).toBeVisible();
  await expect(page.getByText("What your program keeps")).toBeVisible();
  await expect(
    page.getByText(/Completed shift switches and who worked each shift/),
  ).toBeVisible();

  // Alice still holds upcoming shifts, so deletion is blocked — and the app
  // says which obligation is in the way rather than letting her confirm and
  // then failing. The confirmation field is disabled while that is true.
  await expect(page.getByText("Not right now")).toBeVisible();
  await expect(page.getByText(/still assigned to \d+ upcoming shift/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete my account permanently" }),
  ).toBeDisabled();
  await expect(page.getByLabel(/Type DELETE to confirm/)).toBeDisabled();
});

test("an account with nothing outstanding can delete itself in the app", async ({
  page,
}) => {
  resetFixture();

  // The pending account has no schedule and no live switches, so nothing
  // blocks it — the path both stores require must actually work end to end.
  await signIn(page, ACCOUNTS.pending);
  await page.goto("/settings/delete-account");

  await expect(page.getByText("What gets deleted")).toBeVisible();
  await expect(page.getByText("Not right now")).toHaveCount(0);

  const confirmButton = page.getByRole("button", {
    name: "Delete my account permanently",
  });
  await expect(confirmButton).toBeDisabled();
  await page.getByLabel(/Type DELETE to confirm/).fill("DELETE");
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  // Signed out, and signing in again is refused: the identity is gone.
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await page.getByLabel("Sign in as").fill(ACCOUNTS.pending);
  await page.getByRole("button", { name: "Sign in without Google" }).click();
  await expect(page.getByText(/No such user|not/i).first()).toBeVisible();
});

test("signing out clears the session on the device", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await expect(page.getByRole("heading", { name: /Hello, Alice/ })).toBeVisible();

  await page.getByRole("link", { name: "You" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();

  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();

  // Reloading must not resurrect the session.
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await signOutOfApp(page);
});
