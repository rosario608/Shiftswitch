import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { logger } from "@/server/observability/logger";

/**
 * These four failures are the ones most worth seeing and the easiest to lose:
 * an idle client dying, after-commit work failing, a rollback failing. They
 * used to go to `console.error`, which meant they were the only errors in the
 * application not captured by the structured, redacting logger — so they were
 * invisible to anything reading logs as JSON, and a connection string in an
 * error message would have gone out unredacted.
 */
function describe(error: unknown): { name: string; message: string; stack?: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "unknown", message: String(error) };
}


/**
 * A single shared connection pool per process.
 *
 * Next.js dev mode re-evaluates modules on every hot reload, which would leak
 * pools, so the instance is cached on `globalThis`.
 */
declare global {
  var __shiftswitchPool: Pool | undefined;
}

/**
 * Whether this process is a Cloudflare Worker isolate.
 *
 * `navigator.userAgent` is workerd's documented self-identification, and it is
 * the only thing asked here — no Cloudflare package is imported, so `scripts/`,
 * the migration runner and every test keep a module graph that has never heard
 * of Workers.
 */
function onWorkers(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
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
    /**
     * One connection per isolate on Workers, ten in a Node process.
     *
     * A Worker cannot hold a pool across requests the way a Node server can,
     * and there are many isolates. Ten each would multiply into Neon's
     * connection limit under a Monday morning — and running out of connections
     * presents as the schedule being down, which is the worst way for this to
     * fail.
     *
     * What makes one enough is Neon's own pooler: `DATABASE_URL` points at the
     * pooled endpoint, which this project verified empirically (a competing
     * transaction blocked correctly for the duration of a held row lock, and
     * ten concurrent read-modify-write transactions lost no updates — see
     * docs/DEPLOYMENT.md). Cloudflare Hyperdrive would do the same job with
     * lower latency, and is the upgrade path if connection pressure ever shows
     * up, but it is a resource to provision and a binding to wire for a problem
     * that is already solved.
     */
    max: onWorkers() ? 1 : Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    /**
     * `rejectUnauthorized: false` applies on Node and is **ignored on Workers**.
     *
     * `pg-cloudflare` hands this object to workerd's `socket.startTls()`, which
     * accepts `expectedServerHostname` and nothing else: workerd verifies the
     * certificate against its own trust store unconditionally, and there is no
     * option that turns that off. Confirmed by running the built Worker under
     * local workerd, where a self-signed certificate was refused —
     * `TLS peer's certificate is not trusted; reason = IP address mismatch` —
     * with this exact setting in place.
     *
     * So the deployed behaviour is *stricter* than this line reads, which is
     * the safe direction and is fine against Neon, whose certificate is
     * publicly trusted and presented on a hostname. It is written down because
     * the discrepancy is invisible: the same configuration means two different
     * things depending on where it runs, and the Workers one cannot be relaxed.
     *
     * The consequence to know about is local: `wrangler dev` cannot reach a
     * PostgreSQL with a self-signed certificate, so previewing the Worker
     * against a local database does not work. See `docs/CLOUDFLARE_CUTOVER.md`.
     */
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });
  pool.on("error", (err) => {
    logger.error("db.idle_client_error", { error: describe(err) });
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

interface TransactionScope {
  afterCommit: Array<() => Promise<void>>;
}

const transactionScope = new AsyncLocalStorage<TransactionScope>();

/**
 * Registers work that must happen only if the surrounding transaction commits —
 * sending a push notification, for example. Outside a transaction it runs
 * immediately. Failures are swallowed: a side effect must never fail the
 * operation that caused it, and it has already been recorded in the database.
 */
export function afterCommit(work: () => Promise<void>): void {
  const scope = transactionScope.getStore();
  if (scope) {
    scope.afterCommit.push(work);
    return;
  }
  void work().catch((error) => {
    logger.error("db.after_commit_failed", { error: describe(error) });
  });
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
  const scope: TransactionScope = { afterCommit: [] };
  try {
    if (options.isolation) {
      await client.query(
        `BEGIN ISOLATION LEVEL ${options.isolation.toUpperCase()}`,
      );
    } else {
      await client.query("BEGIN");
    }
    const result = await transactionScope.run(scope, () => fn(client));
    await client.query("COMMIT");
    for (const work of scope.afterCommit) {
      try {
        await work();
      } catch (error) {
        logger.error("db.after_commit_failed", { error: describe(error) });
      }
    }
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error("db.rollback_failed", { error: describe(rollbackError) });
    }
    throw error;
  } finally {
    client.release();
  }
}
