import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Google OpenID Connect (authorization code flow + PKCE).
 *
 * The identity we trust comes exclusively from a Google-signed `id_token`
 * verified against Google's JWKS — never from anything the browser hands us.
 */

export interface OidcConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  hostedDomain?: string;
}

export interface VerifiedIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
  hostedDomain: string | null;
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly code:
      | "config"
      | "state"
      | "token_exchange"
      | "id_token"
      | "email_unverified",
  ) {
    super(message);
    this.name = "OidcError";
  }
}

export function getOidcConfig(): OidcConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  if (!clientId || !clientSecret) {
    throw new OidcError(
      "Google sign-in is not configured on this server.",
      "config",
    );
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${appUrl.replace(/\/$/, "")}/api/auth/google/callback`,
    issuer: process.env.GOOGLE_ISSUER ?? "https://accounts.google.com",
    authorizationEndpoint:
      process.env.GOOGLE_AUTH_ENDPOINT ??
      "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint:
      process.env.GOOGLE_TOKEN_ENDPOINT ?? "https://oauth2.googleapis.com/token",
    jwksUri:
      process.env.GOOGLE_JWKS_URI ?? "https://www.googleapis.com/oauth2/v3/certs",
    hostedDomain: process.env.GOOGLE_HOSTED_DOMAIN || undefined,
  };
}

export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizationUrl(
  config: OidcConfig,
  params: { state: string; nonce: string; codeVerifier: string },
): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", pkceChallenge(params.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  if (config.hostedDomain) url.searchParams.set("hd", config.hostedDomain);
  return url.toString();
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForTokens(
  config: OidcConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || payload.error) {
    throw new OidcError(
      `Token exchange failed: ${payload.error_description ?? payload.error ?? response.status}`,
      "token_exchange",
    );
  }
  return payload;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(uri: string) {
  let jwks = jwksCache.get(uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, jwks);
  }
  return jwks;
}

export async function verifyIdToken(
  config: OidcConfig,
  idToken: string,
  expectedNonce: string,
): Promise<VerifiedIdentity> {
  let payload: JWTPayload & {
    email?: string;
    email_verified?: boolean | undefined;
    name?: string;
    picture?: string;
    hd?: string;
    nonce?: string;
  };
  try {
    const result = await jwtVerify(idToken, getJwks(config.jwksUri), {
      issuer: [config.issuer, "accounts.google.com", "https://accounts.google.com"],
      audience: config.clientId,
      clockTolerance: 60,
    });
    payload = result.payload;
  } catch (error) {
    throw new OidcError(
      `ID token verification failed: ${error instanceof Error ? error.message : "unknown"}`,
      "id_token",
    );
  }

  if (payload.nonce !== expectedNonce) {
    throw new OidcError("ID token nonce mismatch", "id_token");
  }
  if (!payload.sub || !payload.email) {
    throw new OidcError("ID token is missing sub/email", "id_token");
  }
  if (payload.email_verified !== true) {
    throw new OidcError(
      "Your Google account's email address is not verified.",
      "email_unverified",
    );
  }
  if (config.hostedDomain && payload.hd !== config.hostedDomain) {
    throw new OidcError(
      "This Google account is not part of the permitted workspace domain.",
      "id_token",
    );
  }

  return {
    subject: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    name: payload.name ?? payload.email,
    picture: payload.picture ?? null,
    hostedDomain: payload.hd ?? null,
  };
}
