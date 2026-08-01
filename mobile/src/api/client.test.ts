import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, configureApi, request } from "./client";
import { API_URL } from "@/config";

/**
 * The API client is the one place every screen depends on, and the places it
 * can go wrong are invisible: a missing bearer header looks like "not signed
 * in", a mis-parsed error envelope turns a rule violation into "something went
 * wrong", and a swallowed 401 leaves the app showing empty screens forever.
 */

describe("api client", () => {
  let token: string | null = null;
  let unauthorized: () => void;

  beforeEach(() => {
    token = "session-token";
    unauthorized = vi.fn<() => void>();
    configureApi({ getToken: () => token, onUnauthorized: () => unauthorized() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(response: { ok?: boolean; status?: number; text?: string }) {
    const fetchMock = vi.fn(async () => ({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.text ?? "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends the bearer token and never sends cookies", async () => {
    const fetchMock = mockFetch({ text: JSON.stringify({ ok: true }) });
    await api.get("/api/session");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe(`${API_URL}/api/session`);
    expect(init.headers.authorization).toBe("Bearer session-token");
    expect(init.credentials).toBe("omit");
  });

  it("omits the authorization header when signed out", async () => {
    token = null;
    const fetchMock = mockFetch({ text: "{}" });
    await api.get("/api/session");
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("surfaces the server's error code and message", async () => {
    mockFetch({
      ok: false,
      status: 422,
      text: JSON.stringify({
        error: {
          code: "rule_violation",
          message: "That switch would leave you on call for 14 days straight.",
        },
      }),
    });

    await expect(api.post("/api/switches", {})).rejects.toMatchObject({
      code: "rule_violation",
      status: 422,
      message: "That switch would leave you on call for 14 days straight.",
    });
  });

  it("signs the user out on 401", async () => {
    mockFetch({
      ok: false,
      status: 401,
      text: JSON.stringify({
        error: { code: "unauthenticated", message: "Please sign in." },
      }),
    });
    await expect(api.get("/api/dashboard")).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("does not sign the user out when the caller expects a 401", async () => {
    mockFetch({
      ok: false,
      status: 401,
      text: JSON.stringify({
        error: { code: "unauthenticated", message: "Please sign in." },
      }),
    });
    await expect(
      request("/api/session", { allowUnauthenticated: true }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("turns a transport failure into a retryable offline error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const error = (await api.get("/api/dashboard").catch((caught) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("network");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/offline/i);
  });

  it("does not treat an abort as a failure to report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );
    await expect(api.get("/api/dashboard")).rejects.toBeInstanceOf(DOMException);
  });

  it("survives a non-JSON error body", async () => {
    mockFetch({ ok: false, status: 502, text: "<html>bad gateway</html>" });
    const error = (await api.get("/api/dashboard").catch((caught) => caught)) as ApiError;
    expect(error.code).toBe("internal");
    expect(error.retryable).toBe(true);
  });
});
