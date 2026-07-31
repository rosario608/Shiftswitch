import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// Tests always run against the dedicated test database, never the dev one.
(process.env as Record<string, string>).NODE_ENV = "test";
for (const file of [".env.test", ".env.test.local"]) {
  const full = path.join(process.cwd(), file);
  // No override: values already in the environment (CI, or an explicit export)
  // win over the checked-in defaults.
  if (existsSync(full)) dotenv.config({ path: full, quiet: true });
}
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
