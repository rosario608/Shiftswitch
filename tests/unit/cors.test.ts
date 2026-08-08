import { afterEach, describe, expect, it } from "vitest";
import { corsPreflight } from "@/server/http/api";
import {
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  allowedOrigins,
  corsHeaders,
  isAllowedOrigin,
} from "@/server/http/cors";

/**
 * Cross-origin access for the native app.
 *
 * ## Why this file exists now and did not before
 *
 * This behaviour lived in `src/proxy.ts` and was covered by **nothing** — a
 * grep for `Access-Control` across the whole repository found the middleware
 * and the helper it called, and no test at all. It survived on the fact that
 * nobody changed it.
 *
 * Moving it into `apiHandler` for the Cloudflare migration is exactly the kind
 * of change that silently widens a security boundary, so the rules are written
 * down here as assertions rather than left to the next reader's care.
 *
 * The property that matters is the negative one: an origin that is not on the
 * allowlist gets **no** `Access-Control-*` headers, which is what stops an
 * arbitrary web page from reading a signed-in resident's schedule.
 */

const NATIVE = "capacitor://localhost";

afterEach(() => {
  delete process.env.MOBILE_ALLOWED_ORIGINS;
});

describe("which origins are allowed", () => {
  it("allows the three native webview origins and nothing else by default", () => {
    expect(isAllowedOrigin("capacitor://localhost")).toBe(true);
    expect(isAllowedOrigin("https://localhost")).toBe(true);
    expect(isAllowedOrigin("ionic://localhost")).toBe(true);

    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin(null)).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
  });

  it("matches exactly, so a look-alike origin is refused", () => {
    /* The shapes an attacker actually tries: a prefix, a suffix, and a
       different scheme on the same host. */
    expect(isAllowedOrigin("https://localhost.evil.example")).toBe(false);
    expect(isAllowedOrigin("https://evil.example/https://localhost")).toBe(false);
    expect(isAllowedOrigin("http://localhost")).toBe(false);
    expect(isAllowedOrigin("https://localhost:3000")).toBe(false);
  });

  it("adds configured development origins without losing the defaults", () => {
    process.env.MOBILE_ALLOWED_ORIGINS = "http://localhost:5173, http://127.0.0.1:5173";
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedOrigin("capacitor://localhost")).toBe(true);
    expect(allowedOrigins()).toHaveLength(5);
  });
});

describe("the headers themselves", () => {
  it("echoes the caller's origin rather than sending a wildcard", () => {
    const headers = corsHeaders(NATIVE);
    expect(headers["Access-Control-Allow-Origin"]).toBe(NATIVE);
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
  });

  it("varies on Origin, so a cache cannot serve one app's answer to another", () => {
    expect(corsHeaders(NATIVE).Vary).toBe("Origin");
  });

  it("never allows credentials", () => {
    /* The native client authenticates with a bearer token. Allowing cookies
       cross-origin would add risk and buy nothing. */
    expect(Object.keys(corsHeaders(NATIVE))).not.toContain(
      "Access-Control-Allow-Credentials",
    );
  });
});

describe("preflight", () => {
  const preflight = (origin: string | null) =>
    corsPreflight(
      new Request("https://shiftswitch.example/api/switches", {
        method: "OPTIONS",
        ...(origin ? { headers: { origin } } : {}),
      }),
    );

  it("answers an allowed origin with 204 and the full header set", () => {
    const response = preflight(NATIVE);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(NATIVE);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      CORS_ALLOWED_METHODS,
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      CORS_ALLOWED_HEADERS,
    );
    /* Authorization must be allowed or every native call fails preflight —
       this is the header the whole mechanism exists to permit. */
    expect(CORS_ALLOWED_HEADERS).toContain("authorization");
  });

  it("gives an unknown origin nothing to work with", () => {
    const response = preflight("https://evil.example");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("does not fall over when there is no Origin header at all", () => {
    const response = preflight(null);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("carries no body, as a preflight must not", async () => {
    expect(await preflight(NATIVE).text()).toBe("");
  });
});
