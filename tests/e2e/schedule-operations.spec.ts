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
     unilaterally. The dates rather than the kind, because "Conference" is also
     the name of an option in the picker above. */
  await expect(page.getByText("Mon, Mar 1 – Wed, Mar 3")).toBeVisible({ timeout: 20_000 });
  /* `exact` on both: Playwright's default is a case-insensitive substring, and
     the explanatory copy on this screen says "once confirmed the schedule will
     not put you on a shift". The badge is the assertion, not the prose. */
  await expect(page.getByText("Requested", { exact: true })).toBeVisible();
  await expect(page.getByText("Confirmed", { exact: true })).toHaveCount(0);

  // And no way to confirm it: the control is not rendered, not merely disabled.
  await expect(page.getByRole("button", { name: /^confirm$/i })).toHaveCount(0);
});

test("a chief confirms an absence, and only they can", async ({ page }) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/availability");

  await expect(page.getByRole("heading", { level: 1, name: "Availability" })).toBeVisible();

  /* Recorded here as a request, so the confirm step has something to act on
     without depending on what another test left behind. */
  await page.getByRole("button", { name: /^add$/i }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("What").selectOption({ label: "Conference" });
  await sheet.getByLabel("First day").fill("2029-06-04");
  await sheet.getByLabel("Last day").fill("2029-06-06");
  await sheet.getByRole("button", { name: /^record$/i }).click();

  await expect(page.getByText("Requested", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("button", { name: /^confirm$/i }).first().click();
  await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });

  // And it can be taken back the same way.
  await page.getByRole("button", { name: /^unconfirm$/i }).first().click();
  await expect(page.getByText("Requested", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
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

test("a chief sets the coverage the generator reads, without managing services", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/services");

  /* The chief reaches the list — it is the way to each service's coverage —
     but the services themselves are program leadership's to add and rename. */
  await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible();
  await expect(page.getByRole("button", { name: /add service/i })).toHaveCount(0);

  await page.getByRole("link", { name: /configure/i }).first().click();

  /* The identity half is a summary, not a form with dead controls. */
  await expect(page.getByRole("heading", { name: /what this service is/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^save$/i })).toHaveCount(0);

  /* The coverage half is theirs, and it writes. This is the whole point: a
     coverage requirement is the generator's primary input, and the person who
     runs the generator is the person who has to be able to state it. */
  await page.getByRole("button", { name: /add a requirement/i }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("At least", { exact: true }).fill("2");
  await sheet.getByRole("button", { name: /^save$/i }).click();

  await expect(page.getByText(/needs 2 or more people/i).first()).toBeVisible({
    timeout: 20_000,
  });
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

test("a chief can build the rest of a draft again, which is what locking is for", async ({
  page,
}) => {
  /* The regression this guards: locks were reachable, listed, and described as
     surviving "the next regeneration" — and there was no control anywhere that
     regenerated an existing draft. The only route to the generator built a new
     one, so a scheduler could lock a resident's month and never find the button
     the lock was for. */
  await signIn(page, ACCOUNTS.chief);

  /* A second service, so this does not stack a requirement on top of the one
     the coverage test above already set — two weekday requirements on one
     service ask the programme for more people than it has, and an infeasible
     run is a different test. */
  await page.goto("/admin/services");
  await page.getByRole("link", { name: /configure/i }).nth(1).click();
  await page.getByRole("button", { name: /add a requirement/i }).first().click();
  const requirement = page.getByRole("dialog");
  await requirement.getByLabel("At least", { exact: true }).fill("1");
  await requirement.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/needs 1 or more people/i).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.goto("/admin/scheduler");
  await page.getByRole("button", { name: /start a draft/i }).click();
  const draft = page.getByRole("dialog");
  await draft.getByLabel("Name").fill("Regenerate test");
  await draft.getByLabel("Covers from").fill("2029-04-02");
  await draft.getByLabel("To", { exact: true }).fill("2029-04-06");
  await draft.getByRole("button", { name: /create draft/i }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Regenerate test" }),
  ).toBeVisible();
  await page.getByRole("link", { name: /open the grid/i }).click();

  await page.getByRole("button", { name: /build the rest again/i }).click();

  /* It says what it will keep before it does anything, because "regenerate"
     without that sentence is a button nobody presses on a schedule they have
     spent an evening on. */
  await expect(page.getByText(/nothing is locked, so the whole draft is rebuilt/i)).toBeVisible();

  await page.getByRole("button", { name: /^build it$/i }).click();

  /* What it filled, how good it is, and the seed that would reproduce it — a
     chief has to be able to tell why the generator did what it did, and a bare
     "done" does not answer that. */
  await expect(page.getByText(/filled \d+ of \d+ slot/i)).toBeVisible({ timeout: 30_000 });
  /* `\d+(\.\d+)?`, not `\d+`: the score is rounded to one decimal place by
     `round()` in `constraints/scoring.ts`, so it is a whole number only when it
     happens to land on one. This assertion was written as `\d+` and passed for
     weeks on scores like `95`, then failed the first time the generator
     returned `95.2` — the test was flaky in the data, not in the timing, which
     is the kind that looks like a real regression when it finally goes off. */
  await expect(page.getByText(/quality score \d+(\.\d+)? out of 100/i)).toBeVisible();
  await expect(page.getByText(/^seed \d+ · /i)).toBeVisible();

  await page.goto("/admin/scheduler/");
  await page.getByRole("link", { name: /regenerate test/i }).first().click();
  await page.getByRole("button", { name: /discard draft/i }).click();
  await page.getByRole("button", { name: /yes, discard this draft/i }).click();
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

  /* Somebody who is not already on it. The domain refuses "correcting" a shift
     to its current holder, which is right — that is not a correction — so the
     test has to read who holds it and choose somebody else, exactly as a
     person would. */
  const current = (await sheet.getByText(/^currently /i).textContent())!;
  const options = await sheet.getByLabel("Who works it now").locator("option").all();
  let chosen: string | null = null;
  for (const option of options) {
    const label = (await option.textContent())!.trim();
    if (label === "Nobody") continue;
    if (current.includes(label.split(" · ")[0])) continue;
    chosen = label;
    break;
  }
  expect(chosen, "somebody other than the current holder").not.toBeNull();
  await sheet.getByLabel("Who works it now").selectOption({ label: chosen! });
  await sheet.getByLabel("Why").fill("Sick leave from Monday; covering the gap.");
  await expect(submit).toBeEnabled();
  await submit.click();

  /* The result says what it did to the schedule, who was told, and it is on
     the list afterwards with the reason a reader can act on. */
  /* Scoped to the announcement, not to the word. Once the correction lands the
     page says "Corrected" twice — once as the result of what was just done and
     once as the badge on the row it created — and the two mean different
     things. The result is the one under test here. */
  const announcement = page.getByRole("status").filter({ hasText: "Corrected" });
  await expect(announcement).toBeVisible({ timeout: 20_000 });
  await expect(announcement.getByText(/told:/i)).toBeVisible();
  await expect(page.getByText(/sick leave from monday/i).first()).toBeVisible();
  await expect(page.getByText(/nothing has been corrected/i)).toHaveCount(0);
});
