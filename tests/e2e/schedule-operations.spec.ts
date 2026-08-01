import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn, signOut } from "./helpers";

/**
 * The operational workflow through the interface: record availability, open the
 * grid, sign a schedule off, and read what has changed since it went out.
 *
 * The integration suite already proves the mechanics. What only a browser can
 * show is that a person can *reach* them — that the approve button exists
 * before the publish button, that a resident can tell the programme they are
 * away without anybody's help, and that a phone number is a link you can tap.
 */
test.beforeAll(() => {
  resetFixture();
});

test("a resident records time away, and cannot confirm it themselves", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/profile");

  await expect(page.getByRole("heading", { name: /when you are away/i })).toBeVisible();
  await page.getByRole("button", { name: /^add$/i }).click();

  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("What").selectOption({ label: "Conference" });
  await sheet.getByLabel("First day").fill("2027-03-01");
  await sheet.getByLabel("Last day").fill("2027-03-03");
  await sheet.getByRole("button", { name: /^record$/i }).click();

  /* Recorded, and **requested** rather than confirmed. A resident who could
     confirm their own absence could invalidate the programme's schedule
     unilaterally. */
  await expect(page.getByText("Conference")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Requested")).toBeVisible();
  await expect(page.getByText("Confirmed")).toHaveCount(0);

  // And no way to confirm it: the control is not rendered, not merely disabled.
  await expect(page.getByRole("button", { name: /^confirm$/i })).toHaveCount(0);
});

test("a chief confirms an absence, and it binds the schedule", async ({ page }) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/availability");

  await expect(page.getByRole("heading", { level: 1, name: "Availability" })).toBeVisible();

  /* The demo seeds three absences in all three states, so there is something
     to confirm without this test having to create one first. */
  const requested = page.getByText("Requested").first();
  await expect(requested).toBeVisible();

  await page.getByRole("button", { name: /^confirm$/i }).first().click();
  await expect(page.getByText("Confirmed").first()).toBeVisible({ timeout: 20_000 });
});

test("a chief reaches the grid, and it shows coverage rather than a table", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/coverage");

  await expect(page.getByRole("heading", { level: 1, name: "Coverage" })).toBeVisible();

  // The three views, and the filters that make a month navigable.
  await expect(page.getByRole("button", { name: /^grid$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^calendar$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^list$/i })).toBeVisible();
  await expect(page.getByLabel("Search")).toBeVisible();
  await expect(page.getByLabel("PGY")).toBeVisible();

  /* Filtering narrows what is shown, and the screen says by how much — a
     filter that silently shows nothing is indistinguishable from a broken
     page. */
  const showing = page.getByText(/showing \d+ of \d+/i);
  await expect(showing).toBeVisible();
  const before = await showing.textContent();
  await page.getByLabel("Search").fill("zzzz-no-such-person");
  await expect(showing).not.toHaveText(before!, { timeout: 20_000 });
  await expect(page.getByText(/nothing matches/i).first()).toBeVisible();

  await page.getByLabel("Search").fill("");
  await page.getByRole("button", { name: /^list$/i }).click();
  await expect(page.getByText(/nothing matches/i)).toHaveCount(0);
});

test("publishing is refused until somebody signs the schedule off", async ({ page }) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/scheduler");

  await page.getByRole("button", { name: /start a draft/i }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Name").fill("Sign-off test");
  await sheet.getByLabel("Covers from").fill("2029-01-01");
  await sheet.getByLabel("To", { exact: true }).fill("2029-01-14");
  await sheet.getByRole("button", { name: /create draft/i }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Sign-off test" }),
  ).toBeVisible();

  /* Approve comes first on the page, and until it has happened the publish
     section says what to do rather than offering a button that would fail. */
  await expect(page.getByRole("heading", { name: "Approve" })).toBeVisible();
  await expect(page.getByText(/approve it first/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /publish this schedule/i })).toHaveCount(0);

  await page.getByRole("button", { name: /approve this schedule/i }).click();

  // Approved, by a named person, and only now is publishing offered.
  await expect(page.getByText(/approved by/i)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("button", { name: /publish this schedule/i }),
  ).toBeVisible();

  // And it can be taken back, which puts publishing out of reach again.
  await page.getByRole("button", { name: /withdraw approval/i }).click();
  await expect(page.getByText(/approve it first/i)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: /discard draft/i }).click();
  await page.getByRole("button", { name: /yes, discard this draft/i }).click();
  await expect(page).toHaveURL(/\/admin\/scheduler$/);
});

test("the directory shows numbers as links, and only to somebody entitled to them", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/directory");

  await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible();

  /* A `tel:` href, not text to be copied. On a phone that is one tap to a
     call, which is the whole point at two in the morning. */
  const call = page.locator('a[href^="tel:"]').first();
  await expect(call).toBeVisible();
  await expect(call).toHaveAttribute("href", /^tel:\+?\d+/);

  // A resident holds no `residents.contact_info`, so the screen is not theirs.
  await signOut(page);
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/admin/directory");
  await expect(page).toHaveURL(/\/\?denied=1$/);
});

test("a chief corrects a published shift and the record says why", async ({ page }) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/corrections");

  await expect(page.getByRole("heading", { level: 1, name: "Corrections" })).toBeVisible();
  await expect(page.getByText(/nothing has been corrected/i)).toBeVisible();

  await page.getByRole("button", { name: /correct a shift/i }).click();
  const sheet = page.getByRole("dialog");

  /* A reason cannot be skipped: the submit button stays out of reach until
     there is one, because whoever loses the shift reads it. */
  const submit = sheet.getByRole("button", { name: /correct this shift/i });
  await expect(submit).toBeDisabled();

  const options = await sheet.getByLabel("Who works it now").locator("option").all();
  const replacement = options[1];
  await sheet
    .getByLabel("Who works it now")
    .selectOption({ label: (await replacement.textContent())! });
  await sheet.getByLabel("Why").fill("Sick leave from Monday; covering the gap.");
  await expect(submit).toBeEnabled();
  await submit.click();

  /* The result says what it did to the schedule, who was told, and it is on
     the list afterwards with the reason a reader can act on. */
  await expect(page.getByText(/^corrected$/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/told:/i)).toBeVisible();
  await expect(page.getByText(/sick leave from monday/i).first()).toBeVisible();
  await expect(page.getByText(/nothing has been corrected/i)).toHaveCount(0);
});
