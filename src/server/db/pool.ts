import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * A single shared connection pool per process.
 *
 * Next.js dev mode re-evaluates modules on every hot reload, which would leak
 * pools, so the instance is cached on `globalThis`.
 */
declare global {
  var __shiftswitchPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and configure it.",
    );
  }
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });
  pool.on("error", (err) => {
    console.error("[db] idle client error", err);
  });
  return pool;
}

export function getPool(): Pool {
  if (!globalThis.__shiftswitchPool) {
    globalThis.__shiftswitchPool = createPool();
  }
  return globalThis.__shiftswitchPool;
}

export async function closePool(): Promise<void> {
  if (globalThis.__shiftswitchPool) {
    await globalThis.__shiftswitchPool.end();
    globalThis.__shiftswitchPool = undefined;
  }
}

/** A minimal executor interface so queries work on the pool or inside a tx. */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
  executor: Queryable = getPool(),
): Promise<T[]> {
  const result = await executor.query<T>(text, values);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
  executor: Queryable = getPool(),
): Promise<T | null> {
  const rows = await query<T>(text, values, executor);
  return rows[0] ?? null;
}

export type TxOptions = {
  /** Defaults to READ COMMITTED; the trade finaliser uses SERIALIZABLE. */
  isolation?: "read committed" | "repeatable read" | "serializable";
};

/**
 * Runs `fn` inside a database transaction. Any thrown error rolls the whole
 * transaction back — this is the mechanism that makes shift swaps atomic.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const client = await getPool().connect();
  try {
    if (options.isolation) {
      await client.query(
        `BEGIN ISOLATION LEVEL ${options.isolation.toUpperCase()}`,
      );
    } else {
      await client.query("BEGIN");
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("[db] rollback failed", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}
