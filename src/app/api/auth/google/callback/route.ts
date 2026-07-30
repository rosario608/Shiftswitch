import { NextResponse } from "next/server";
import {
  exchangeCodeForTokens,
  getOidcConfig,
  OidcError,
  verifyIdToken,
} from "@/server/auth/oidc";
import { provisionUserFromIdentity } from "@/server/auth/provisioning";
import {
  clearOAuthStateCookie,
  createSession,
  readOAuthStateCookie,
  safeEqual,
} from "@/server/auth/session";
import { logger } from "@/server/observability/logger";

export const dynamic = "force-dynamic";

function loginRedirect(request: Request, params: Record<string, string>) {
  const url = new URL("/login", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    await clearOAuthStateCookie();
    logger.warn("auth.provider_error", { error: errorParam });
    return loginRedirect(request, { error: "cancelled" });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stored = await readOAuthStateCookie();
  await clearOAuthStateCookie();

  if (!code || !state || !stored || !safeEqual(state, stored.state)) {
    logger.warn("auth.state_mismatch", { hasCode: Boolean(code), hasState: Boolean(state) });
    return loginRedirect(request, { error: "state" });
  }

  try {
    const config = getOidcConfig();
    const tokens = await exchangeCodeForTokens(config, code, stored.codeVerifier);
    if (!tokens.id_token) {
      throw new OidcError("Google did not return an ID token", "token_exchange");
    }
    const identity = await verifyIdToken(config, tokens.id_token, stored.nonce);
    const result = await provisionUserFromIdentity(identity);
    if (result.outcome === "domain_rejected") {
      logger.warn("auth.domain_rejected", { email: identity.email });
      return loginRedirect(request, { error: "domain" });
    }
    if (!result.user.active) {
      return loginRedirect(request, { error: "deactivated" });
    }
    await createSession(result.user.id, {
      userAgent: request.headers.get("user-agent"),
      ip: request.headers.get("x-forwarded-for"),
    });
    logger.info("auth.login", { userId: result.user.id });
    return NextResponse.redirect(new URL(stored.returnTo || "/", request.url));
  } catch (error) {
    if (error instanceof OidcError) {
      logger.warn("auth.failed", { code: error.code, message: error.message });
      return loginRedirect(request, { error: error.code });
    }
    logger.error("auth.callback_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return loginRedirect(request, { error: "unknown" });
  }
}
