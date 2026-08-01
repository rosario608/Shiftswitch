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

test("nothing breaks at the smallest width a phone still ships with", async ({
  page,
}) => {
  /* 320 CSS pixels: an iPhone SE in display-zoom, and the width every mobile
     guideline still treats as the floor. Pixel 7 is 412, so the whole suite
     above can pass while the narrowest real phone in the programme has the
     navigation walking off the edge. */
  await page.setViewportSize({ width: 320, height: 640 });
  await signIn(page, ACCOUNTS.chief);

  for (const path of [...PAGES, "/admin", "/admin/coverage", "/admin/scheduler"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `${path} overflows at 320px`).toBeLessThanOrEqual(
      overflow.clientWidth + 1,
    );
  }

  // The bottom navigation still fits five items with usable targets.
  await page.goto("/");
  const navLinks = page.getByRole("navigation", { name: "Primary" }).getByRole("link");
  const count = await navLinks.count();
  for (let index = 0; index < count; index += 1) {
    const box = await navLinks.nth(index).boundingBox();
    expect(box?.height ?? 0, `nav item ${index} is too short at 320px`).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0, `nav item ${index} is too narrow at 320px`).toBeGreaterThanOrEqual(40);
  }
});

test("body text and the primary button meet WCAG AA contrast", async ({ page }) => {
  /* Measured from the rendered pixels rather than read off the palette, so a
     Tailwind class that resolves differently in context is caught. AA is 4.5:1
     for body text; the large heading is checked at the same bar rather than the
     3:1 large-text allowance, because "large" here is 24px and the people
     reading it are tired. */
  await signIn(page, ACCOUNTS.alice);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const ratios = await page.evaluate(() => {
    /* Through a canvas, because the palette is authored in `oklch()` and that
       is what `getComputedStyle` hands back. Parsing the three numbers out of
       an oklch string as if they were RGB is how this test first "found" a
       1.49:1 heading that is in fact near-black on white. The canvas normalises
       any CSS colour the browser accepts to eight-bit RGBA, which is the space
       the WCAG formula is defined in. */
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const context2d = probe.getContext("2d", { willReadFrequently: true })!;
    const toRgb = (colour: string): [number, number, number] => {
      context2d.clearRect(0, 0, 1, 1);
      context2d.fillStyle = colour;
      context2d.fillRect(0, 0, 1, 1);
      const [r, g, b] = context2d.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    const luminance = (colour: string) => {
      const channel = (value: number) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      const [r, g, b] = toRgb(colour);
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    /* Walks up for the first non-transparent background, exactly as a browser
       composites it — a colour read off the element alone is meaningless when
       the element's own background is `transparent`. */
    const backgroundOf = (element: Element): string => {
      let node: Element | null = element;
      while (node) {
        const colour = getComputedStyle(node).backgroundColor;
        if (colour && !/rgba?\([^)]*,\s*0\s*\)/.test(colour)) return colour;
        node = node.parentElement;
      }
      return "rgb(255, 255, 255)";
    };
    const ratio = (element: Element) => {
      const style = getComputedStyle(element);
      const a = luminance(style.color);
      const b = luminance(backgroundOf(element));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    const results: Array<{ what: string; ratio: number }> = [];
    const heading = document.querySelector("h1");
    if (heading) results.push({ what: "page heading", ratio: ratio(heading) });
    const muted = document.querySelector(".text-ink-muted");
    if (muted) results.push({ what: "secondary text", ratio: ratio(muted) });
    const button = document.querySelector("button");
    if (button) results.push({ what: "primary button", ratio: ratio(button) });
    return results;
  });

  expect(ratios.length).toBeGreaterThanOrEqual(3);
  for (const { what, ratio } of ratios) {
    expect(ratio, `${what} contrast is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }
});
