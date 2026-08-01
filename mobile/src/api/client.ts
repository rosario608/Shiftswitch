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

/**
 * Whether the request reached the server, as far as anybody can tell.
 *
 * The web client has carried this since the resilience work; the native client
 * did not, and told a resident an interrupted action had *failed* when it may
 * well have succeeded. That is the one wrong answer here: somebody told their
 * offer failed will make it again, and a duplicate offer on a shift that has
 * already been accepted is the state the whole trade lifecycle exists to
 * prevent.
 *
 * - `"no"`  — the phone knew it was offline; nothing left it, nothing changed.
 * - `"unknown"` — it left, and no answer came back. Reload before retrying.
 * - `"yes"` — the server answered, whatever the answer was.
 */
export type Delivery = "no" | "unknown" | "yes";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly delivery: Delivery;

  constructor(
    code: ApiErrorCode,
    message: string,
    status = 0,
    details?: unknown,
    delivery: Delivery = "yes",
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.delivery = delivery;
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return this.code === "network" || this.code === "offline" || this.status >= 500;
  }

  /** True when nobody knows whether this happened. Never offer a plain retry. */
  get uncertain(): boolean {
    return this.delivery === "unknown";
  }
}

/**
 * What to say when `fetch` itself did not complete, and how certain to be.
 *
 * Split out and exported because it is the one piece of the offline design that
 * can be checked on a device without severing the network: the self-test calls
 * it directly and asserts that a drop while online is reported as *unknown*
 * rather than as a failure. A check that cannot be run is a claim, not a check.
 */
export function networkFailure(online: boolean): ApiError {
  if (!online) {
    return new ApiError(
      "offline",
      "You\u2019re offline, so this didn\u2019t happen \u2014 nothing was sent and nothing has changed.",
      0,
      undefined,
      "no",
    );
  }
  /* Online as far as the phone knows, and the request still did not complete.
     On hospital wifi this is the common case, and it is genuinely uncertain:
     `fetch` cannot say whether the bytes arrived. */
  return new ApiError(
    "network",
    "The connection dropped before ShiftSwitch could confirm this. It may or may not have gone through \u2014 pull down to refresh and see where things stand before trying again.",
    0,
    undefined,
    "unknown",
  );
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
    /* A deliberate abort is rethrown untouched. The caller aborted, so the
       caller already knows — `useResource` cancels every in-flight read when a
       screen unmounts, and turning that into an error would put a banner on
       every screen somebody navigates away from quickly. */
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw networkFailure(navigator.onLine);
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
