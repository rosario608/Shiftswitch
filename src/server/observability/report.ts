import { logger } from "./logger";
import { currentRequestId } from "./request-id";
import { releaseId } from "@/server/health/check";

/**
 * Structured error reporting, with the privacy rule enforced rather than
 * trusted.
 *
 * ## What this is for
 *
 * The operator of this product does not read logs and does not troubleshoot. A
 * production failure has to arrive somewhere they will see it, carrying enough
 * to be fixed by pasting it into the next goal. That is the whole brief.
 *
 * ## What is never sent
 *
 * This application's data is a hospital's staffing and its residents' names,
 * addresses and phone numbers. **None of it goes to a third party**, ever, for
 * any reason, including "it would have made the bug easier to find".
 *
 * The rule is enforced by construction: `reportError` takes a fixed, typed set
 * of tags — release, route, role, request id, error code — and there is no
 * parameter through which a caller could attach a payload. A caller that wants
 * to say more can say it to `logger`, which stays on the server. Anything that
 * *could* carry data — an error's `message` — is scrubbed on the way out (see
 * `scrub`), because a database driver will happily put a row's contents in one.
 *
 * ## What is sent
 *
 * The exception's name, a scrubbed message, the stack, and the tags. A stack
 * trace names functions and files, which are public in the sense that matters:
 * they are in the repository, not in the database.
 *
 * ## Transport
 *
 * Behind an interface, like email and push, and for the same reason: the
 * default implementation must not pretend. With no DSN configured it writes to
 * the structured logger and says so, rather than silently discarding — a
 * reporting pipeline that quietly drops everything is worse than none, because
 * an empty dashboard reads as "nothing is wrong".
 */

export type ReportKind = "api" | "render" | "client" | "job";

export interface ReportTags {
  /** Joins this report to the log line and to what the resident was shown. */
  requestId?: string | null;
  /** The route pattern or pathname. Never a query string — ids live there. */
  route?: string;
  /** The *role*, never the person. "chief", not who. */
  role?: string;
  kind: ReportKind;
  /** The `AppError` code when there is one. */
  code?: string;
}

export interface ErrorReport {
  name: string;
  message: string;
  stack?: string;
  release: string;
  tags: ReportTags;
  at: string;
}

export interface ErrorTransport {
  readonly name: string;
  send(report: ErrorReport): void;
}

/**
 * Patterns that must never leave the building, applied to the message of every
 * reported error.
 *
 * This is belt-and-braces over the typed tags above: nothing *should* reach
 * here carrying an address, but the one that eventually does will be a driver
 * error quoting the row that violated a constraint, and it will arrive long
 * after anybody remembers this is a risk. Redaction that only runs where
 * somebody remembered to call it is not redaction.
 */
const SCRUBBERS: Array<[RegExp, string]> = [
  // Email addresses.
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  // Phone numbers in the E.164 shape the roster stores.
  [/\+\d{9,15}\b/g, "[phone]"],
  // Anything that looks like a connection string, credentials and all.
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/\S+/gi, "[connection-string]"],
  // Bearer tokens and long opaque secrets.
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[token]"],
];

export function scrub(message: string): string {
  let out = message;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  /* Bounded. A stack-in-a-message or a giant SQL statement makes a report
     unreadable and is a way to fill somebody's quota. */
  return out.length > 2_000 ? `${out.slice(0, 2_000)}…` : out;
}

/**
 * The default: write it where the structured logs already go, tagged so it can
 * be found, and be explicit that no external reporter is configured.
 */
class LoggingTransport implements ErrorTransport {
  readonly name = "logger";
  send(report: ErrorReport): void {
    logger.error("error.reported", {
      transport: this.name,
      delivered: false,
      reason:
        "No error-reporting DSN is configured, so this was written to the logs only.",
      report,
    });
  }
}

/**
 * Sentry-shaped, and deliberately not a Sentry dependency.
 *
 * The envelope endpoint is a documented HTTP API; using it directly keeps a
 * vendor SDK — which would be free to collect whatever it liked from the
 * process — out of a codebase whose whole privacy claim is that resident data
 * does not leave. What goes over the wire is exactly the object built above and
 * nothing else.
 */
class DsnTransport implements ErrorTransport {
  readonly name = "dsn";
  constructor(private readonly dsn: string) {}

  send(report: ErrorReport): void {
    /* Fire and forget, and never awaited by a request. Reporting an error must
       not be able to slow down or fail the response that is already failing. */
    void (async () => {
      try {
        const parsed = new URL(this.dsn);
        const projectId = parsed.pathname.replace(/^\//, "");
        const endpoint = `${parsed.protocol}//${parsed.host}/api/${projectId}/store/`;
        await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${parsed.username}`,
          },
          body: JSON.stringify({
            level: "error",
            platform: "node",
            release: report.release,
            timestamp: report.at,
            tags: report.tags,
            exception: {
              values: [
                { type: report.name, value: report.message, stacktrace: report.stack },
              ],
            },
          }),
        });
      } catch (error) {
        /* Never rethrown: the reporter failing must not become a second
           failure. Logged, so an operator can tell "nothing is broken" from
           "reporting is broken". */
        logger.warn("error.report_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
}

let transport: ErrorTransport | null = null;

export function getErrorTransport(): ErrorTransport {
  if (transport) return transport;
  const dsn = process.env.ERROR_REPORTING_DSN;
  transport = dsn ? new DsnTransport(dsn) : new LoggingTransport();
  return transport;
}

/** For tests. */
export function setErrorTransport(next: ErrorTransport | null): void {
  transport = next;
}

export function buildReport(error: unknown, tags: ReportTags): ErrorReport {
  const isError = error instanceof Error;
  return {
    name: isError ? error.name : "unknown",
    message: scrub(isError ? error.message : String(error)),
    stack: isError && error.stack ? scrub(error.stack) : undefined,
    release: releaseId(),
    tags: { ...tags, requestId: tags.requestId ?? currentRequestId() },
    at: new Date().toISOString(),
  };
}

/**
 * Reports one error. Never throws, never awaits, never carries resident data.
 */
export function reportError(error: unknown, tags: ReportTags): void {
  try {
    getErrorTransport().send(buildReport(error, tags));
  } catch {
    /* Deliberately silent. Anything here would be an error raised while
       reporting an error, and the original is already in the logs. */
  }
}
