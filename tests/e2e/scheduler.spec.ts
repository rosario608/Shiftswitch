import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn, signOut } from "./helpers";

/**
 * A scheduler configuring a programme, entirely from the interface.
 *
 * This is the goal's acceptance criterion made executable: no SQL, no seed
 * script, no API call from the test except the sign-in. Everything below is
 * done by clicking, the way a chief resident would do it on the day they are
 * handed the job.
 */
test.beforeAll(() => {
  resetFixture();
});

test("a chief configures a multi-PGY programme from the UI alone", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);

  // --- Services: start from the template, then edit it -----------------------
  await page.goto("/admin/services");
  await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible();

  await page.getByRole("button", { name: /see the available templates/i }).click();
  await expect(page.getByText("Duke Internal Medicine")).toBeVisible();
  // Presented as a starting point, not as correct — the wording is the feature.
  await expect(page.getByText(/starting point/i).first()).toBeVisible();

  await page.getByRole("button", { name: /add these, then edit them/i }).click();
  await expect(page.getByText(/Added \d+ services/)).toBeVisible({ timeout: 20_000 });

  // The services are really there, with their sites.
  await expect(page.getByText("General Medicine Wards").first()).toBeVisible();
  await expect(page.getByText("Durham VA Medical Center").first()).toBeVisible();

  // --- Configure one service, including coverage -----------------------------
  const micuCard = page
    .locator("li")
    .filter({ hasText: "Medical Intensive Care Unit" })
    .first();
  await micuCard.getByRole("link", { name: /configure/i }).click();

  await expect(
    page.getByRole("heading", { name: "Medical Intensive Care Unit" }),
  ).toBeVisible();
  // Template-sourced services say so, and say the values are editable.
  await expect(page.getByText(/none of them is a recommendation/i)).toBeVisible();

  // Coverage came with the template; add one more for a specific day.
  await page.getByRole("button", { name: /add a requirement/i }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("When this applies").selectOption("date");
  await sheet.getByLabel("Date", { exact: true }).fill("2026-12-25");
  await sheet.getByLabel("At least").fill("1");
  await sheet.getByLabel("At most").fill("1");
  await sheet.getByLabel("Label").fill("Christmas Day");
  await sheet.getByRole("button", { name: /^save$/i }).click();

  await expect(page.getByText("Christmas Day")).toBeVisible();
  await expect(page.getByText(/needs exactly 1 person/i)).toBeVisible();

  // Server-side validation is real: a mix nobody could staff is refused.
  await page.getByRole("button", { name: /add a requirement/i }).first().click();
  const second = page.getByRole("dialog");
  await second.getByLabel("At least").fill("1");
  await second.getByLabel("At most").fill("2");
  await second.getByRole("button", { name: /add a level/i }).click();
  await second.getByRole("button", { name: /add a level/i }).click();
  const mins = second.getByLabel("Min");
  await mins.nth(0).fill("2");
  await mins.nth(1).fill("2");
  await second.getByRole("button", { name: /^save$/i }).click();
  await expect(second.getByRole("alert")).toContainText(/no schedule could satisfy|capped at 2/i);
  await second.getByRole("button", { name: /^cancel$/i }).click();

  // --- Cohorts and the block year -------------------------------------------
  await page.goto("/admin/cohorts");
  await expect(page.getByRole("heading", { name: "Cohorts and blocks" })).toBeVisible();

  // Build a two-week year, to prove block length is configuration.
  await page.getByRole("button", { name: /build a year/i }).first().click();
  const yearSheet = page.getByRole("dialog");
  await yearSheet.getByLabel("Name").fill("Fortnightly test year");
  await yearSheet.getByLabel("Weeks per block").fill("2");
  await yearSheet.getByLabel("Number of blocks").fill("26");
  await yearSheet.getByRole("button", { name: /build it/i }).click();
  await expect(page.getByText(/Block 1/).first()).toBeVisible({ timeout: 20_000 });

  // Two paired cohorts.
  await page.getByRole("button", { name: /new cohort/i }).first().click();
  const cohortSheet = page.getByRole("dialog");
  await cohortSheet.getByLabel("Label").fill("PGY-2 Cohort A");
  await cohortSheet.getByLabel("Training level").selectOption("2");
  await cohortSheet.getByRole("button", { name: /create cohort/i }).click();
  await expect(page.getByText("PGY-2 Cohort A").first()).toBeVisible();

  await page.getByRole("button", { name: /new cohort/i }).first().click();
  const second2 = page.getByRole("dialog");
  await second2.getByLabel("Label").fill("PGY-2 Cohort B");
  await second2.getByLabel("Training level").selectOption("2");
  await second2.getByLabel("Alternates with").selectOption({ label: "PGY-2 Cohort A" });
  await second2.getByRole("button", { name: /create cohort/i }).click();

  // Pairing is reciprocal and visible from both sides.
  await expect(page.getByText(/alternates with PGY-2 Cohort B/i).first()).toBeVisible();
  await expect(page.getByText(/alternates with PGY-2 Cohort A/i).first()).toBeVisible();

  // Put a resident in a cohort.
  const cohortCard = page.locator("li").filter({ hasText: "PGY-2 Cohort A" }).first();
  await cohortCard.getByRole("button", { name: /members/i }).click();
  const membersSheet = page.getByRole("dialog");
  await membersSheet
    .getByRole("button", { name: /^add$/i })
    .first()
    .click();
  await expect(membersSheet.getByRole("button", { name: /^remove$/i })).toBeVisible();
  // Reload rather than dismissing, so the grid below is read from a clean page
  // with exactly one dialog's worth of controls in the DOM.
  await page.goto("/admin/cohorts");

  // Assign the cohort to a block through the grid.
  const firstCell = page
    .getByRole("row")
    .filter({ hasText: "PGY-2 Cohort A" })
    .getByRole("button", { name: "—" })
    .first();
  await expect(firstCell).toBeVisible();
  await firstCell.click();
  const cellSheet = page.getByRole("dialog");
  await expect(cellSheet).toBeVisible();
  // The cell sheet has one select: the service for this cohort in this block.
  await cellSheet
    .getByRole("combobox")
    .first()
    .selectOption({ label: "General Medicine Wards" });
  await cellSheet.getByRole("button", { name: /^save$/i }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "PGY-2 Cohort A" }).getByText("General Medicine Wards"),
  ).toBeVisible();

  // --- The dashboard reflects all of it -------------------------------------
  await page.goto("/admin/scheduler");
  await expect(page.getByRole("heading", { name: "Scheduler" })).toBeVisible();
  await expect(page.getByText(/2 cohorts/i)).toBeVisible();
  await expect(page.getByText(/with coverage defined/i)).toBeVisible();
});

