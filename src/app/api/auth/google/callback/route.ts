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
import { createHandoffCode, nativeCallbackUrl } from "@/server/auth/native";
import { logger } from "@/server/observability/logger";

export const dynamic = "force-dynamic";

function nativeRedirect(params: { code?: string; error?: string }) {
  return NextResponse.redirect(nativeCallbackUrl(params), 303);
}

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
  const storedForError = await readOAuthStateCookie();
  if (errorParam) {
    await clearOAuthStateCookie();
    logger.warn("auth.provider_error", { error: errorParam });
    return storedForError?.nativeChallenge
      ? nativeRedirect({ error: "cancelled" })
      : loginRedirect(request, { error: "cancelled" });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stored = await readOAuthStateCookie();
  await clearOAuthStateCookie();

  if (!code || !state || !stored || !safeEqual(state, stored.state)) {
    logger.warn("auth.state_mismatch", { hasCode: Boolean(code), hasState: Boolean(state) });
    return stored?.nativeChallenge
      ? nativeRedirect({ error: "state" })
      : loginRedirect(request, { error: "state" });
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
      return stored.nativeChallenge
        ? nativeRedirect({ error: "domain" })
        : loginRedirect(request, { error: "domain" });
    }
    if (!result.user.active) {
      return stored.nativeChallenge
        ? nativeRedirect({ error: "deactivated" })
        : loginRedirect(request, { error: "deactivated" });
    }

    if (stored.nativeChallenge) {
      const handoff = await createHandoffCode(result.user.id, stored.nativeChallenge);
      logger.info("auth.login", { userId: result.user.id, client: "native" });
      return nativeRedirect({ code: handoff });
    }

    await createSession(result.user.id, {
      userAgent: request.headers.get("user-agent"),
      ip: request.headers.get("x-forwarded-for"),
    });
    logger.info("auth.login", { userId: result.user.id, client: "web" });
    return NextResponse.redirect(new URL(stored.returnTo || "/", request.url));
  } catch (error) {
    if (error instanceof OidcError) {
      logger.warn("auth.failed", { code: error.code, message: error.message });
      return stored.nativeChallenge
        ? nativeRedirect({ error: error.code })
        : loginRedirect(request, { error: error.code });
    }
    logger.error("auth.callback_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return stored.nativeChallenge
      ? nativeRedirect({ error: "unknown" })
      : loginRedirect(request, { error: "unknown" });
  }
}
