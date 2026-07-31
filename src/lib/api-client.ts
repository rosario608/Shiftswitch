"use client";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Thin fetch wrapper used by every client mutation.
 *
 * It converts the server's structured error envelope into an `ApiError` with a
 * message that is already written for a resident — components never have to
 * interpret status codes, and raw technical errors never reach the screen.
 */
export async function apiFetch<T>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError(
      "You're offline. Schedule changes require an internet connection.",
      "offline",
      0,
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
    throw new ApiError(
      "We couldn't reach ShiftSwitch. Check your connection and try again.",
      "network",
      0,
    );
  }

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
      | { error?: { code?: string; message?: string; details?: unknown } }
      | null;
    throw new ApiError(
      envelope?.error?.message ?? "Something went wrong. Please try again.",
      envelope?.error?.code ?? "internal",
      response.status,
      envelope?.error?.details,
    );
  }

  return payload as T;
}
