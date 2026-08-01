"use client";

/**
 * Whether the request reached the server.
 *
 * The distinction this type exists to make is the one that matters most on
 * hospital wifi, and the one the product used to get wrong:
 *
 *   `"no"`      — certainly not sent. The browser was offline before the
 *                 request left, or the server answered with a refusal. Nothing
 *                 changed, and saying so is safe.
 *   `"unknown"` — the connection dropped after the request left and before the
 *                 answer came back. The switch may have completed. Telling
 *                 somebody it failed would be a coin flip presented as a fact.
 *   `"yes"`     — the server answered. Whatever it said is the truth.
 */
export type Delivery = "no" | "unknown" | "yes";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
    /** See `Delivery`. Defaults to `"yes"`: a server that answered. */
    readonly delivery: Delivery = "yes",
    /** The six characters that find this in the server's logs. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the product genuinely cannot say whether this happened. */
  get uncertain(): boolean {
    return this.delivery === "unknown";
  }
}

/**
 * Thin fetch wrapper used by every client mutation.
 *
 * It converts the server's structured error envelope into an `ApiError` with a
 * message that is already written for a resident — components never have to
 * interpret status codes, and raw technical errors never reach the screen.
 *
 * ## Why retrying is safe
 *
 * Every message below invites the resident to try again, and that is only
 * honest because the server makes a repeat harmless: posting the same shift
 * twice is refused by a partial unique index, offering the same shift twice on
 * one post likewise, and accepting an offer twice is refused by the status
 * transition checked inside the transaction. A duplicate is a conflict, not a
 * second switch. `tests/integration/idempotency.test.ts` and
 * `concurrency.test.ts` are what make that sentence true.
 */
export async function apiFetch<T>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError(
      "You're offline, so this didn't happen — nothing was sent and nothing has changed. Try again when you have a signal.",
      "offline",
      0,
      undefined,
      "no",
    );
  }

  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      credentials: "same-origin",
    });
  } catch {
    /* The mid-flight case, and the reason `Delivery` exists.

       This used to say "We couldn't reach ShiftSwitch. Check your connection
       and try again" — which reads as *nothing happened*, and on a ward with
       patchy wifi that is wrong about half the time. The request may well have
       arrived and committed; what failed was hearing back. A resident told
       "that didn't work" who then re-does something that already happened is
       being misled by their own app.

       Read-only requests get the simple wording, because "we could not fetch
       your schedule" has no ambiguity to it. */
    const mutating = (init.method ?? "GET").toUpperCase() !== "GET";
    throw new ApiError(
      mutating
        ? "The connection dropped before ShiftSwitch could confirm this. It may or may not have gone through — refresh to see where things stand before trying again."
        : "We couldn't reach ShiftSwitch. Check your connection and try again.",
      "network",
      0,
      undefined,
      mutating ? "unknown" : "no",
    );
  }

  /* Present on every response, success or failure. Kept even on the happy path
     so a resident describing something that merely looked wrong still has an
     id to quote. */
  const requestId = response.headers.get("x-request-id") ?? undefined;

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = payload as
      | {
          error?: {
            code?: string;
            message?: string;
            details?: unknown;
            requestId?: string;
          };
        }
      | null;
    throw new ApiError(
      envelope?.error?.message ?? "Something went wrong. Please try again.",
      envelope?.error?.code ?? "internal",
      response.status,
      envelope?.error?.details,
      /* The server answered, so this is known: it did not happen. */
      "no",
      envelope?.error?.requestId ?? requestId,
    );
  }

  return payload as T;
}
