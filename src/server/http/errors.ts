/**
 * Application error taxonomy.
 *
 * Every error surfaced to a client goes through `AppError`, which carries a
 * stable machine code plus a message written for a resident on a phone.
 * Raw database errors are never forwarded to the client.
 */
export type AppErrorCode =
  | "unauthenticated"
  | "not_configured"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "expired"
  | "rule_violation"
  | "offline"
  | "rate_limited"
  | "internal";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  not_configured: 403,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  expired: 409,
  rule_violation: 422,
  offline: 503,
  rate_limited: 429,
  internal: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const unauthenticated = (message = "Please sign in to continue.") =>
  new AppError("unauthenticated", message);

export const forbidden = (
  message = "You do not have permission to do that.",
) => new AppError("forbidden", message);

export const notFound = (message = "We couldn't find that item.") =>
  new AppError("not_found", message);

export const conflict = (message: string, details?: unknown) =>
  new AppError("conflict", message, details);

export const validationFailed = (message: string, details?: unknown) =>
  new AppError("validation_failed", message, details);

/**
 * Translates known Postgres error codes into resident-friendly messages.
 * Anything unrecognised becomes a generic internal error (details are logged
 * server-side by the API wrapper, never returned).
 */
export function translateDatabaseError(error: unknown): AppError {
  const pgError = error as { code?: string; constraint?: string };
  switch (pgError?.code) {
    case "23505": // unique_violation
      if (pgError.constraint === "shift_assignments_one_active_per_shift") {
        return conflict(
          "This shift was just updated by someone else. Refresh and try again.",
        );
      }
      if (pgError.constraint === "trade_requests_one_open_per_shift") {
        return conflict("This shift is already posted for trade.");
      }
      if (pgError.constraint === "trade_offers_one_live_per_shift_request") {
        return conflict("You have already offered that shift for this trade.");
      }
      if (pgError.constraint === "completed_trades_offer_key") {
        return conflict("This switch has already been completed.");
      }
      return conflict("That change conflicts with an existing record.");
    case "23503": // foreign_key_violation
      return new AppError(
        "not_found",
        "One of the records involved no longer exists.",
      );
    case "22P02": // invalid_text_representation (e.g. a malformed uuid)
      return new AppError("not_found", "We couldn't find that item.");
    case "23514": // check_violation
      return validationFailed("That change is not allowed.");
    case "40001": // serialization_failure
      return conflict(
        "Another change was made at the same time. Please try again.",
      );
    case "55P03": // lock_not_available
      return conflict("This shift is being updated right now. Try again.");
    default:
      return new AppError(
        "internal",
        "Something went wrong on our side. Please try again.",
      );
  }
}
