import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn, signOut } from "./helpers";

/**
 * The workflow one person has to be able to walk on their own:
 *
 *   sign in as an administrator → create a service → invite a synthetic
 *   resident → open the invitation → accept it → land in the resident
 *   experience → confirm the role and program → switch back → invite a chief →
 *   confirm the chief sees more → confirm nobody sees what they should not.
 *
 * The invitation is the real thing throughout: real token, real expiry, real
 * acceptance transaction. Only Google is substituted, by the development
 * sandbox, because a second Google account is the one part of this a single
 * person genuinely cannot supply.
 */
test.describe.configure({ mode: "serial" });

const SYNTHETIC_RESIDENT = "e2e.synthetic.resident@hospital.org";
const SYNTHETIC_CHIEF = "e2e.synthetic.chief@hospital.org";

let residentInvite = "";
let chiefInvite = "";
let serviceId = "";

test.beforeAll(() => {
  resetFixture();
});

test("an administrator can find and create a service", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);

  // Discoverable by navigation, not by knowing the URL.
  await page.goto("/admin");
  const nav = page.getByRole("navigation", { name: "Administration" });
  await expect(nav.getByRole("link", { name: "Services" })).toBeVisible();
  await nav.getByRole("link", { name: "Services" }).click();
  await expect(page).toHaveURL(/\/admin\/services/);
  await expect(page.getByRole("button", { name: /add service/i }).first()).toBeVisible();

  const created = await page.request.post("/api/admin/services", {
    data: { kind: "service", name: "Palliative Care", abbreviation: "PALL" },
  });
  expect(created.status()).toBe(201);
  serviceId = (await created.json()).record.id;

  // A duplicate that differs only in case is refused, with the existing name.
  const duplicate = await page.request.post("/api/admin/services", {
    data: { kind: "service", name: "palliative care" },
  });
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).error.message).toContain("Palliative Care");

  // It shows up straight away, and is usable for a shift.
  const listed = await (await page.request.get("/api/admin/services")).json();
  expect(
    (listed.services as Array<{ name: string }>).some((s) => s.name === "Palliative Care"),
  ).toBe(true);

  await page.reload();
  await expect(page.getByText("Palliative Care")).toBeVisible();
  await expect(page.getByText("PALL")).toBeVisible();
});

test("a service with upcoming shifts cannot be deactivated by accident", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);
  const users = await (await page.request.get("/api/admin/users")).json();
  const alice = users.users.find((u: { email: string }) => u.email === ACCOUNTS.alice);

  const future = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
  const shift = await page.request.post("/api/admin/shifts", {
    data: {
      serviceId,
      date: future,
      startTime: "07:00",
      endTime: "19:00",
      endsNextDay: false,
      location: "Ward 9",
      shiftType: "day",
      requiredPgyMin: 1,
      requiredPgyMax: 10,
      tradeable: true,
      approvalRequired: false,
      residentId: alice.resident_id,
    },
  });
  expect(shift.status()).toBe(201);

  const refused = await page.request.patch(`/api/admin/services/${serviceId}`, {
    data: { kind: "service", active: false },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.message).toMatch(/upcoming shift/i);

  // Renaming is always allowed and moves nothing.
  const renamed = await page.request.patch(`/api/admin/services/${serviceId}`, {
    data: { kind: "service", name: "Palliative Medicine" },
  });
  expect(renamed.ok()).toBe(true);
  expect((await renamed.json()).record.shift_count).toBe(1);
});

