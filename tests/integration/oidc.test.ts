import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getOidcConfig,
  OidcError,
  pkceChallenge,
  randomUrlSafe,
  verifyIdToken,
} from "@/server/auth/oidc";
import { provisionUserFromIdentity } from "@/server/auth/provisioning";
import { queryOne } from "@/server/db/pool";
import type { UserRow } from "@/server/db/types";
import { closeDatabase, createProgram, ensureMigrated, resetDatabase } from "./helpers";

/**
 * The Google sign-in code path, driven against a local OpenID provider that
 * signs tokens with a real key pair and publishes a real JWKS. Everything from
 * the authorization URL through signature verification to user provisioning is
 * exercised; only Google's own servers are substituted.
 */

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";

let server: Server;
let issuer: string;
let privateKey: CryptoKey;
let publicJwk: JWK;

/** What the mock token endpoint should return on the next exchange. */
let nextToken: { id_token?: string; error?: string } = {};
let lastTokenRequest: URLSearchParams | null = null;

async function signIdToken(claims: Record<string, unknown>, options: { kid?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "test-key" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

beforeAll(async () => {
  ensureMigrated();
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey;
  publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  server = createServer((request, response) => {
    if (request.url?.startsWith("/jwks")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (request.url?.startsWith("/token")) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        lastTokenRequest = new URLSearchParams(body);
        if (nextToken.error) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: nextToken.error }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id_token: nextToken.id_token, token_type: "Bearer" }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;

  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
  process.env.GOOGLE_ISSUER = issuer;
  process.env.GOOGLE_AUTH_ENDPOINT = `${issuer}/authorize`;
  process.env.GOOGLE_TOKEN_ENDPOINT = `${issuer}/token`;
  process.env.GOOGLE_JWKS_URI = `${issuer}/jwks`;
  process.env.APP_URL = "http://localhost:3000";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  await createProgram();
  nextToken = {};
  lastTokenRequest = null;
  delete process.env.GOOGLE_HOSTED_DOMAIN;
});

afterEach(() => {
  delete process.env.BOOTSTRAP_ADMIN_EMAILS;
});

describe("authorization request", () => {
  it("includes state, nonce and a PKCE challenge", () => {
    const config = getOidcConfig();
    const state = randomUrlSafe();
    const nonce = randomUrlSafe();
    const codeVerifier = randomUrlSafe(48);
    const url = new URL(buildAuthorizationUrl(config, { state, nonce, codeVerifier }));

    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/google/callback",
    );
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(codeVerifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("passes the hosted domain hint when configured", () => {
    process.env.GOOGLE_HOSTED_DOMAIN = "hospital.org";
    const url = new URL(
      buildAuthorizationUrl(getOidcConfig(), {
        state: "s",
        nonce: "n",
        codeVerifier: "v",
      }),
    );
    expect(url.searchParams.get("hd")).toBe("hospital.org");
  });

  it("refuses to start when the server has no Google credentials", () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => getOidcConfig()).toThrow(OidcError);
    process.env.GOOGLE_CLIENT_ID = saved;
  });
});

describe("token exchange and id_token verification", () => {
  const identityClaims = (overrides: Record<string, unknown> = {}) => ({
    iss: issuer,
    aud: CLIENT_ID,
    sub: "google-sub-123",
    email: "resident@hospital.org",
    email_verified: true,
    name: "Test Resident",
    nonce: "expected-nonce",
    ...overrides,
  });

  it("exchanges the code with PKCE and verifies the signed identity", async () => {
    nextToken = { id_token: await signIdToken(identityClaims()) };
    const config = getOidcConfig();
    const tokens = await exchangeCodeForTokens(config, "auth-code", "verifier-123");

    expect(lastTokenRequest?.get("code")).toBe("auth-code");
    expect(lastTokenRequest?.get("code_verifier")).toBe("verifier-123");
    expect(lastTokenRequest?.get("grant_type")).toBe("authorization_code");
    expect(lastTokenRequest?.get("client_secret")).toBe(CLIENT_SECRET);

    const identity = await verifyIdToken(config, tokens.id_token!, "expected-nonce");
    expect(identity.subject).toBe("google-sub-123");
    expect(identity.email).toBe("resident@hospital.org");
    expect(identity.name).toBe("Test Resident");
  });

  it("rejects a token whose nonce does not match the one we sent", async () => {
    const idToken = await signIdToken(identityClaims({ nonce: "someone-elses-nonce" }));
    await expect(
      verifyIdToken(getOidcConfig(), idToken, "expected-nonce"),
    ).rejects.toMatchObject({ code: "id_token" });
  });

  it("rejects a token issued for a different client", async () => {
    const idToken = await signIdToken(identityClaims({ aud: "another-client" }));
    await expect(
      verifyIdToken(getOidcConfig(), idToken, "expected-nonce"),
    ).rejects.toMatchObject({ code: "id_token" });
  });

  it("rejects a token from a different issuer", async () => {
    const idToken = await signIdToken(identityClaims({ iss: "https://evil.example" }));
    await expect(
      verifyIdToken(getOidcConfig(), idToken, "expected-nonce"),
    ).rejects.toMatchObject({ code: "id_token" });
  });

  it("rejects a token signed by an unknown key", async () => {
    const rogue = await generateKeyPair("RS256");
    const idToken = await new SignJWT(identityClaims())
      .setProtectedHeader({ alg: "RS256", kid: "rogue-key" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(rogue.privateKey);
    await expect(
      verifyIdToken(getOidcConfig(), idToken, "expected-nonce"),
    ).rejects.toMatchObject({ code: "id_token" });
  });

  it("rejects an expired token", async () => {
    const idToken = await new SignJWT(identityClaims())
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    await expect(
      verifyIdToken(getOidcConfig(), idToken, "expected-nonce"),
    ).rejects.toMatchObject({ code: "id_token" });
  });

  it("rejects an unverified email address", async () => {
    const idToken = await signIdToken(identityClaims({ email_verified: false }));
    await expect(
      verifyIdToken(getOidcConfig(), idToken, "expected-nonce"),
    ).rejects.toMatchObject({ code: "email_unverified" });
  });

  it("rejects an account outside the configured workspace domain", async () => {
    process.env.GOOGLE_HOSTED_DOMAIN = "hospital.org";
    const idToken = await signIdToken(identityClaims({ hd: "elsewhere.org" }));
    await expect(
      verifyIdToken(getOidcConfig(), idToken, "expected-nonce"),
    ).rejects.toMatchObject({ code: "id_token" });
  });

  it("surfaces a failed token exchange", async () => {
    nextToken = { error: "invalid_grant" };
    await expect(
      exchangeCodeForTokens(getOidcConfig(), "bad-code", "verifier"),
    ).rejects.toMatchObject({ code: "token_exchange" });
  });
});

describe("full sign-in path", () => {
  it("turns a verified Google identity into an unconfigured application user", async () => {
    nextToken = {
      id_token: await signIdToken({
        iss: issuer,
        aud: CLIENT_ID,
        sub: "google-sub-new",
        email: "brand.new@hospital.org",
        email_verified: true,
        name: "Brand New",
        nonce: "n1",
      }),
    };
    const config = getOidcConfig();
    const tokens = await exchangeCodeForTokens(config, "code", "verifier");
    const identity = await verifyIdToken(config, tokens.id_token!, "n1");
    const result = await provisionUserFromIdentity(identity);

    expect(result.outcome).toBe("ok");
    const stored = await queryOne<UserRow>(
      "SELECT * FROM users WHERE lower(email) = 'brand.new@hospital.org'",
    );
    expect(stored?.auth_user_id).toBe("google-sub-new");
    expect(stored?.role).toBeNull();
    expect(stored?.last_login_at).toBeTruthy();
  });
});
