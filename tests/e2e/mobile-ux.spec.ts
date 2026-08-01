import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetFixture, signIn } from "./helpers";

/**
 * Mobile-first behaviour: no horizontal scrolling, comfortable tap targets,
 * working bottom navigation, honest offline handling, and PWA installability.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetFixture();
});

const PAGES = ["/", "/schedule", "/switches", "/notifications", "/profile"];

test("no page scrolls horizontally on a phone-sized viewport", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `${path} overflows horizontally`).toBeLessThanOrEqual(
      overflow.clientWidth + 1,
    );
  }
});

test("no scheduling screen scrolls horizontally on a phone either", async ({ page }) => {
  /* The admin screens are the dense ones — a grid with services down the side
     and days across the top — and they are used on a phone between rounds as
     often as on a laptop. A page that scrolls sideways as a *page* rather than
     inside its own table is one where the navigation walks off the edge. */
  await signIn(page, ACCOUNTS.chief);
  for (const path of [
    "/admin",
    "/admin/scheduler",
    "/admin/coverage",
    "/admin/availability",
    "/admin/directory",
    "/admin/corrections",
    "/admin/services",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `${path} overflows horizontally`).toBeLessThanOrEqual(
      overflow.clientWidth + 1,
    );
  }
});

test("primary controls meet a 44px tap target", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const primary = page.getByRole("button", { name: /post this shift/i });
  const box = await primary.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  // Every bottom-navigation item too.
  const navLinks = page.getByRole("navigation", { name: "Primary" }).getByRole("link");
  const count = await navLinks.count();
  expect(count).toBe(5);
  for (let index = 0; index < count; index += 1) {
    const navBox = await navLinks.nth(index).boundingBox();
    expect(navBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("bottom navigation moves between the main areas", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });

  await nav.getByRole("link", { name: "Schedule" }).click();
  await expect(page).toHaveURL(/\/schedule$/);
  await expect(page.getByRole("heading", { name: /my schedule/i })).toBeVisible();

  await nav.getByRole("link", { name: "Switches" }).click();
  await expect(page).toHaveURL(/\/switches$/);

  await nav.getByRole("link", { name: "Alerts" }).click();
  await expect(page).toHaveURL(/\/notifications$/);

  await nav.getByRole("link", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/profile$/);

  await nav.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("going offline is announced and blocks schedule changes honestly", async ({
  page,
  context,
}) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));

  await expect(
    page.getByText(/you.re offline\. schedule changes require an internet connection\./i),
  ).toBeVisible();

  // The post sheet refuses to submit rather than pretending to succeed.
  await page.getByRole("button", { name: /post this shift/i }).click();
  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByText(/schedule changes require an internet connection/i),
  ).toBeVisible();
  await expect(sheet.getByRole("button", { name: /^post it$/i })).toBeDisabled();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(sheet.getByRole("button", { name: /^post it$/i })).toBeEnabled();
});

test("the web app manifest describes an installable app", async ({ page }) => {
  const response = await page.request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(
    true,
  );

  for (const icon of manifest.icons) {
    const iconResponse = await page.request.get(icon.src);
    expect(iconResponse.ok(), icon.src).toBe(true);
  }

  const serviceWorker = await page.request.get("/sw.js");
  expect(serviceWorker.ok()).toBe(true);
  const source = await serviceWorker.text();
  // The service worker must never cache API traffic.
  expect(source).toContain('url.pathname.startsWith("/api/")');
});

test("empty states explain what to do next", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/switches?tab=history");
  await expect(page.getByText(/no completed switches yet/i)).toBeVisible();
  await page.goto("/notifications");
  await expect(
    page.getByText(/no notifications yet|you.re all caught up/i).first(),
  ).toBeVisible();
});

test("the schedule shows an overnight shift as one shift", async ({ page }) => {
  await signIn(page, ACCOUNTS.bob);
  await page.goto("/schedule");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("7 PM – 7 AM (+1)").first()).toBeVisible();
});

test("keyboard users can reach the main content and operate a sheet", async ({ page }) => {
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /skip to main content/i })).toBeFocused();

  await page.getByRole("button", { name: /post this shift/i }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
