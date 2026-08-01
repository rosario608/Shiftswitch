import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn } from "./helpers";

/**
 * How many taps the product actually costs, counted rather than estimated.
 *
 * A resident does this one-handed, on a phone, between patients, often at
 * night. Every tap is a chance to put the phone down and go back to the group
 * chat instead — which is the thing this product has to beat, not a
 * spreadsheet.
 *
 * ## How it counts
 *
 * A real click listener in the page, in the capture phase, incremented on every
 * click anywhere. The count lives in `sessionStorage` so it survives the
 * navigations the flow makes. Nothing here counts what the *test* did — it
 * counts what the browser saw, which is why typing a note is not a tap and
 * opening a sheet is.
 *
 * ## What the numbers mean
 *
 * They are ceilings, asserted. If a change adds a step, this fails and names
 * the flow. The recorded before/after is in `docs/AI_PROJECT_STATE.md` under
 * **Decisions → What the product costs in taps**.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetFixture();
});

const COUNTER = `
  if (!window.__tapCounterInstalled) {
    window.__tapCounterInstalled = true;
    document.addEventListener(
      "click",
      () => {
        const now = Number(sessionStorage.getItem("__taps") ?? "0") + 1;
        sessionStorage.setItem("__taps", String(now));
      },
      true,
    );
  }
`;

async function startCounting(page: Page) {
  await page.addInitScript(COUNTER);
  await page.evaluate(COUNTER);
  await page.evaluate(() => sessionStorage.setItem("__taps", "0"));
}

async function taps(page: Page): Promise<number> {
  return page.evaluate(() => Number(sessionStorage.getItem("__taps") ?? "0"));
}

test("posting a shift, from cold open", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await startCounting(page);

  /* The next shift is on screen already, with its own post button, so the
     resident never chooses from a list of their own shifts to give one away —
     the one they are looking at is the one they mean. */
  await page.getByRole("button", { name: /post this shift/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^post it$/i }).click();
  await page.waitForURL(/\/switches\/[0-9a-f-]{36}$/);

  const count = await taps(page);
  expect(count, "cold open → shift posted").toBeLessThanOrEqual(2);
  console.log(`[taps] post a shift: ${count}`);
});

test("offering one of yours on a posted shift, from cold open", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await startCounting(page);

  /* Straight off the home screen: the shifts somebody can actually take are
     there, ranked, so finding one is not a separate journey through a board. */
  await page
    .getByRole("region", { name: /shifts you can take/i })
    .getByRole("listitem")
    .first()
    .getByRole("link")
    .click();
  /* The button names the shift it will offer — the best-scoring one that passes
     the rules — so agreeing with the match costs nothing. Choosing a different
     shift is still one tap away, behind "Offer a different shift". */
  await page.getByRole("button", { name: /^offer \w+, \w+ \d+ ·/i }).click();
  await expect(page.getByText(/your offer/i).first()).toBeVisible();

  const count = await taps(page);
  expect(count, "cold open → offer sent").toBeLessThanOrEqual(2);
  console.log(`[taps] offer on a posted shift: ${count}`);
});

test("accepting an offer, from cold open", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await startCounting(page);

  /* A single waiting offer is decided on the home screen. One offer is a
     yes-or-no; navigating somewhere to answer it spends a tap on transport. */
  await page
    .getByRole("region", { name: /needs you/i })
    .getByRole("button", { name: /^accept$/i })
    .first()
    .click();
  /* The confirmation stays. Accepting hands somebody else your call shift, and
     the sheet spells out what you give and what you receive before anything is
     written — that is the one tap here worth paying for. */
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^complete switch$/i })
    .click();

  const count = await taps(page);
  expect(count, "cold open → offer accepted").toBeLessThanOrEqual(2);
  console.log(`[taps] accept an offer: ${count}`);
});

test("naming a shift and posting it, from cold open", async ({ page }) => {
  /* The resident whose programme has uploaded nothing. Posting a shift that
     already exists was always two taps; naming one and posting it had been
     three screens — the week-entry grid, then the schedule, then the post
     sheet — which is the version nobody does at the end of a call shift. */
  await signIn(page, ACCOUNTS.newcomer);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await startCounting(page);

  await page.getByRole("button", { name: /post a shift i'm working/i }).click();

  /* Typing is not a tap, and the sheet opens with a working answer in every
     field, so a resident who agrees with all of it types nothing at all. Here
     the date is set explicitly to keep the test independent of today. */
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/which day/i).fill(
    new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10),
  );
  await dialog.getByLabel(/what is it/i).fill("MICU");

  await dialog.getByRole("button", { name: /^post it$/i }).click();
  await page.waitForURL(/\/switches\/[0-9a-f-]{36}$/);

  const count = await taps(page);
  expect(count, "cold open → shift named and posted").toBeLessThanOrEqual(2);
  console.log(`[taps] name a shift and post it: ${count}`);
});
