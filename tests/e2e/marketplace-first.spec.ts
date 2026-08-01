import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn } from "./helpers";

/**
 * The two paths that have to work before a programme is set up, in a browser.
 *
 * The domain functions behind both are driven end to end by
 * `tests/integration/marketplace-first.test.ts`, which is where the state
 * assertions live. What this adds is the part that test cannot reach: that a
 * resident on a phone can actually *find* these things, and that the screen
 * says what the code does.
 *
 * `e2e.newcomer@hospital.org` has no shifts at all — nothing has been uploaded
 * for them — which is the resident this product opens on.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetFixture();
});

test("a resident with no schedule posts a shift, and a colleague takes it", async ({
  page,
  browser,
}) => {
  await signIn(page, ACCOUNTS.newcomer);
  await page.goto("/");

  /* The empty state teaches rather than dead-ends. It used to say the shifts
     would appear when the programme published the schedule, which is a fine
     sentence and no help at all to somebody whose programme has not. */
  await expect(page.getByText(/don't have to wait for your program/i)).toBeVisible();

  await page.getByRole("button", { name: /post a shift i'm working/i }).click();
  const dialog = page.getByRole("dialog");

  /* Said before they commit: this is their word, not the programme's. */
  await expect(dialog.getByText(/as entered by you/i)).toBeVisible();

  const date = new Date(Date.now() + 11 * 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel(/which day/i).fill(date);
  await dialog.getByLabel(/what is it/i).fill("Night float");
  await dialog.getByRole("button", { name: /^post it$/i }).click();

  await page.waitForURL(/\/switches\/[0-9a-f-]{36}$/);
  const switchUrl = page.url();
  await expect(page.getByText(/night float/i).first()).toBeVisible();

  /* A colleague sees it on the board and offers one of theirs. Bob has shifts
     from the fixture, so this is the ordinary path meeting a shift that was
     never in anybody's schedule file. */
  const otherContext = await browser.newContext();
  const bob = await otherContext.newPage();
  await signIn(bob, ACCOUNTS.bob);
  await bob.goto(switchUrl);
  await bob.getByRole("button", { name: /^offer \w+, \w+ \d+ ·/i }).click();
  await expect(bob.getByText(/your offer/i).first()).toBeVisible();

  /* And the person who posted it can accept. */
  await page.goto(switchUrl);
  await page.getByRole("button", { name: /^accept$/i }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^complete switch$/i })
    .click();
  await expect(page.getByText(/switch complete|completed/i).first()).toBeVisible();

  await otherContext.close();
});

test("assisted import says plainly when it is not configured", async ({ page }) => {
  /* No `ANTHROPIC_API_KEY` in the test environment, which is the state most
     deployments start in. The screen has to say so and leave the template path
     alone — a feature that is quietly missing is worse than one that explains
     itself. */
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/import");

  await expect(
    page.getByText(/reading a messy file is not set up here/i),
  ).toBeVisible();
  await expect(page.getByText(/anthropic api key/i)).toBeVisible();

  /* The path that needs nothing is untouched and still on the screen. */
  await expect(page.getByRole("link", { name: /download template/i })).toBeVisible();
});
