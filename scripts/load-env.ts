import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Loads env files with the same precedence Next.js uses, so scripts and tests
 * see exactly what the app sees. Existing process env always wins.
 */
export function loadEnv(): void {
  const mode = process.env.NODE_ENV ?? "development";
  const candidates = [
    `.env.${mode}.local`,
    mode === "test" ? null : ".env.local",
    `.env.${mode}`,
    ".env",
  ].filter(Boolean) as string[];

  for (const file of candidates) {
    const full = path.join(process.cwd(), file);
    if (existsSync(full)) dotenv.config({ path: full, quiet: true });
  }
}