test("the invite field accepts a pasted list and marks up what is wrong", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/admin/users");
  await page.getByRole("button", { name: /invite people/i }).click();

  const field = page.getByLabel("Who are you inviting?");
  await expect(field).toBeVisible();

  // Typing one address and pressing Enter.
  await field.click();
  await field.fill("first@hospital.org");
  await field.press("Enter");
  await expect(page.getByTestId("email-chip")).toHaveCount(1);

  // A comma-separated pair, committed by the comma itself.
  await field.fill("second@hospital.org,");
  await expect(page.getByTestId("email-chip")).toHaveCount(2);

  // A semicolon-separated pair.
  await field.fill("third@hospital.org;");
  await expect(page.getByTestId("email-chip")).toHaveCount(3);

  // Something that is not an address at all is kept, and flagged.
  await field.fill("not-an-address");
  await field.press("Enter");
  await expect(page.getByTestId("email-chip")).toHaveCount(4);
  await expect(page.locator('[data-testid="email-chip"][data-valid="false"]')).toHaveCount(
    1,
  );
  await expect(page.getByText(/does not look right/i)).toBeVisible();

  // Inviting is blocked while it is there. The submit button counts only the
  // usable addresses, so it reads "Invite 3 people" even with four chips.
  await expect(page.getByRole("button", { name: /^Invite 3 people$/ })).toBeDisabled();

  // Removing it individually unblocks.
  await page.getByRole("button", { name: "Remove not-an-address" }).click();
  await expect(page.getByTestId("email-chip")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /Invite 3 people/ })).toBeEnabled();

  // A duplicate is flagged but not fatal.
  await field.fill("first@hospital.org");
  await field.press("Enter");
  await expect(
    page.locator('[data-testid="email-chip"][data-duplicate="true"]'),
  ).toHaveCount(1);
  await expect(page.getByText(/duplicate/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Invite 3 people/ })).toBeEnabled();

  // Backspace on an empty field puts the last one back for editing rather than
  // deleting it outright.
  await field.click();
  await expect(field).toHaveValue("");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("email-chip")).toHaveCount(3);
  await expect(field).toHaveValue("first@hospital.org");
});

test("the administrator invites a synthetic resident and a synthetic chief", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);

  const resident = await page.request.post("/api/admin/invitations", {
    data: { emails: [SYNTHETIC_RESIDENT], role: "resident", pgyLevel: 2 },
  });
  expect(resident.status()).toBe(201);
  residentInvite = (await resident.json()).created[0].url;

  const chief = await page.request.post("/api/admin/invitations", {
    data: { emails: [SYNTHETIC_CHIEF], role: "chief" },
  });
  expect(chief.status()).toBe(201);
  chiefInvite = (await chief.json()).created[0].url;

  // The environment says plainly that nothing was emailed.
  await page.goto("/admin/users");
  await expect(page.getByText(/no email is sent from here/i).first()).toBeVisible();
});

test("the synthetic resident accepts and lands in the resident experience", async ({
  page,
}) => {
  // Opening the link signed out shows the program and the invited address.
  await page.goto(residentInvite);
  await expect(page.getByText(SYNTHETIC_RESIDENT).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /continue with google/i })).toBeVisible();

  // The sandbox stands in for Google.
  const token = residentInvite.split("/invite/")[1];
  const accepted = await page.request.post("/api/dev/accept-invitation", {
    data: { token, fullName: "Sam Synthetic" },
  });
  expect(accepted.ok()).toBe(true);
  const body = await accepted.json();
  expect(body.user.email).toBe(SYNTHETIC_RESIDENT);
  expect(body.user.role).toBe("resident");

  // They are now signed in as that person, in the right program.
  const session = await (await page.request.get("/api/session")).json();
  expect(session.user.email).toBe(SYNTHETIC_RESIDENT);
  expect(session.user.role).toBe("resident");
  expect(session.program.name).toBeTruthy();
  expect(session.residentId).toBeTruthy();

  // And they see a resident's app, not an administrator's.
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login|\/pending/);
  await page.goto("/admin/users");
  await expect(page).not.toHaveURL(/\/admin\/users/);

  // The same link cannot be used twice.
  const again = await page.request.post("/api/dev/accept-invitation", {
    data: { token },
  });
  expect(again.status()).toBe(404);
});

test("a resident can reach nothing administrative", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);
  for (const path of [
    "/api/admin/users",
    "/api/admin/services",
    "/api/admin/invitations",
    "/api/admin/rules",
    "/api/admin/analytics",
    "/api/admin/audit",
    "/api/admin/shifts",
    "/api/approvals",
  ]) {
    expect((await page.request.get(path)).status(), path).toBe(403);
  }
  expect(
    (
      await page.request.post("/api/admin/services", {
        data: { kind: "service", name: "Sneaky" },
      })
    ).status(),
  ).toBe(403);
  expect((await page.request.post("/api/admin/maintenance")).status()).toBe(403);
  // The program settings route has no GET; the write is what matters anyway.
  expect(
    (await page.request.patch("/api/admin/program", { data: { name: "Mine now" } }))
      .status(),
  ).toBe(403);
});

