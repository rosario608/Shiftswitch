#!/usr/bin/env tsx
/**
 * Prints the device registrations for one account as JSON.
 *
 *   npx tsx scripts/e2e-devices.ts resident@example.org
 *
 * Used by the native end-to-end suite to check that signing in really did
 * register the installation server-side, rather than trusting that a
 * fire-and-forget request succeeded.
 */
import { loadEnv } from "./load-env";

loadEnv();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: tsx scripts/e2e-devices.ts <email>");
    process.exit(1);
  }

  const { closePool, query } = await import("@/server/db/pool");
  const rows = await query(
    `SELECT d.platform,
            (d.push_token IS NOT NULL) AS has_push_token,
            (d.disabled_at IS NOT NULL) AS disabled
       FROM devices d
       JOIN users u ON u.id = d.user_id
      WHERE lower(u.email) = lower($1)
      ORDER BY d.last_seen_at`,
    [email],
  );
  console.log(JSON.stringify(rows));
  await closePool();
}

main().catch((error) => {
  console.error("[e2e-devices] failed:", error);
  process.exit(1);
});
