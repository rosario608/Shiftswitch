import { API_URL } from "@/config";

/**
 * The one place the app talks to the server.
 *
 * Responsibilities: attach the bearer token, turn the server's error envelope
 * into a typed error the screens can branch on, and tell the shell when the
 * session has gone so it can send the user back to sign-in instead of
 * rendering a screen full of failures.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export type ApiErrorCode =
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
  | "internal"
  | "network";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return this.code === "network" || this.code === "offline" || this.status >= 500;
  }
}

type TokenReader = () => string | null;
type UnauthorizedHandler = () => void;

let readToken: TokenReader = () => null;
let onUnauthorized: UnauthorizedHandler = () => {};

export function configureApi(options: {
  getToken: TokenReader;
  onUnauthorized: UnauthorizedHandler;
}): void {
  readToken = options.getToken;
  onUnauthorized = options.onUnauthorized;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Suppresses the global sign-out on 401 (used by the session probe). */
  allowUnauthenticated?: boolean;
}

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const token = readToken();
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      // The native client never relies on cookies; sending them would only
      // widen the surface for no gain.
      credentials: "omit",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(
      "network",
      "You appear to be offline. Check your connection and try again.",
    );
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    const code = (body?.error?.code ?? "internal") as ApiErrorCode;
    const message =
      body?.error?.message ?? "Something went wrong. Please try again.";
    if (code === "unauthenticated" && !options.allowUnauthenticated) {
      onUnauthorized();
    }
    throw new ApiError(code, message, response.status, body?.error?.details);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),
};
