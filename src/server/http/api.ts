import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, translateDatabaseError, validationFailed } from "./errors";
import { logger } from "@/server/observability/logger";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function jsonError(error: AppError): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    { status: error.status },
  );
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
    try {
      return await handler(...args);
    } catch (error) {
      const appError = toAppError(error);
      const request = args[0] as Request | undefined;
      const path =
        request && typeof request === "object" && "url" in request
          ? new URL(request.url).pathname
          : "unknown";
      if (appError.status >= 500) {
        logger.error("api.unhandled", {
          path,
          durationMs: Date.now() - started,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
        });
      } else {
        logger.warn("api.rejected", {
          path,
          code: appError.code,
          status: appError.status,
          message: appError.message,
        });
      }
      return jsonError(appError);
    }
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

export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  const params: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    params[key] = all.length > 1 ? all : all[0];
  }
  return schema.parse(params);
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}
