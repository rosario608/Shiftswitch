/**
 * The database connection used by administrative scripts.
 *
 * This is deliberately separate from `src/server/db/pool.ts`. The application
 * always talks to PostgreSQL over a normal TCP connection with `pg`, and that
 * is not changing — but the scripts that set a database up sometimes have to
 * run from somewhere that cannot open port 5432: a CI sandbox, a locked-down
 * corporate network, a container whose egress is HTTPS-only.
 *
 * Neon serves SQL over HTTPS/WebSocket on port 443 as well as over TCP, so in
 * those environments the same scripts still work:
 *
 *   DATABASE_DRIVER=neon-ws npm run setup:production
 *
 * The default is unchanged and is plain `pg`. Nothing in the application's
 * request path is affected either way.
 */
import { Client as PgClient } from "pg";

export interface AdminClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export type DatabaseDriver = "pg" | "neon-ws";

export function selectedDriver(): DatabaseDriver {
  return process.env.DATABASE_DRIVER === "neon-ws" ? "neon-ws" : "pg";
}

/**
 * Opens an administrative connection. The caller is responsible for `end()`.
 */
export async function createAdminClient(): Promise<AdminClient> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  if (selectedDriver() === "neon-ws") {
    // Imported lazily so the package is only needed when it is actually used —
    // it is a devDependency, and a normal deployment never loads it.
    const { Client: NeonClient, neonConfig } = await import(
      "@neondatabase/serverless"
    );
    // Keep one WebSocket open for the life of the script rather than
    // reconnecting per statement; migrations run many statements in sequence.
    neonConfig.pipelineConnect = false;
    const client = new NeonClient(connectionString);
    return client as unknown as AdminClient;
  }

  const client = new PgClient({
    connectionString,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });
  return client as unknown as AdminClient;
}

/** Human-readable description of how we are connecting, for script output. */
export function describeConnection(): string {
  const url = process.env.DATABASE_URL ?? "";
  let host = "unknown host";
  try {
    host = new URL(url).host;
  } catch {
    // Leave the default; the caller's own validation reports a bad URL.
  }
  return selectedDriver() === "neon-ws"
    ? `${host} (over HTTPS/WebSocket)`
    : host;
}