test("a chief sees the schedule and the approvals queue, and nothing else", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.chief);

  // Allowed.
  for (const path of [
    "/api/approvals",
    "/api/admin/shifts",
    "/api/admin/audit",
    "/api/admin/analytics",
    "/api/admin/import/template",
  ]) {
    expect((await page.request.get(path)).ok(), path).toBe(true);
  }

  // Refused, and the refusal says what they are rather than just "no".
  for (const path of [
    "/api/admin/users",
    "/api/admin/services",
    "/api/admin/invitations",
    "/api/admin/rules",
  ]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(403);
    // The refusal explains what the area is for, so it is actionable rather
    // than a bare "forbidden".
    expect((await response.json()).error.message, path).toMatch(
      /program leadership|chief resident/i,
    );
  }

  // The navigation reflects it: schedule yes, users no.
  await page.goto("/admin");
  const nav = page.getByRole("navigation", { name: "Administration" });
  // Exact, because "Scheduler" contains "Schedule" and they are two links to
  // two different screens: the shift editor and the planning dashboard.
  await expect(nav.getByRole("link", { name: "Schedule", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Approvals" })).toBeVisible();
  // A chief plans the schedule, so the scheduler and the cohort grid are theirs.
  await expect(nav.getByRole("link", { name: "Scheduler", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Cohorts & blocks" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Users & roles" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Services" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Program settings" })).toHaveCount(0);
});

test("program leadership can actually reach the admin area from the app shell", async ({
  page,
}) => {
  /* Regression. The header link and the shift/switch detail pages tested
     `role === "chief" || role === "admin"` literally, so a PD or an APD signed
     in, saw a resident's app, and had no way to reach administration at all
     unless they knew the URL. Both now derive from a capability. */
  for (const [account, badge] of [
    [ACCOUNTS.pd, "PD"],
    [ACCOUNTS.apd, "APD"],
    [ACCOUNTS.chief, "Chief"],
    [ACCOUNTS.admin, "Admin"],
  ] as const) {
    await signOut(page);
    await signIn(page, account);
    await page.goto("/");
    const link = page.getByRole("link", { name: badge });
    await expect(link, `${account} should see the admin link`).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/admin/);
  }

  // A resident has no such link, and no admin area behind it.
  await signOut(page);
  await signIn(page, ACCOUNTS.bob);
  await page.goto("/");
  for (const badge of ["PD", "APD", "Chief", "Admin"]) {
    await expect(page.getByRole("link", { name: badge })).toHaveCount(0);
  }
  await page.goto("/admin");
  await expect(page).not.toHaveURL(/\/admin/);
});

test("program leadership is named correctly on their own profile", async ({ page }) => {
  await signIn(page, ACCOUNTS.pd);
  await page.goto("/profile");
  await expect(page.getByText("Program Director")).toBeVisible();

  await signOut(page);
  await signIn(page, ACCOUNTS.apd);
  await page.goto("/profile");
  await expect(page.getByText("Associate Program Director")).toBeVisible();
});

test("an APD manages people and services but not the program's settings", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.apd);

  for (const path of [
    "/api/admin/users",
    "/api/admin/services",
    "/api/admin/invitations",
    "/api/admin/rules",
    "/api/admin/contacts",
  ]) {
    expect((await page.request.get(path)).ok(), path).toBe(true);
  }
  expect(
    (await page.request.patch("/api/admin/program", { data: { name: "APD rename" } }))
      .status(),
  ).toBe(403);
  expect((await page.request.post("/api/admin/maintenance")).status()).toBe(403);

  // An APD may invite a resident or a chief, but not a PD or an administrator.
  const allowed = await page.request.post("/api/admin/invitations", {
    data: { emails: ["e2e.apd.invited@hospital.org"], role: "chief" },
  });
  expect(allowed.status()).toBe(201);

  for (const role of ["apd", "pd", "admin"]) {
    const refused = await page.request.post("/api/admin/invitations", {
      data: { emails: [`e2e.escalate.${role}@hospital.org`], role },
    });
    expect(refused.status(), role).toBe(403);
    expect((await refused.json()).error.message).toMatch(/Associate Program Director/);
  }
});

