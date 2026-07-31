#!/usr/bin/env node
/**
 * Sets the app version in one place and propagates it everywhere.
 *
 *   node scripts/set-version.mjs 1.1.0        # bumps versionCode by one
 *   node scripts/set-version.mjs 1.1.0 --code 42
 *   node scripts/set-version.mjs --check      # verifies everything agrees
 *
 * Android reads version.json directly from build.gradle; iOS needs the value
 * written into project.pbxproj, which configure-ios.mjs does. This script keeps
 * package.json and the .env files in step too, so the version a resident sees
 * in Settings is the version that was built.
 *
 * `--check` is what CI runs: a release whose Play versionCode has not
 * increased is rejected at upload, hours after the build, and this catches it
 * in seconds.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = join(root, "version.json");
const current = JSON.parse(readFileSync(versionPath, "utf8"));

const args = process.argv.slice(2);
const check = args.includes("--check");

function readEnvVersion(file) {
  if (!existsSync(file)) return null;
  const match = /^\s*VITE_APP_VERSION\s*=\s*(.+)$/m.exec(readFileSync(file, "utf8"));
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

function pbxVersions() {
  const pbx = readFileSync(join(root, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
  return {
    marketing: [...new Set([...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]))],
    build: [...new Set([...pbx.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map((m) => m[1]))],
  };
}

if (check) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== current.version) {
    problems.push(`package.json is ${pkg.version}, version.json is ${current.version}`);
  }
  const ios = pbxVersions();
  if (ios.marketing.length !== 1 || ios.marketing[0] !== current.version) {
    problems.push(
      `iOS MARKETING_VERSION is ${ios.marketing.join("/")}, expected ${current.version}`,
    );
  }
  if (ios.build.length !== 1 || ios.build[0] !== String(current.versionCode)) {
    problems.push(
      `iOS CURRENT_PROJECT_VERSION is ${ios.build.join("/")}, expected ${current.versionCode}`,
    );
  }
  for (const file of [".env.development", ".env.production", ".env.production.example"]) {
    const value = readEnvVersion(join(root, file));
    if (value && value !== current.version) {
      problems.push(`${file} declares ${value}, expected ${current.version}`);
    }
  }
  if (problems.length > 0) {
    console.error("[version] mismatched:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nRun: node scripts/set-version.mjs <version>");
    process.exit(1);
  }
  console.log(
    `[version] consistent: ${current.version} (build ${current.versionCode}).`,
  );
  process.exit(0);
}

const version = args.find((arg) => !arg.startsWith("--"));
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <major.minor.patch> [--code N]");
  process.exit(1);
}

const codeIndex = args.indexOf("--code");
const versionCode =
  codeIndex === -1 ? current.versionCode + 1 : Number(args[codeIndex + 1]);
if (!Number.isInteger(versionCode) || versionCode < 1) {
  console.error("--code must be a positive integer.");
  process.exit(1);
}
if (versionCode <= current.versionCode && codeIndex !== -1) {
  console.error(
    `versionCode must increase: ${versionCode} is not greater than the current ${current.versionCode}. Google Play rejects a re-used build number.`,
  );
  process.exit(1);
}

writeFileSync(
  versionPath,
  `${JSON.stringify({ ...current, version, versionCode }, null, 2)}\n`,
);

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

for (const file of [".env.development", ".env.production", ".env.production.example"]) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  const contents = readFileSync(path, "utf8");
  if (/^\s*VITE_APP_VERSION\s*=/m.test(contents)) {
    writeFileSync(
      path,
      contents.replace(/^(\s*VITE_APP_VERSION\s*=).*$/m, `$1${version}`),
    );
  }
}

execFileSync(process.execPath, [join(root, "scripts/configure-ios.mjs")], {
  stdio: "inherit",
});

console.log(`[version] set to ${version} (build ${versionCode}).`);
