#!/usr/bin/env node
/**
 * Applies the iOS project settings that `cap add ios` cannot know about, so
 * they are reproducible instead of being clicked into Xcode once and lost the
 * next time the platform is regenerated.
 *
 *   node scripts/configure-ios.mjs
 *
 * It is idempotent — running it twice changes nothing the second time.
 *
 * What it does:
 *  - registers App.entitlements (push + associated domains) and points both
 *    build configurations at it;
 *  - registers PrivacyInfo.xcprivacy and adds it to the resources build phase,
 *    which is the only way it reaches the bundle where App Review looks for it;
 *  - writes the version from version.json into MARKETING_VERSION and
 *    CURRENT_PROJECT_VERSION so iOS and Android cannot drift apart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pbxPath = join(root, "ios/App/App.xcodeproj/project.pbxproj");
const version = JSON.parse(readFileSync(join(root, "version.json"), "utf8"));

// Stable identifiers so re-running produces an identical file.
const ENTITLEMENTS_REF = "A1B2C3D400000000000000E1";
const PRIVACY_REF = "A1B2C3D400000000000000E2";
const PRIVACY_BUILD = "A1B2C3D400000000000000E3";

let pbx = readFileSync(pbxPath, "utf8");
const before = pbx;

function ensure(marker, addition, anchor) {
  if (pbx.includes(marker)) return false;
  const index = pbx.indexOf(anchor);
  if (index === -1) {
    throw new Error(`Could not find anchor in project.pbxproj: ${anchor}`);
  }
  pbx = pbx.slice(0, index) + addition + pbx.slice(index);
  return true;
}

// 1. File references.
ensure(
  ENTITLEMENTS_REF,
  `\t\t${ENTITLEMENTS_REF} /* App.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = "<group>"; };\n` +
    `\t\t${PRIVACY_REF} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n`,
  "/* End PBXFileReference section */",
);

// 2. The privacy manifest must be copied into the bundle.
ensure(
  PRIVACY_BUILD,
  `\t\t${PRIVACY_BUILD} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${PRIVACY_REF} /* PrivacyInfo.xcprivacy */; };\n`,
  "/* End PBXBuildFile section */",
);

if (!pbx.includes(`${PRIVACY_BUILD} /* PrivacyInfo.xcprivacy in Resources */,`)) {
  // Insert into the App target's Resources phase, right after its first entry.
  pbx = pbx.replace(
    /(\/\* Begin PBXResourcesBuildPhase section \*\/[\s\S]*?files = \(\n)/,
    `$1\t\t\t\t${PRIVACY_BUILD} /* PrivacyInfo.xcprivacy in Resources */,\n`,
  );
}

// 3. Both files must appear in the App group so Xcode shows them.
for (const [ref, name] of [
  [ENTITLEMENTS_REF, "App.entitlements"],
  [PRIVACY_REF, "PrivacyInfo.xcprivacy"],
]) {
  const entry = `\t\t\t\t${ref} /* ${name} */,\n`;
  if (!pbx.includes(entry)) {
    pbx = pbx.replace(
      /(504EC3131FED79650016851F \/\* Info\.plist \*\/,\n)/,
      `$1${entry}`,
    );
  }
}

// 4. Build settings on both configurations.
pbx = pbx.replace(
  /(\n\t{4}INFOPLIST_FILE = App\/Info\.plist;)/g,
  "\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;$1",
);
// Guard against the replacement running twice.
pbx = pbx.replace(
  /(CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;\n\t{4})+(CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;)/g,
  "$2",
);

pbx = pbx.replace(
  /CURRENT_PROJECT_VERSION = [^;]+;/g,
  `CURRENT_PROJECT_VERSION = ${version.versionCode};`,
);
pbx = pbx.replace(
  /MARKETING_VERSION = [^;]+;/g,
  `MARKETING_VERSION = ${version.version};`,
);

if (pbx === before) {
  console.log("[ios] project already configured; nothing to change.");
} else {
  writeFileSync(pbxPath, pbx);
  console.log(
    `[ios] configured entitlements, privacy manifest and version ${version.version} (${version.versionCode}).`,
  );
}

// A quick structural check: an unbalanced file will not open in Xcode, and
// finding that out on a Mac hours later is expensive.
const opens = (pbx.match(/\{/g) ?? []).length;
const closes = (pbx.match(/\}/g) ?? []).length;
if (opens !== closes) {
  throw new Error(
    `project.pbxproj is unbalanced (${opens} '{' vs ${closes} '}'). Not writing further changes.`,
  );
}
for (const required of [
  "CODE_SIGN_ENTITLEMENTS = App/App.entitlements;",
  "PrivacyInfo.xcprivacy in Resources",
]) {
  if (!pbx.includes(required)) {
    throw new Error(`Expected "${required}" in project.pbxproj after configuring.`);
  }
}
console.log("[ios] project.pbxproj verified.");
