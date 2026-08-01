import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The iOS project, checked without a Mac.
 *
 * The binary has never been compiled — that needs Xcode, and Xcode needs macOS.
 * But most of what goes wrong with an iOS submission is not compilation: it is
 * a plist key that is absent, an entitlement pointing at a host that does not
 * exist, or a privacy manifest that omits a reason code Apple now rejects. All
 * of that is text in this repository, and every line of it can be checked here.
 *
 * The one this caught: `applinks:app.example.org`, the placeholder the project
 * was created with, still in the entitlements. Nothing would have failed. The
 * app compiles, installs, launches and *silently opens its own links in Safari*
 * — the single worst way for a defect to behave, because it looks like a
 * product decision.
 */

const IOS = join(process.cwd(), "ios", "App", "App");
const read = (file: string) => readFileSync(join(IOS, file), "utf8");

/** The host the production client is built against. */
const PRODUCTION_HOST = "shiftswitch.vercel.app";

describe("entitlements", () => {
  const entitlements = read("App.entitlements");

  it("associates the app with the host it actually talks to", () => {
    /* iOS compares this against the host the link arrived from, exactly. A
       placeholder here does not fail a build; it fails every link a resident
       ever taps, quietly. */
    expect(entitlements).toContain(`applinks:${PRODUCTION_HOST}`);
    expect(entitlements).not.toContain("example.org");
    expect(entitlements).not.toContain("example.com");
  });

  it("declares push, and leaves the environment for Xcode to rewrite", () => {
    expect(entitlements).toContain("aps-environment");
    /* `development` is right for debug and TestFlight; the export step
       rewrites it to `production`. Committing `production` breaks TestFlight
       instead, which is harder to notice. */
    expect(entitlements).toContain("<string>development</string>");
  });
});

describe("Info.plist", () => {
  const info = read("Info.plist");

  it("keeps the URL scheme the sign-in handoff returns to", () => {
    /* Google redirects back to shiftswitch://…; without this the callback
       lands nowhere and sign-in appears to hang forever. */
    expect(info).toContain("<string>shiftswitch</string>");
  });

  it("is portrait-only, as the layouts assume", () => {
    expect(info).toContain("UISupportedInterfaceOrientations");
    expect(info).toContain("UIInterfaceOrientationPortrait");
    expect(info).not.toContain("UIInterfaceOrientationLandscapeLeft");
  });

  it("asks for the background mode push needs and nothing more", () => {
    expect(info).toContain("UIBackgroundModes");
    expect(info).toContain("remote-notification");
    /* Every extra background mode is a question at review, and this app has no
       reason for any of them. */
    for (const unjustified of ["location", "audio", "voip", "fetch"]) {
      expect(info, `UIBackgroundModes should not include ${unjustified}`).not.toContain(
        `<string>${unjustified}</string>`,
      );
    }
  });

  it("carries a display name and a version", () => {
    expect(info).toContain("CFBundleDisplayName");
    expect(info).toContain("CFBundleShortVersionString");
    expect(info).toContain("CFBundleVersion");
  });
});

describe("the privacy manifest", () => {
  const privacy = read("PrivacyInfo.xcprivacy");

  it("says the app does not track", () => {
    /* Apple's definition: linking this app's data to other companies' data for
       advertising. ShiftSwitch does not, and the App Store answers must agree
       with this file or the submission is rejected for inconsistency. */
    expect(privacy).toContain("NSPrivacyTracking");
    expect(privacy).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/);
    expect(privacy).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\s*\/>/);
  });

  it("declares every category of data the product actually collects", () => {
    for (const type of [
      "NSPrivacyCollectedDataTypeEmailAddress",
      "NSPrivacyCollectedDataTypeName",
      "NSPrivacyCollectedDataTypeUserID",
    ]) {
      expect(privacy, `${type} is collected and must be declared`).toContain(type);
    }
  });

  it("declares each of them as app functionality, never advertising", () => {
    expect(privacy).toContain("NSPrivacyCollectedDataTypePurposeAppFunctionality");
    for (const forbidden of [
      "NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising",
      "NSPrivacyCollectedDataTypePurposeDeveloperAdvertising",
      "NSPrivacyCollectedDataTypePurposeAnalytics",
    ]) {
      expect(privacy, `${forbidden} must not appear`).not.toContain(forbidden);
    }
  });

  it("gives a reason code for every required-reason API it uses", () => {
    /* Since spring 2024 Apple rejects binaries that touch these without a
       declared reason. Capacitor reads UserDefaults on every launch, so the
       first one is not optional. */
    expect(privacy).toContain("NSPrivacyAccessedAPICategoryUserDefaults");
    expect(privacy).toContain("CA92.1");
  });
});

describe("the app icon", () => {
  it("has the single 1024px asset Xcode now wants, and a manifest for it", () => {
    const contents = readFileSync(
      join(IOS, "Assets.xcassets", "AppIcon.appiconset", "Contents.json"),
      "utf8",
    );
    expect(contents).toContain("AppIcon-512@2x.png");
    /* One 1024×1024 image, which Xcode 14 and later downsample. A stale
       multi-size set is the commonest cause of "missing icon" at upload. */
    expect(contents).toContain('"size" : "1024x1024"');
  });
});