test("a resident cannot reach any of it", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  for (const path of ["/admin/scheduler", "/admin/cohorts", "/admin/services"]) {
    await page.goto(path);
    /* A refused page redirects home rather than rendering a dead end — the
       resident is sent somewhere they can actually use, with the refusal
       flagged. What matters here is that they never see the screen. */
    await expect(page, path).toHaveURL(/\/\?denied=1$/);
  }

  // And the API refuses outright rather than returning an empty list, which
  // would look like "you have no residents" instead of "not for you".
  for (const endpoint of ["/api/admin/roster", "/api/admin/cohorts"]) {
    const response = await page.request.get(endpoint);
    expect(response.status(), endpoint).toBe(403);
  }
});

test("a chief can plan, and sees phone numbers a resident never receives", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/scheduler");
  await expect(page.getByRole("heading", { name: "Scheduler" })).toBeVisible();

  // The roster endpoint includes the phone column for a chief…
  const asChief = await page.request.get("/api/admin/roster");
  expect(asChief.ok()).toBe(true);
  const chiefBody = await asChief.json();
  expect(chiefBody.roster.length).toBeGreaterThan(0);
  expect(chiefBody.roster[0]).toHaveProperty("phone");

  // …and a resident cannot call it at all.
  await signOut(page);
  await signIn(page, ACCOUNTS.alice);
  const asResident = await page.request.get("/api/admin/roster");
  expect(asResident.status()).toBe(403);
});

test("the scheduler is useful to a program that has configured nothing", async ({
  page,
}) => {
  /* The other fixture program has a resident and a shift but no cohorts, no
     blocks and no drafts. Every one of those has to say something better than
     an empty box. */
  await signIn(page, ACCOUNTS.otherAdmin);
  await page.goto("/admin/scheduler");

  await expect(page.getByRole("heading", { name: "Scheduler" })).toBeVisible();
  await expect(page.getByText(/no drafts in progress/i)).toBeVisible();
  // The empty states explain what the thing is, rather than reporting absence.
  await expect(page.getByText(/a draft is a schedule residents cannot see yet/i)).toBeVisible();
  await expect(page.getByText(/no block structure/i)).toBeVisible();
});