test("a PD can change the program, and cannot appoint a peer", async ({ page }) => {
  await signIn(page, ACCOUNTS.pd);
  const renamed = await page.request.patch("/api/admin/program", {
    data: { name: "E2E Internal Medicine" },
  });
  expect(renamed.ok()).toBe(true);
  expect((await page.request.post("/api/admin/maintenance")).status()).toBe(403);

  const users = await (await page.request.get("/api/admin/users")).json();
  const bob = users.users.find((u: { email: string }) => u.email === ACCOUNTS.bob);
  const admin = users.users.find((u: { email: string }) => u.email === ACCOUNTS.admin);

  // A PD may promote a resident to APD…
  const promoted = await page.request.patch(`/api/admin/users/${bob.id}`, {
    data: { role: "apd", programId: bob.program_id },
  });
  expect(promoted.ok()).toBe(true);

  // …but not to PD or administrator, and cannot touch the administrator at all.
  for (const role of ["pd", "admin"]) {
    const refused = await page.request.patch(`/api/admin/users/${bob.id}`, {
      data: { role, programId: bob.program_id },
    });
    expect(refused.status(), role).toBe(403);
  }
  const lateral = await page.request.patch(`/api/admin/users/${admin.id}`, {
    data: { role: "resident", programId: admin.program_id },
  });
  expect(lateral.status()).toBe(403);

  // Put Bob back.
  await page.request.patch(`/api/admin/users/${bob.id}`, {
    data: { role: "resident", programId: bob.program_id },
  });
});

test("nobody can change their own role", async ({ page }) => {
  // Each tries a role different from their own — patching yourself to the role
  // you already hold is a no-op and is allowed, which is not what this is about.
  for (const [account, attempted] of [
    [ACCOUNTS.admin, "pd"],
    [ACCOUNTS.pd, "admin"],
    [ACCOUNTS.apd, "pd"],
  ] as const) {
    await signOut(page);
    await signIn(page, account);
    const session = await (await page.request.get("/api/session")).json();
    const response = await page.request.patch(`/api/admin/users/${session.user.id}`, {
      data: { role: attempted, programId: session.program.id },
    });
    expect(response.status(), account).toBe(422);
    expect((await response.json()).error.message).toMatch(/cannot change your own role/i);

    // …and the role is unchanged.
    const after = await (await page.request.get("/api/session")).json();
    expect(after.user.role, account).toBe(session.user.role);
  }
});

test("the synthetic chief accepts and gets a chief's capabilities", async ({ page }) => {
  const token = chiefInvite.split("/invite/")[1];
  const accepted = await page.request.post("/api/dev/accept-invitation", {
    data: { token, fullName: "Kit Synthetic" },
  });
  expect(accepted.ok()).toBe(true);
  expect((await accepted.json()).user.role).toBe("chief");

  expect((await page.request.get("/api/approvals")).ok()).toBe(true);
  expect((await page.request.get("/api/admin/shifts")).ok()).toBe(true);
  expect((await page.request.get("/api/admin/users")).status()).toBe(403);

  // A chief holds a schedule, so they have a resident record and can trade.
  const session = await (await page.request.get("/api/session")).json();
  expect(session.residentId).toBeTruthy();
});

test("switching back to the administrator works cleanly", async ({ page }) => {
  await signOut(page);
  await signIn(page, ACCOUNTS.admin);
  const session = await (await page.request.get("/api/session")).json();
  expect(session.user.email).toBe(ACCOUNTS.admin);
  expect(session.user.role).toBe("admin");

  // Both synthetic accounts are now real members, visible with their roles.
  const users = await (await page.request.get("/api/admin/users")).json();
  const byEmail = Object.fromEntries(
    (users.users as Array<{ email: string; role: string }>).map((u) => [u.email, u.role]),
  );
  expect(byEmail[SYNTHETIC_RESIDENT]).toBe("resident");
  expect(byEmail[SYNTHETIC_CHIEF]).toBe("chief");

  // And both invitations show as accepted rather than still pending.
  const invitations = await (await page.request.get("/api/admin/invitations")).json();
  const accepted = (invitations.invitations as Array<{ email: string; status: string }>)
    .filter((i) => [SYNTHETIC_RESIDENT, SYNTHETIC_CHIEF].includes(i.email))
    .map((i) => i.status);
  expect(accepted).toEqual(["accepted", "accepted"]);
});

test("an expired or revoked invitation cannot be accepted, even in the sandbox", async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.admin);

  const created = await page.request.post("/api/admin/invitations", {
    data: { emails: ["e2e.revoked.invitee@hospital.org"], role: "resident" },
  });
  const { id, url } = (await created.json()).created[0];
  const token = url.split("/invite/")[1];

  await page.request.delete(`/api/admin/invitations/${id}`);

  const refused = await page.request.post("/api/dev/accept-invitation", {
    data: { token },
  });
  expect(refused.status()).toBe(404);

  // The public page says the same neutral thing.
  await signOut(page);
  await page.goto(url);
  await expect(page.getByText(/may have expired, been cancelled/i)).toBeVisible();
});
