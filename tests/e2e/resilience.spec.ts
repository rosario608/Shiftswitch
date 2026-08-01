import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn } from "./helpers";

/**
 * What a resident sees when things go wrong, in a real browser.
 *
 * The unit tests assert the wording and the taxonomy. What only a browser can
 * show is that the wording *arrives* — that a severed network produces the
 * honest sentence on screen rather than a spinner that never resolves, that a
 * broken screen keeps the navigation, and that the diagnostic page tells an
 * administrator something they can act on.
 *
 * The network is severed and throttled here, not simulated. `page.route` with
 * an abort is the closest a test gets to hospital wifi.
 */
test.beforeAll(() => {
  resetFixture();
});

test("the health endpoint answers without a session, and says what it is", async ({
  request,
}) => {
  /* Unauthenticated on purpose: a monitor cannot hold a session, and the first
     thing that breaks when the database is down is the ability to sign in. */
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(["ok", "degraded"]).toContain(body.status);

  const names = (body.components as Array<{ name: string }>).map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining(["database", "migrations", "auth"]));

  const migrations = (body.components as Array<{ name: string; status: string }>).find(
    (c) => c.name === "migrations",
  )!;
  expect(migrations.status).toBe("ok");

  // Never cached — a cached health check lies during the minute somebody watches it.
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("the health endpoint says nothing about any person", async ({ request }) => {
  const text = await (await request.get("/api/health")).text();
  for (const forbidden of ["hospital.org", "postgres://", "@", "Alice", "Bob"]) {
    expect(text, `health payload contains ${forbidden}`).not.toContain(forbidden);
  }
});

test("every response carries an id a resident can read out", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  const response = await page.request.get("/api/dashboard");
  const id = response.headers()["x-request-id"];
  expect(id, "x-request-id on a successful response").toBeTruthy();
  /* Six characters, and none of the ones people misread. */
  expect(id).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
});

test("a refusal carries the same id, in the body where the app can show it", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.alice);
  const response = await page.request.get("/api/admin/users");
  expect(response.status()).toBe(403);
  const body = await response.json();
  expect(body.error.requestId).toBeTruthy();
  expect(response.headers()["x-request-id"]).toBe(body.error.requestId);
});

test("a mutation with the network severed says it does not know, not that it failed", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/profile");

  await expect(page.getByRole("heading", { name: /when you are away/i })).toBeVisible();

  /* Severed *after* the page has loaded and only for the write, so this is the
     mid-flight case rather than the offline one: the request leaves and
     nothing comes back. */
  await page.route("**/api/availability", (route) => route.abort("connectionfailed"));

  await page.getByRole("button", { name: /^add$/i }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("What").selectOption({ label: "Conference" });
  await sheet.getByLabel("First day").fill("2030-05-01");
  await sheet.getByLabel("Last day").fill("2030-05-02");
  await sheet.getByRole("button", { name: /^record$/i }).click();

  /* The honest outcome. Not "that failed" — the request may have arrived — and
     emphatically not a spinner that never resolves. */
  await expect(page.getByText(/don't know if that went through/i)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/may or may not have gone through/i)).toBeVisible();

  /* And the way to find out is offered, rather than "try again" — which is
     what would make somebody repeat an action that already happened. */
  await expect(page.getByRole("button", { name: /reload and check/i })).toBeVisible();
});

test("a slow network shows progress and then resolves, never an endless spinner", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: /when you are away/i })).toBeVisible();

  // Throttled, not severed: two seconds of latency on the write.
  await page.route("**/api/availability", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
  });

  await page.getByRole("button", { name: /^add$/i }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("What").selectOption({ label: "Conference" });
  await sheet.getByLabel("First day").fill("2030-07-01");
  await sheet.getByLabel("Last day").fill("2030-07-02");
  await sheet.getByRole("button", { name: /^record$/i }).click();

  // It completes. The assertion that matters is that it ends at all.
  await expect(page.getByText("Mon, Jul 1 – Tue, Jul 2")).toBeVisible({ timeout: 30_000 });
});

test("an administrator can read a plain-language verdict and copy a report", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/admin/diagnostics");

  await expect(page.getByRole("heading", { level: 1, name: "Diagnostics" })).toBeVisible();

  /* A sentence, not a table of ticks to interpret. The database is up in this
     fixture, so the verdict is either "everything is working" or the degraded
     one about email — never the failed one. */
  await expect(
    page.getByText(/everything is working|needs attention when convenient/i),
  ).toBeVisible();

  // The report exists, is complete, and is the thing to send on.
  const report = page.getByLabel("Diagnostic report");
  await expect(report).toBeVisible();
  const text = await report.inputValue();
  expect(text).toContain("ShiftSwitch diagnostic report");
  expect(text).toContain("[OK] Database schema");
  expect(text).toContain("Release:");

  /* And it says nothing about anybody. This is the assertion that matters most
     on this page: it is written to be pasted into a message. */
  expect(text).not.toContain("@");
  expect(text).not.toContain("postgres://");

  await expect(page.getByRole("button", { name: /check again/i })).toBeVisible();
});

test("a resident cannot reach the diagnostics page", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/admin/diagnostics");
  await expect(page).toHaveURL(/\/\?denied=1$/);
});

test("a chief cannot either — it reports the shape of the deployment", async ({ page }) => {
  await signIn(page, ACCOUNTS.chief);
  await page.goto("/admin/diagnostics");
  await expect(page).toHaveURL(/\/\?denied=1$/);
  expect((await page.request.post("/api/admin/diagnostics")).status()).toBe(403);
});

test("a crash report reaches the server and names no one", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/switches");

  /* The route's contract, exercised end to end: it accepts a report from a
     signed-in browser, answers 202, and the payload it accepts has no field
     for a component tree, props or state. The *scrubbing* of the route — the
     part that turns `/switches/9f2c…` into `/switches/:id` — is covered by
     `tests/unit/offline.test.ts`, which can assert it directly rather than
     through a contrived crash. */
  const response = await page.request.post("/api/client-errors", {
    data: {
      name: "TypeError",
      message: "cannot read properties of undefined",
      route: "/switches/:id",
      kind: "render",
    },
  });

  expect(response.status()).toBe(202);
  expect((await response.json()).accepted).toBe(true);

  // A malformed report is absorbed, never answered with an error a client
  // could loop on.
  const malformed = await page.request.post("/api/client-errors", {
    data: { nonsense: true },
  });
  expect(malformed.status()).toBe(202);
  expect((await malformed.json()).accepted).toBe(false);
});
