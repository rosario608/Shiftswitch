import { NextResponse } from "next/server";
import {
  buildAuthorizationUrl,
  getOidcConfig,
  OidcError,
  randomUrlSafe,
} from "@/server/auth/oidc";
import { setOAuthStateCookie } from "@/server/auth/session";
import { logger } from "@/server/observability/logger";

export const dynamic = "force-dynamic";

/** Kicks off Google sign-in: generates state/nonce/PKCE and redirects. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // The native app starts the same flow, but finishes on a custom scheme with
  // a one-time code instead of a session cookie.
  const nativeChallenge = url.searchParams.get("nativeChallenge") ?? undefined;
  // Started from an invitation link. The token is validated on the way back;
  // carrying it here just keeps it attached across the round trip to Google.
  const inviteToken = url.searchParams.get("invite") ?? undefined;
  const rawReturnTo = url.searchParams.get("returnTo") ?? "/";
  // Only same-origin relative paths may be used as a post-login destination.
  const returnTo = rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")
    ? rawReturnTo
    : "/";

  try {
    const config = getOidcConfig();
    const state = randomUrlSafe();
    const nonce = randomUrlSafe();
    const codeVerifier = randomUrlSafe(48);
    await setOAuthStateCookie({
      state,
      nonce,
      codeVerifier,
      returnTo,
      nativeChallenge,
      inviteToken,
    });
    return NextResponse.redirect(
      buildAuthorizationUrl(config, { state, nonce, codeVerifier }),
    );
  } catch (error) {
    if (error instanceof OidcError && error.code === "config") {
      logger.error("auth.not_configured", { message: error.message });
      return NextResponse.redirect(
        new URL("/login?error=not_configured", request.url),
      );
    }
    logger.error("auth.start_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.redirect(new URL("/login?error=unknown", request.url));
  }
}
