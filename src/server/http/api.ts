import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, translateDatabaseError, validationFailed } from "./errors";
import { logger } from "@/server/observability/logger";
import { reportError } from "@/server/observability/report";
import {
  REQUEST_ID_HEADER,
  requestIdFrom,
  withRequestId,
} from "@/server/observability/request-id";
import {
  assertSchemaCurrent,
  isSchemaGateExempt,
} from "@/server/health/schema-gate";
import { corsHeaders, isAllowedOrigin } from "./cors";

/**
 * Cross-origin access for the native app, which used to live in `src/proxy.ts`.
 *
 * ## Why it moved
 *
 * Next 16 renamed middleware to Proxy and pinned it to the Node.js runtime —
 * the `runtime` option is not merely defaulted, it throws if you set it. The
 * Cloudflare adapter refuses a Node.js proxy outright and exits the build. So
 * on Workers the choice was: no CORS, or CORS somewhere else.
 *
 * ## Why here rather than in the Worker entry
 *
 * Wrapping the generated Worker would have been one file instead of ninety-
 * eight, and it would have applied *only in production*. `next dev` would then
 * serve the native app without CORS, so the one environment a mobile developer
 * actually tests against would behave differently from the one residents use.
 * Every route already passes through `apiHandler`; putting it here means the
 * same code answers the same way in dev, in the end-to-end suite, and on
 * Workers.
 *
 * The rule itself is unchanged from the proxy: an origin that is not on the
 * allowlist gets no `Access-Control-*` headers at all, which is what stops an
 * arbitrary web page reading these responses. Credentials are never allowed —
 * the native client carries a bearer token.
 */
function withCors(response: Response, request: Request | undefined): Response {
  const origin = request?.headers.get("origin") ?? null;
  if (!isAllowedOrigin(origin)) return response;
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * The preflight answer, exported by every route under `/api`.
 *
 * A browser sends `OPTIONS` before any request carrying `Authorization` or a
 * JSON body — which is every call the native client makes — and Next's default
 * `OPTIONS` response carries `Allow` but no `Access-Control-*`, so preflight
 * fails and the real request is never sent.
 *
 * Deliberately not authenticated: a preflight is the browser asking whether it
 * *may* send credentials, and it does not carry any. It reveals nothing beyond
 * the method list already implied by the route existing.
 */
export function corsPreflight(request: Request): Response {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 204 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    /**
     * The six characters that join this response to the server's logs.
     *
     * On the error envelope rather than only in a header because the client
     * shows it to the resident, and a resident reading it off a screen is the
     * fastest route from "it broke" to the log line that says why.
     */
    requestId?: string;
  };
}

export function jsonError(
  error: AppError,
  requestId?: string,
): NextResponse<ApiErrorBody> {
  const response = NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(requestId ? { requestId } : {}),
      },
    },
    { status: error.status },
  );
  if (requestId) response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return validationFailed("Some of the information provided isn't valid.", {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    return translateDatabaseError(error);
  }
  return new AppError("internal", "Something went wrong. Please try again.");
}

/**
 * Wraps a route handler so that:
 *  - domain errors become clean JSON with a stable code,
 *  - unknown/database errors are logged server-side and reduced to a safe
 *    message (no stack traces or Postgres codes reach the client).
 */
export function apiHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const started = Date.now();
    const request = args[0] as Request | undefined;
    const hasRequest =
      request instanceof Request ||
      (typeof request === "object" && request !== null && "url" in request);
    const path = hasRequest ? new URL(request!.url).pathname : "unknown";
    const requestId = hasRequest ? requestIdFrom(request!.headers) : "no-request";

    return withRequestId(requestId, async () => {
      try {
        /* Before the handler, not inside it. Every route goes through here, so
           this is the one place that can guarantee no query runs against a
           schema that cannot support it — and the refusal names the migration
           instead of surfacing "column does not exist" as a 500. Exempt: the
           routes somebody needs *while* this is failing. */
        if (!isSchemaGateExempt(path)) await assertSchemaCurrent();

        const response = await handler(...args);
        /* On success too. A resident reporting "it was slow and then weird"
           has an id to give even when nothing threw. */
        response.headers.set(REQUEST_ID_HEADER, requestId);
        return withCors(response, hasRequest ? request : undefined);
      } catch (error) {
        const appError = toAppError(error);
        if (appError.status >= 500) {
          logger.error("api.unhandled", {
            requestId,
            path,
            code: appError.code,
            durationMs: Date.now() - started,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : String(error),
          });
          /* One exception, and it is the difference between an incident and a
             designed refusal. `schema_drift` is this build noticing, on
             purpose, that the database is behind it — every request in flight
             raises it, so reporting here would send one report per resident
             per tap for as long as the drift lasts, burying whatever else is
             wrong. The drift itself is reported once per verdict, by the gate
             that computes it. */
          if (appError.code !== "schema_drift") {
            reportError(error, { requestId, route: path, kind: "api" });
          }
        } else {
          logger.warn("api.rejected", {
            requestId,
            path,
            code: appError.code,
            status: appError.status,
            message: appError.message,
          });
        }
        /* Refusals get the headers too. A 403 the native client cannot read is
           indistinguishable from the network failing, and the whole point of
           the error envelope is that the resident is told which it was. */
        return withCors(jsonError(appError, requestId), hasRequest ? request : undefined);
      }
    });
  };
}

export async function parseJson<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationFailed("The request body was not valid JSON.");
  }
  return schema.parse(raw);
}

/** Parses a body that may legitimately be absent (e.g. an optional reason). */
export async function parseOptionalJson<T>(
  request: Request,
  schema: ZodType<T>,
  fallback: T,
): Promise<T> {
  const text = await request.text();
  if (!text.trim()) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw validationFailed("The request body was not valid JSON.");
  }
  return schema.parse(raw);
}

export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  const params: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    params[key] = all.length > 1 ? all : all[0];
  }
  return schema.parse(params);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates a path parameter before it reaches the database. A malformed id is
 * a "not found", not a server error.
 */
export function requireUuid(value: string, label = "item"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError("not_found", `We couldn't find that ${label}.`);
  }
  return value;
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}
