type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) ?? (process.env.NODE_ENV === "test" ? "error" : "info")] ??
  LEVELS.info;

/** Keys whose values are never written to logs. */
const REDACTED = new Set([
  "password",
  "token",
  "id_token",
  "access_token",
  "code",
  "code_verifier",
  "client_secret",
  "authorization",
  "cookie",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED.has(key.toLowerCase())
      ? "[redacted]"
      : redact(item, depth + 1);
  }
  return output;
}

function write(level: Level, event: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = {
    level,
    event,
    time: new Date().toISOString(),
    ...(data ? (redact(data) as Record<string, unknown>) : {}),
  };
  const serialised = JSON.stringify(line);
  if (level === "error") console.error(serialised);
  else if (level === "warn") console.warn(serialised);
  else console.log(serialised);
}

export const logger = {
  debug: (event: string, data?: Record<string, unknown>) => write("debug", event, data),
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => write("error", event, data),
};
