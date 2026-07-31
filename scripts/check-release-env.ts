#!/usr/bin/env tsx
/**
 * Release configuration gate.
 *
 * Run before any store build. It fails loudly rather than letting a
 * development database, a localhost API or a debug flag reach a signed
 * artifact — the class of mistake that is invisible until users hit it.
 *
 *   npm run check:release            # validates the current environment
 *   npm run check:release -- --mobile  # also validates mobile/.env.production
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "./load-env";

interface Finding {
  level: "error" | "warning";
  message: string;
}

const findings: Finding[] = [];
const fail = (message: string) => findings.push({ level: "error", message });
const warn = (message: string) => findings.push({ level: "warning", message });

function looksLocal(value: string): boolean {
  return /(^|\/\/|@)(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(:|\/|$)/i.test(value);
}

function checkServerEnv() {
  const appUrl = process.env.APP_URL ?? "";
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!appUrl) fail("APP_URL is not set.");
  else {
    if (!appUrl.startsWith("https://")) {
      fail(`APP_URL must be https in production (got "${appUrl}").`);
    }
    if (looksLocal(appUrl)) fail(`APP_URL points at a local host: "${appUrl}".`);
  }

  if (!databaseUrl) fail("DATABASE_URL is not set.");
  else {
    if (looksLocal(databaseUrl)) {
      fail("DATABASE_URL points at a local database.");
    }
    if (/(_dev|_test|-dev|-test|development)/i.test(databaseUrl)) {
      fail("DATABASE_URL names a development or test database.");
    }
    if (process.env.DATABASE_SSL !== "true") {
      warn("DATABASE_SSL is not \"true\"; most hosted databases require TLS.");
    }
  }

  if (process.env.TEST_DATABASE_URL) {
    warn("TEST_DATABASE_URL is set in a production environment; it is unused there.");
  }

  const secret = process.env.AUTH_SECRET ?? "";
  if (secret.length < 32) fail("AUTH_SECRET must be at least 32 characters.");
  if (/test|change ?me|secret-secret|placeholder/i.test(secret)) {
    fail("AUTH_SECRET looks like a placeholder.");
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    fail("Google OAuth credentials are missing.");
  } else if (/test-client/i.test(process.env.GOOGLE_CLIENT_ID)) {
    fail("GOOGLE_CLIENT_ID is a test value.");
  }

  if (process.env.ALLOW_TEST_LOGIN === "true") {
    fail("ALLOW_TEST_LOGIN is enabled. It must never be set in production.");
  }
  if (process.env.BOOTSTRAP_ADMIN_EMAILS) {
    warn(
      "BOOTSTRAP_ADMIN_EMAILS is still set. Clear it once the first administrator exists.",
    );
  }
  if (["debug", "trace"].includes((process.env.LOG_LEVEL ?? "").toLowerCase())) {
    fail("LOG_LEVEL is debug/trace; production logging must not be verbose.");
  }
  if (!process.env.FCM_PROJECT_ID) {
    warn("No FCM credentials configured — push notifications will be skipped.");
  }
}

function checkMobileEnv() {
  const file = path.join(process.cwd(), "mobile", ".env.production");
  if (!existsSync(file)) {
    fail("mobile/.env.production is missing; the app would build with dev defaults.");
    return;
  }
  const contents = readFileSync(file, "utf8");
  const values = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }

  const apiUrl = values.get("VITE_API_URL") ?? "";
  if (!apiUrl) fail("mobile: VITE_API_URL is not set.");
  else {
    if (looksLocal(apiUrl)) fail(`mobile: VITE_API_URL points at a local host ("${apiUrl}").`);
    if (!apiUrl.startsWith("https://")) {
      fail(`mobile: VITE_API_URL must be https (got "${apiUrl}").`);
    }
  }
  if (values.get("VITE_ALLOW_TEST_LOGIN") === "true") {
    fail("mobile: VITE_ALLOW_TEST_LOGIN must not be enabled in a store build.");
  }
  if ((values.get("VITE_ENVIRONMENT") ?? "production") !== "production") {
    fail("mobile: VITE_ENVIRONMENT must be \"production\" for a store build.");
  }

  // The bundle/application identifier must not be a development variant.
  const capacitorConfig = path.join(process.cwd(), "mobile", "capacitor.config.ts");
  if (existsSync(capacitorConfig)) {
    const config = readFileSync(capacitorConfig, "utf8");
    if (/appId:\s*["'][^"']*\.(dev|debug|staging)["']/.test(config)) {
      fail("mobile: capacitor appId is a development identifier.");
    }
    if (/server:\s*\{[^}]*url:/.test(config)) {
      fail(
        "mobile: capacitor.config.ts sets server.url — a store build must load the bundled app, not a remote URL.",
      );
    }
  }
}

function main() {
  loadEnv();
  const checkMobile = process.argv.includes("--mobile");

  checkServerEnv();
  if (checkMobile) checkMobileEnv();

  const errors = findings.filter((finding) => finding.level === "error");
  const warnings = findings.filter((finding) => finding.level === "warning");

  for (const warning of warnings) console.warn(`  warning  ${warning.message}`);
  for (const error of errors) console.error(`  error    ${error.message}`);

  if (errors.length > 0) {
    console.error(
      `\n[release] ${errors.length} blocking problem(s). This configuration must not ship.`,
    );
    process.exit(1);
  }
  console.log(
    `[release] configuration looks like production${
      warnings.length ? ` (${warnings.length} warning(s))` : ""
    }.`,
  );
}

main();
